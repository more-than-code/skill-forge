import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(REPO_ROOT, 'inventory', 'hooks');
const GUARD = path.join(HOOKS, 'claude-code', 'git-guard.mjs');
const STALENESS = path.join(HOOKS, 'claude-code', 'staleness.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function tempDir(prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function gitRepo(dir, branch = 'dev') {
  await fs.mkdir(dir, { recursive: true });
  await exec('git', ['init', '-q', '-b', branch], { cwd: dir, env: GIT_ENV });
  await fs.writeFile(path.join(dir, 'a.txt'), 'a');
  await exec('git', ['add', '-A'], { cwd: dir, env: GIT_ENV });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: GIT_ENV });
  return dir;
}

// Runs a hook with `payload` on stdin; returns parsed JSON, or null for silence.
function fire(hook, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { env: { ...GIT_ENV, ...env } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}`));
      resolve(out.trim() ? JSON.parse(out) : null);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const bash = (command, cwd) => ({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } });

const decision = (r) => r?.hookSpecificOutput?.permissionDecision ?? null;

// An umbrella project folder holding the session repo, a child repo, and a sibling
// repo outside it.
async function layout() {
  const root = await tempDir('skf-guard-');
  const project = await gitRepo(path.join(root, 'project'));
  const child = await gitRepo(path.join(project, 'child'));
  const other = await gitRepo(path.join(root, 'other'));
  const onMain = await gitRepo(path.join(project, 'release'), 'main');
  return { project, child, other, onMain, env: { CLAUDE_PROJECT_DIR: project } };
}

test('git guard allows commits and pushes inside the session project, silently', async () => {
  const { project, child, env } = await layout();
  assert.equal(await fire(GUARD, bash('git commit -m "x"', project), env), null);
  assert.equal(await fire(GUARD, bash('git push origin dev', project), env), null);
  assert.equal(await fire(GUARD, bash('git commit -am "child repo"', child), env), null);
  // The standard heredoc commit message is an argument, not a control position.
  const heredoc = `git add -A && git commit -m "$(cat <<'EOF'\nfix: x; y && z\n\nCo-Authored-By: a <b>\nEOF\n)"`;
  assert.equal(await fire(GUARD, bash(heredoc, project), env), null);
  // Not git commit/push at all: silence, without spawning git.
  assert.equal(await fire(GUARD, bash('npm test', project), env), null);
  assert.equal(await fire(GUARD, bash('git status && git log -1', project), env), null);
});

test('git guard denies commits and pushes in a repo outside the project', async () => {
  const { project, other, env } = await layout();
  const r = await fire(GUARD, bash('git commit -m x', other), env);
  assert.equal(decision(r), 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /outside this session's project/);
  // The hook runs before the command, so it must follow cd and -C itself.
  assert.equal(decision(await fire(GUARD, bash(`cd ${other} && git commit -m x`, project), env)), 'deny');
  assert.equal(decision(await fire(GUARD, bash(`git -C ${other} push`, project), env)), 'deny');
  assert.equal(decision(await fire(GUARD, bash('cd ../other; git push origin dev', project), env)), 'deny');
});

test('git guard asks before main or master, and when it cannot resolve the command', async () => {
  const { project, onMain, env } = await layout();
  const ask = async (cmd, cwd = project) => decision(await fire(GUARD, bash(cmd, cwd), env));
  assert.equal(await ask('git commit -m x', onMain), 'ask');
  assert.equal(await ask('git push origin dev:main'), 'ask');
  assert.equal(await ask('git push origin main'), 'ask');
  assert.equal(await ask('git push', onMain), 'ask');
  assert.equal(await ask('git push --all origin'), 'ask');
  assert.equal(await ask('git checkout main && git merge --ff-only dev && git push'), 'ask');
  assert.equal(await ask('bash -c "git commit -m x"'), 'ask');
  assert.equal(await ask('eval "git push"'), 'ask');
  assert.equal(await ask('cd "$(mktemp -d)" && git commit -m x'), 'ask');
  assert.equal(await ask('(cd sub && git commit -m x)'), 'ask');
  assert.equal(await ask('git --git-dir=/elsewhere/.git commit -m x'), 'ask');
  // dev → dev is the ordinary flow.
  assert.equal(await ask('git push origin dev:dev'), null);
});

test('git guard never echoes the command it inspected', async () => {
  const { project, other, env } = await layout();
  const r = await fire(GUARD, bash(`git -C ${other} commit -m "SECRET-TOKEN-123"`, project), env);
  assert.doesNotMatch(JSON.stringify(r), /SECRET-TOKEN-123/);
});

// --- staleness ------------------------------------------------------------------------------
async function fakeSkf(exitCode, output) {
  const bin = await tempDir('skf-bin-');
  const script = `#!/bin/sh\necho '${output}'\nexit ${exitCode}\n`;
  await fs.writeFile(path.join(bin, 'skf'), script, { mode: 0o755 });
  return bin;
}

const start = (cwd) => ({ hook_event_name: 'SessionStart', cwd, source: 'startup' });

test('staleness hook is silent with no profile, no skf, or an in-sync profile', async () => {
  const plain = await tempDir('skf-plain-');
  const stale = await fakeSkf(1, '! skill-forge.lock.json is stale');
  assert.equal(await fire(STALENESS, start(plain), { PATH: `${stale}:${process.env.PATH}` }), null);

  const consumer = await tempDir('skf-consumer-');
  await fs.writeFile(path.join(consumer, 'skill-forge.json'), '{}');
  const emptyBin = await tempDir('skf-nobin-');
  assert.equal(await fire(STALENESS, start(consumer), { PATH: emptyBin }), null);

  const fresh = await fakeSkf(0, 'Project profile is in sync.');
  assert.equal(await fire(STALENESS, start(consumer), { PATH: `${fresh}:${process.env.PATH}` }), null);
});

test('staleness hook reports a stale profile once, for the model and the user', async () => {
  const consumer = await tempDir('skf-consumer-');
  await fs.writeFile(path.join(consumer, 'skill-forge.json'), '{}');
  const stale = await fakeSkf(1, '! product-parity: locked 0.10.0, registry 0.11.0');
  const r = await fire(STALENESS, start(consumer), { PATH: `${stale}:${process.env.PATH}` });
  assert.equal(r.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(r.hookSpecificOutput.additionalContext, /product-parity: locked 0\.10\.0/);
  assert.match(r.hookSpecificOutput.additionalContext, /skill-forge-project/);
  assert.match(r.systemMessage, /stale or broken/);
});

// --- review round: bypasses that must not pass, and ordinary commands that must stay silent ---
test('git guard closes the reviewed bypasses', async () => {
  const { project, other, env } = await layout();
  const answer = async (cmd) => decision(await fire(GUARD, bash(cmd, project), env));
  const denied = [
    "g''it -C ../other commit -m x",
    'git -C ../other \\\n  commit -m x',
    "git add . # don't forget\ngit -C ../other push",
    'cat <<< x\ngit -C ../other commit -m y',
    'cd -P ../other && git commit -m x',
    "git commit -m $'x\\'' ; git -C ../other push",
  ];
  for (const cmd of denied) assert.equal(await answer(cmd), 'deny', cmd);
  const asked = [
    `GIT_DIR=${other}/.git git commit -m x`,
    `export GIT_DIR=${other}/.git; git commit -m x`,
    `env GIT_DIR=${other}/.git git commit -m x`,
    'sudo git commit -m x',
    "find . -exec git commit -m x \;",
    "bash <<'EOF'\ncd ../other && git commit -m x\nEOF",
    'git init ../n && git -C ../n commit --allow-empty -m x',
    "git push origin 'refs/heads/*:refs/heads/*'",
    'git push origin +main',
    'git push origin refs/heads/main',
    'git push origin dev:refs/heads/master',
    'git push --force origin main',
    'git push origin :main',
    'git -c core.worktree=/elsewhere commit -m x',
    'cd ../oth* && git commit -m x',
  ];
  for (const cmd of asked) assert.equal(await answer(cmd), 'ask', cmd);
});

test('git guard stays silent on ordinary commands', async () => {
  const { project, env } = await layout();
  const silent = [
    'git commit --amend --no-edit',
    'git -c user.name=x commit -m x',
    'git push -u origin feature/x',
    'git push origin HEAD',
    'git commit -m "fix (scope): y; z | w" -m "don\'t"',
    'git commit -F - <<EOF\nfix: 1) a\nEOF',
    'grep -rn "git commit" docs',
    'rg commit inventory/hooks/claude-code/git-guard.mjs',
    'gh pr create --body "then git push"',
    'if git diff --quiet; then echo ok; else git commit -am x; fi',
    'cd "$CLAUDE_PROJECT_DIR" && git commit -m x',
    `cd ${project} && git status && git commit -m x 2>&1 | tail -3`,
  ];
  for (const cmd of silent) assert.equal(decision(await fire(GUARD, bash(cmd, project), env)), null, cmd);
});

test('git guard treats a linked worktree of the project repo as the project', async () => {
  const { project, env } = await layout();
  const wt = path.join(path.dirname(project), 'wt-feature');
  await exec('git', ['-C', project, 'worktree', 'add', '-q', '-b', 'feature', wt], { env: GIT_ENV });
  assert.equal(decision(await fire(GUARD, bash(`git -C ${wt} commit -m x`, project), env)), null);
});

test('git guard fails open and quietly on bad input, and never echoes on ask', async () => {
  const { project, env } = await layout();
  for (const payload of [{}, { tool_input: {} }, { tool_input: { command: 42 } }, { cwd: 7, tool_input: { command: 'git commit -m x' } }]) {
    const r = await fire(GUARD, payload, env);
    assert.ok(r === null || decision(r), JSON.stringify(payload));
  }
  const r = await fire(GUARD, bash('./deploy-key-abc.sh && sudo git commit -m "SECRET-456"', project), env);
  assert.equal(decision(r), 'ask');
  assert.doesNotMatch(JSON.stringify(r), /SECRET-456|deploy-key-abc/);
});

test('staleness hook stays silent when skf hangs, and reports a failing check', async () => {
  const consumer = await tempDir('skf-consumer-');
  await fs.writeFile(path.join(consumer, 'skill-forge.json'), '{}');
  const bin = await tempDir('skf-bin-');
  await fs.writeFile(path.join(bin, 'skf'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  assert.equal(await fire(STALENESS, start(consumer), { PATH: `${bin}:${process.env.PATH}` }), null);
  assert.ok(Date.now() - t0 < 9000, 'timed out within budget');

  const broken = await fakeSkf(1, '');
  const r = await fire(STALENESS, start(consumer), { PATH: `${broken}:${process.env.PATH}` });
  assert.match(r.systemMessage, /failed/);
});
