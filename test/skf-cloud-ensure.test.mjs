import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// skf-cloud.mjs ensure: a repo's declared skills on any machine (docs/REPO-SKILL-INSTALL.md).
// Skills come from a local mirror laid out as <base>/<ref>/<path>, like raw.githubusercontent.com.

const run = promisify(execFile);
delete process.env.CLAUDE_CODE_REMOTE;
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'cli.js');
const CLOUD = path.join(REPO, 'bin', 'skf-cloud.mjs');
const REF = 'b'.repeat(40);
const OLD_REF = 'c'.repeat(40);

const tempDirs = [];
async function tempDir(prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});
async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
}
const read = (file) => fs.readFile(file, 'utf8');
const exists = (file) => fs.lstat(file).then(() => true, () => false);
const skillText = (name, version) => `---\nname: ${name}\ndescription: ${name}.\n---\n${name} ${version}.\n`;

/** A locked fixture registry at each ref: { [ref]: { name: version } }. */
async function mirror(refs = { [REF]: { alpha: '0.2.1', beta: '0.1.0', 'claude-project-steward': '0.3.0' } }) {
  const base = await tempDir('skf-ensure-base-');
  for (const [ref, versions] of Object.entries(refs)) {
    const root = await tempDir('skf-ensure-reg-');
    const files = {};
    for (const [name, version] of Object.entries(versions)) files[`inventory/skills/${name}/SKILL.md`] = skillText(name, version);
    await writeFiles(root, files);
    const registry = {
      name: 'skill-forge-test', version: '0.0.0', schemaVersion: 1,
      skills: Object.entries(versions).map(([name, version]) => ({ type: 'skill', name, version, scope: 'custom', path: `inventory/skills/${name}`, installable: true, tags: [] })),
      managedAgents: [], managedSubagents: [], managedHooks: [], instructionVariants: []
    };
    await fs.writeFile(path.join(root, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
    await run('node', [CLI, 'lock'], { cwd: root, env: { ...process.env, SKILL_FORGE_ROOT: root } });
    await writeFiles(root, { 'bin/skf-cloud.mjs': await fs.readFile(CLOUD) });
    await fs.symlink(root, path.join(base, ref));
  }
  return base;
}

/** A git checkout with a skill-forge.json, inside an umbrella folder; a separate $HOME. */
async function checkout(dependencies, { lock = REF } = {}) {
  const umbrella = await tempDir('skf-ensure-umbrella-');
  const repo = path.join(umbrella, 'app');
  await fs.mkdir(repo, { recursive: true });
  await run('git', ['init', '-q'], { cwd: repo });
  await writeFiles(repo, { 'skill-forge.json': JSON.stringify({ schemaVersion: 2, skills: { dependencies } }) });
  if (lock) await writeFiles(repo, { 'skill-forge.lock.json': JSON.stringify({ schemaVersion: 1, registry: { commit: lock } }) });
  const homeDir = await tempDir('skf-ensure-home-');
  return { umbrella, repo, homeDir };
}

/** Runs a command with stdin closed after `input` (a hook payload), so nothing waits on an open pipe. */
function spawnRun(command, args, { cwd, env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function ensureEnv(fx, base, extraEnv) {
  const env = { ...process.env, HOME: fx.homeDir, USERPROFILE: fx.homeDir, SKF_BASE: base, SKF_DEFAULT_SKILLS: '0', ...extraEnv };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

async function ensure(fx, base, args = [], extraEnv = {}, input = undefined) {
  const payload = input ?? (args.includes('--hook') ? JSON.stringify({ cwd: fx.repo }) : '');
  const { code, stdout, stderr } = await spawnRun('node', [CLOUD, 'ensure', ...args], { cwd: fx.repo, env: ensureEnv(fx, base, extraEnv), input: payload });
  assert.doesNotMatch(stderr, /at .*skf-cloud\.mjs/, 'no stack trace');
  return { code, stdout };
}

/** A skill folder as skf-cloud records it: files plus a state.json at that .claude root. */
async function installedCopy(claudeRoot, name, version) {
  const dest = path.join(claudeRoot, 'skills', name, 'SKILL.md');
  await writeFiles(claudeRoot, { [`skills/${name}/SKILL.md`]: skillText(name, version) });
  const statePath = path.join(claudeRoot, 'skill-forge', 'state.json');
  const state = JSON.parse(await read(statePath).catch(() => '{"files":{},"versions":{}}'));
  state.files[dest] = `sha256-${crypto.createHash('sha256').update(skillText(name, version)).digest('base64')}`;
  state.versions[`skill:${name}`] = version;
  await writeFiles(claudeRoot, { 'skill-forge/state.json': JSON.stringify(state) });
}

const gitStatus = async (repo) => (await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo })).stdout;

test('ensure installs only the missing names into .claude/skills, ignored, and is silent the second time', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0', beta: '^0.1.0' });
  await installedCopy(path.join(fx.homeDir, '.claude'), 'beta', '0.1.0');
  const statusBefore = await gitStatus(fx.repo);

  const first = await ensure(fx, base);
  assert.equal(first.code, 0, first.stdout);
  assert.match(first.stdout, /installed alpha into \.claude\/skills \(bbbbbbbbbbbb\)/);
  assert.equal(await read(path.join(fx.repo, '.claude/skills/alpha/SKILL.md')), skillText('alpha', '0.2.1'));
  assert.equal(await exists(path.join(fx.repo, '.claude/skills/beta')), false, 'beta is found at user level: no second copy');
  assert.equal(await gitStatus(fx.repo), statusBefore, 'nothing new shows in git status');
  assert.match(await read(path.join(fx.repo, '.git/info/exclude')), /# >>> skill-forge ensure >>>\n\/\.claude\/skill-forge\/\n\/\.claude\/skills\/alpha\/\n# <<< skill-forge ensure <<</);

  const second = await ensure(fx, base);
  assert.deepEqual(second, { code: 0, stdout: '' });
});

test('everything present at user level in range: ensure writes nothing and prints nothing', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await installedCopy(path.join(fx.homeDir, '.claude'), 'alpha', '0.2.5');
  assert.deepEqual(await ensure(fx, base), { code: 0, stdout: '' });
  assert.equal(await exists(path.join(fx.repo, '.claude')), false);
});

test('discovery labels repo, parent and user copies, names the winner and reports duplicates', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0', beta: '^0.1.0' });
  await installedCopy(path.join(fx.repo, '.claude'), 'alpha', '0.2.0');
  await installedCopy(path.join(fx.homeDir, '.claude'), 'alpha', '0.2.3');
  await writeFiles(fx.umbrella, { '.claude/skills/beta/SKILL.md': skillText('beta', 'x') });

  const { code, stdout } = await ensure(fx, base, ['--check', '--json']);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.version, 1);
  const alpha = report.skills.find((entry) => entry.name === 'alpha');
  assert.deepEqual(alpha.copies.map((copy) => [copy.level, copy.version]), [['repo', '0.2.0'], ['user', '0.2.3']]);
  assert.equal(alpha.wins.level, 'user', 'personal skills outrank project ones');
  assert.equal(alpha.duplicate, true);
  const beta = report.skills.find((entry) => entry.name === 'beta');
  assert.equal(beta.wins.level, 'parent');
  assert.equal(beta.status, 'unknown', 'a hand-installed copy counts as present');

  const text = await ensure(fx, base, ['--check']);
  assert.match(text.stdout, /copies: .*\.claude\/skills \(0\.2\.0\), ~\/\.claude\/skills \(0\.2\.3\); wins: ~\/\.claude\/skills/);
  const plain = await ensure(fx, base);
  assert.match(plain.stdout, /^skill-forge: beta: found only in .*; it loads only in sessions started in .*, so not in this repo/, 'a parent-only copy is said, not duplicated');
  assert.equal(plain.code, 0);
  assert.equal(await exists(path.join(fx.repo, '.claude/skills/beta')), false);
});

test('an older winning copy gets a warning naming copy, version and range; a newer one is kept', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0', beta: '^0.1.0' });
  await installedCopy(path.join(fx.homeDir, '.claude'), 'alpha', '0.1.9');
  await installedCopy(path.join(fx.homeDir, '.claude'), 'beta', '0.3.0');

  const result = await ensure(fx, base);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /alpha: ~\/\.claude\/skills \(0\.1\.9\) is older than declared \^0\.2\.0; it wins over any repo copy/);
  assert.doesNotMatch(result.stdout, /beta/, 'a newer copy is respected, not reported as a problem');
  assert.equal(await exists(path.join(fx.repo, '.claude/skills')), false, 'no second copy');

  const check = await ensure(fx, base, ['--check']);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /NEWER beta: .* newer than declared \^0\.1\.0; kept/);
});

test('--upgrade upgrades an older copy in place when the pinned version fits, and refuses a hand-installed one', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  const user = path.join(fx.homeDir, '.claude');
  await installedCopy(user, 'alpha', '0.1.9');
  const upgraded = await ensure(fx, base, ['--upgrade', 'alpha']);
  assert.equal(upgraded.code, 0, upgraded.stdout);
  assert.match(upgraded.stdout, /upgraded alpha in ~\/\.claude\/skills/);
  assert.equal(await read(path.join(user, 'skills/alpha/SKILL.md')), skillText('alpha', '0.2.1'));
  assert.equal(JSON.parse(await read(path.join(user, 'skill-forge/state.json'))).versions['skill:alpha'], '0.2.1');
  assert.equal(await exists(path.join(fx.repo, '.claude')), false);

  // A recorded copy edited since install is kept, and the upgrade says so.
  const edited = await checkout({ alpha: '^0.2.0' });
  await installedCopy(path.join(edited.homeDir, '.claude'), 'alpha', '0.1.9');
  await fs.writeFile(path.join(edited.homeDir, '.claude/skills/alpha/SKILL.md'), 'my notes\n');
  const keptResult = await ensure(edited, base, ['--upgrade', 'alpha']);
  assert.equal(keptResult.code, 1);
  assert.match(keptResult.stdout, /alpha not upgraded \(a file in it was edited since install, so it was kept\)/);
  assert.equal(await read(path.join(edited.homeDir, '.claude/skills/alpha/SKILL.md')), 'my notes\n');

  const other = await checkout({ alpha: '^0.2.0' });
  await writeFiles(path.join(other.homeDir, '.claude'), { 'skills/alpha/SKILL.md': 'mine\n' });
  const refused = await ensure(other, base, ['--upgrade', 'alpha']);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /was not installed by Skill Forge's installer/);
  assert.equal(await read(path.join(other.homeDir, '.claude/skills/alpha/SKILL.md')), 'mine\n');
});

test('--upgrade of a shared parent copy refuses a version outside the parent folder\'s own range', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await installedCopy(path.join(fx.umbrella, '.claude'), 'alpha', '0.1.0');
  await writeFiles(fx.umbrella, { 'skill-forge.json': JSON.stringify({ schemaVersion: 2, skills: { dependencies: { alpha: '^0.1.0' } } }) });
  const result = await ensure(fx, base, ['--upgrade', 'alpha']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /not upgraded: 0\.2\.1 is outside .*skill-forge\.json \^0\.1\.0/);
});

test('a repo copy deleted on disk is installed again; a third-party folder and an edited file are kept', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0', beta: '^0.1.0' });
  await writeFiles(fx.repo, { '.claude/skills/third-party/SKILL.md': 'theirs\n' });
  await ensure(fx, base);
  await fs.writeFile(path.join(fx.repo, '.claude/skills/beta/SKILL.md'), 'edited\n');
  await fs.rm(path.join(fx.repo, '.claude/skills/alpha'), { recursive: true });

  const again = await ensure(fx, base);
  assert.match(again.stdout, /installed alpha/);
  assert.equal(await read(path.join(fx.repo, '.claude/skills/alpha/SKILL.md')), skillText('alpha', '0.2.1'));
  assert.equal(await read(path.join(fx.repo, '.claude/skills/beta/SKILL.md')), 'edited\n');
  assert.equal(await read(path.join(fx.repo, '.claude/skills/third-party/SKILL.md')), 'theirs\n');
});

test('a repo whose .claude/skills is the skf sync link is left to skf sync', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await fs.mkdir(path.join(fx.repo, '.agents/skills'), { recursive: true });
  await fs.mkdir(path.join(fx.repo, '.claude'));
  await fs.symlink('../.agents/skills', path.join(fx.repo, '.claude/skills'));
  const result = await ensure(fx, base);
  assert.match(result.stdout, /skf sync manages its skills/);
  assert.deepEqual(await fs.readdir(path.join(fx.repo, '.agents/skills')), []);
});

test('the pin is --ref, else the lock commit once it is on main; without either nothing is fetched', async () => {
  const base = await mirror({ [REF]: { alpha: '0.2.1' }, [OLD_REF]: { alpha: '0.2.0' } });
  const fx = await checkout({ alpha: '^0.2.0' }, { lock: OLD_REF });
  await ensure(fx, base, ['--ref', REF]);
  assert.equal(await read(path.join(fx.repo, '.claude/skills/alpha/SKILL.md')), skillText('alpha', '0.2.1'), '--ref (the hook\'s pin) wins over the repo-controlled lock');
  const locked = await checkout({ alpha: '^0.2.0' }, { lock: OLD_REF });
  await ensure(locked, base);
  assert.equal(await read(path.join(locked.repo, '.claude/skills/alpha/SKILL.md')), skillText('alpha', '0.2.0'), 'the lock commit, from a local mirror');

  // From the public registry the lock commit must be in main's history; unverifiable means unused.
  const unverified = await checkout({ alpha: '^0.2.0' }, { lock: OLD_REF });
  const refused = await ensure(unverified, undefined, [], { SKF_GITHUB_API: 'https://127.0.0.1:9' });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /the lock's registry commit is not used: could not check that cccccccccccc is on more-than-code\/skill-forge main/);
  assert.equal(await exists(path.join(unverified.repo, '.claude/skills')), false);

  const bare = await checkout({ alpha: '^0.2.0' }, { lock: null });
  const none = await ensure(bare, base);
  assert.equal(none.code, 1);
  assert.match(none.stdout, /no pinned commit \(give --ref/);
  await ensure(bare, base, ['--ref', REF]);
  assert.equal(await read(path.join(bare.repo, '.claude/skills/alpha/SKILL.md')), skillText('alpha', '0.2.1'));
});

test('the steward comes along unless a copy exists or SKF_DEFAULT_SKILLS=0', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  const result = await ensure(fx, base, [], { SKF_DEFAULT_SKILLS: undefined });
  assert.match(result.stdout, /installed alpha, claude-project-steward/);
  const off = await checkout({ alpha: '^0.2.0' });
  await ensure(off, base);
  assert.equal(await exists(path.join(off.repo, '.claude/skills/claude-project-steward')), false);
});

test('--hook: silent in cloud sessions, hook JSON with reloadSkills after an install, exit 0 when offline', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  assert.deepEqual(await ensure(fx, base, ['--hook'], { CLAUDE_CODE_REMOTE: 'true' }), { code: 0, stdout: '' });
  assert.equal(await exists(path.join(fx.repo, '.claude')), false);

  const result = await ensure(fx, base, ['--hook']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.systemMessage, /installed alpha/);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(payload.hookSpecificOutput.reloadSkills, true);

  assert.equal(payload.hookSpecificOutput.additionalContext, undefined, 'nothing goes into the model context');

  const offline = await checkout({ alpha: '^0.2.0' });
  const failed = await ensure(offline, 'https://127.0.0.1:9', ['--hook', '--ref', REF]);
  assert.equal(failed.code, 0);
  assert.match(JSON.parse(failed.stdout).systemMessage, /could not check the declared skills/);

  // The payload's cwd is the start folder: a session started in a subfolder still finds the repo.
  const sub = await checkout({ alpha: '^0.2.0' });
  await fs.mkdir(path.join(sub.repo, 'src/deep'), { recursive: true });
  const fromSub = await ensure(sub, base, ['--hook'], {}, JSON.stringify({ cwd: path.join(sub.repo, 'src/deep') }));
  assert.match(JSON.parse(fromSub.stdout).systemMessage, /installed alpha/);
  assert.equal(await exists(path.join(sub.repo, '.claude/skills/alpha/SKILL.md')), true);
});

test('--write-hook merges the pinned entry into .claude/settings.json, idempotently, and prints the AGENTS.md line', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await writeFiles(fx.repo, { '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }) });
  const first = await ensure(fx, base, ['--write-hook', '--ref', REF]);
  assert.equal(first.code, 0, first.stdout);
  assert.match(first.stdout, /use the `claude-project-steward` skill/);
  const written = await read(path.join(fx.repo, '.claude/settings.json'));
  await ensure(fx, base, ['--write-hook', '--ref', REF]);
  assert.equal(await read(path.join(fx.repo, '.claude/settings.json')), written, 'idempotent');
  const settings = JSON.parse(written);
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] }, 'other keys kept');
  assert.equal(settings.hooks.SessionStart.length, 2, 'the other hook is kept');
  const command = settings.hooks.SessionStart[1].hooks[0].command;
  assert.match(command, new RegExp(`skf-cloud-${REF}\\.mjs`));
  assert.match(command, /^node -e '[^'"$]+' -- --hook$/, 'one pair of single quotes, no quotes or $ inside');
  const hash = crypto.createHash('sha256').update(await fs.readFile(CLOUD)).digest('hex');
  assert.ok(command.includes(hash), 'the hook pins the script\'s sha256');
});

test('the bootstrap runs a cached script only when its hash matches, and warns once when it cannot fetch', { skip: !(await run('bash', ['--version']).then(() => true, () => false)) && 'bash is not installed here' }, async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await ensure(fx, base, ['--write-hook', '--ref', REF]);
  const command = JSON.parse(await read(path.join(fx.repo, '.claude/settings.json'))).hooks.SessionStart[0].hooks[0].command;
  const env = { ...ensureEnv(fx, base, {}), CLAUDE_PROJECT_DIR: fx.repo, SKF_GITHUB_API: 'https://127.0.0.1:9' };
  const runHook = () => spawnRun('bash', ['-c', command], { cwd: fx.repo, env, input: JSON.stringify({ cwd: fx.repo }) });

  const offline = await runHook();
  assert.equal(offline.code, 0);
  assert.match(JSON.parse(offline.stdout).systemMessage, /could not check the declared skills/);

  const cache = path.join(fx.homeDir, '.claude/skill-forge/cache', `skf-cloud-${REF}.mjs`);
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, 'console.log(`planted`)\n');
  const planted = await runHook();
  assert.doesNotMatch(planted.stdout, /planted/, 'a cached file with another hash never runs');
  assert.match(JSON.parse(planted.stdout).systemMessage, /could not check the declared skills/);

  await fs.copyFile(CLOUD, cache);
  const { stdout } = await runHook();
  assert.match(JSON.parse(stdout).systemMessage, /installed alpha/);
  assert.equal((await runHook()).stdout, '', 'quiet once everything is there');
  assert.equal(await gitStatus(fx.repo), '?? .claude/settings.json\n?? skill-forge.json\n?? skill-forge.lock.json\n', 'only the hook file is new besides the fixture');

  // The AGENTS.md line's command (no --hook) passes extra arguments through.
  const line = command.replace(/ -- --hook$/, ' -- --check --json');
  const check = await spawnRun('bash', ['-c', line], { cwd: fx.repo, env });
  assert.equal(JSON.parse(check.stdout).skills[0].status, 'ok');
});

test('the bootstrap text runs unchanged under PowerShell', { skip: !(await run('pwsh', ['-v']).then(() => true, () => false)) && 'pwsh is not installed here' }, async () => {
  const fx = await checkout({ alpha: '^0.2.0' });
  await ensure(fx, await mirror(), ['--write-hook', '--ref', REF]);
  const command = JSON.parse(await read(path.join(fx.repo, '.claude/settings.json'))).hooks.SessionStart[0].hooks[0].command;
  const { stdout } = await run('pwsh', ['-NoProfile', '-Command', command], { cwd: fx.repo, env: { ...process.env, HOME: fx.homeDir, USERPROFILE: fx.homeDir, SKF_GITHUB_API: 'https://127.0.0.1:9', CLAUDE_PROJECT_DIR: fx.repo } });
  assert.match(JSON.parse(stdout).systemMessage, /could not check the declared skills/);
});

test('a tracked .claude/skills/<name> is never written', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await writeFiles(fx.repo, { '.claude/skills/alpha/SKILL.md': 'committed\n' });
  await run('git', ['add', '-f', '.claude/skills/alpha/SKILL.md'], { cwd: fx.repo });
  await fs.rm(path.join(fx.repo, '.claude/skills/alpha/SKILL.md'));
  const result = await ensure(fx, base);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /alpha is tracked in \.claude\/skills; not written/);
  assert.equal(await exists(path.join(fx.repo, '.claude/skills/alpha/SKILL.md')), false);
});

test('an installed copy with a file missing is incomplete and repaired; a skill the pin cannot give keeps its copy', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await ensure(fx, base);
  const statePath = path.join(fx.repo, '.claude/skill-forge/state.json');
  const state = JSON.parse(await read(statePath));
  // Record a second file of alpha that is gone from disk.
  const extra = path.join(fx.repo, '.claude/skills/alpha/EXTRA.md');
  state.files[extra] = 'sha256-gone';
  await fs.writeFile(statePath, JSON.stringify(state));
  const check = await ensure(fx, base, ['--check', '--json']);
  assert.equal(check.code, 1);
  assert.equal(JSON.parse(check.stdout).skills[0].status, 'incomplete');
  const repaired = await ensure(fx, base);
  assert.match(repaired.stdout, /installed alpha/);
  assert.equal(JSON.parse(await read(statePath)).files[extra], undefined, 'the stale record is dropped');

  // The declared range moves past what the pin has: the copy stays, and the skip is reported.
  const moved = await checkout({ alpha: '^0.2.0' });
  await ensure(moved, base);
  const movedState = path.join(moved.repo, '.claude/skill-forge/state.json');
  const record = JSON.parse(await read(movedState));
  record.files[path.join(moved.repo, '.claude/skills/alpha/EXTRA.md')] = 'sha256-gone';
  await fs.writeFile(movedState, JSON.stringify(record));
  await writeFiles(moved.repo, { 'skill-forge.json': JSON.stringify({ schemaVersion: 2, skills: { dependencies: { alpha: '^0.3.0' } } }) });
  const skipped = await ensure(moved, base);
  assert.match(skipped.stdout, /older than declared \^0\.3\.0|skipped alpha/);
  assert.equal(await read(path.join(moved.repo, '.claude/skills/alpha/SKILL.md')), skillText('alpha', '0.2.1'));
});

test('the steward is not duplicated when a user copy exists', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await installedCopy(path.join(fx.homeDir, '.claude'), 'alpha', '0.2.1');
  await installedCopy(path.join(fx.homeDir, '.claude'), 'claude-project-steward', '0.3.0');
  assert.deepEqual(await ensure(fx, base, [], { SKF_DEFAULT_SKILLS: undefined }), { code: 0, stdout: '' });
  assert.equal(await exists(path.join(fx.repo, '.claude')), false);
});

test('a newer-only copy exits 0; warnings are capped at three', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await installedCopy(path.join(fx.homeDir, '.claude'), 'alpha', '0.9.0');
  assert.deepEqual(await ensure(fx, base), { code: 0, stdout: '' });
  const check = await ensure(fx, base, ['--check']);
  assert.equal(check.code, 0);
  assert.match(check.stdout, /NEWER alpha/);

  const many = await checkout({ a1: '^1.0.0', a2: '^1.0.0', a3: '^1.0.0', a4: '^1.0.0', a5: '^1.0.0' });
  for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) await installedCopy(path.join(many.homeDir, '.claude'), name, '0.1.0');
  const result = await ensure(many, base);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[3], /and 2 more warning\(s\)/);
});

test('--upgrade of a user copy keeps the rest of the environment\'s state.json', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  const user = path.join(fx.homeDir, '.claude');
  await installedCopy(user, 'alpha', '0.1.9');
  const statePath = path.join(user, 'skill-forge/state.json');
  const env = JSON.parse(await read(statePath));
  Object.assign(env, { ref: 'e'.repeat(40), base: 'https://example.invalid', failed: ['x (y)'], skillSources: { alpha: 'env' }, rules: 'cloud' });
  await fs.writeFile(statePath, JSON.stringify(env));
  const result = await ensure(fx, base, ['--upgrade', 'alpha', '--ref', REF]);
  assert.equal(result.code, 0, result.stdout);
  const after = JSON.parse(await read(statePath));
  for (const key of ['ref', 'base', 'failed', 'rules']) assert.deepEqual(after[key], env[key], key);
  assert.equal(after.skillSources.alpha, 'env', 'an environment skill stays the environment\'s');
  assert.equal(after.versions['skill:alpha'], '0.2.1');

  const none = await checkout({ alpha: '^0.2.0' }, { lock: null });
  await installedCopy(path.join(none.homeDir, '.claude'), 'alpha', '0.1.9');
  assert.match((await ensure(none, base, ['--upgrade', 'alpha'])).stdout, /no pinned commit/);
  assert.match((await ensure(none, base, ['--upgrade', 'nope', '--ref', REF])).stdout, /nope is not a declared skill found on this machine/);
});

test('info/exclude: user lines and CRLF kept, one block across runs, nothing added for a path already ignored', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0', beta: '^0.1.0' });
  const exclude = path.join(fx.repo, '.git/info/exclude');
  await fs.writeFile(exclude, '# mine\r\n*.log\r\n');
  await writeFiles(fx.repo, { '.gitignore': '/.claude/skills/beta/\n' });
  await ensure(fx, base);
  await fs.rm(path.join(fx.repo, '.claude/skills/alpha'), { recursive: true });
  await ensure(fx, base);
  const text = await read(exclude);
  assert.equal(text, '# mine\r\n*.log\r\n\r\n# >>> skill-forge ensure >>>\r\n/.claude/skill-forge/\r\n/.claude/skills/alpha/\r\n# <<< skill-forge ensure <<<\r\n');
});

test('--write-hook: creates the file, re-pins in place, refuses bad settings, and doctor reads what it wrote', async () => {
  const base = await mirror({ [REF]: { alpha: '0.2.1' }, [OLD_REF]: { alpha: '0.2.0' } });
  const fx = await checkout({ alpha: '^0.2.0' });
  await ensure(fx, base, ['--write-hook', '--ref', OLD_REF]);
  await ensure(fx, base, ['--write-hook', '--ref', REF]);
  const settings = JSON.parse(await read(path.join(fx.repo, '.claude/settings.json')));
  assert.equal(settings.hooks.SessionStart.length, 1, 're-pinned, not added twice');
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, new RegExp(REF));

  // A bundled entry keeps its other hook.
  settings.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'echo other' });
  await fs.writeFile(path.join(fx.repo, '.claude/settings.json'), JSON.stringify(settings));
  await ensure(fx, base, ['--write-hook', '--ref', REF]);
  const merged = JSON.parse(await read(path.join(fx.repo, '.claude/settings.json'))).hooks.SessionStart;
  assert.deepEqual(merged.map((entry) => entry.hooks.length), [1, 1]);
  assert.equal(merged[0].hooks[0].command, 'echo other');

  await fs.writeFile(path.join(fx.repo, '.claude/settings.json'), '{ not json');
  const bad = await ensure(fx, base, ['--write-hook', '--ref', REF]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /is not a JSON object/);
  assert.equal((await ensure(fx, base, ['--write-hook'])).code, 2, 'no --ref and no environment install');

  // Doctor's pin reader on real output, with the environment at another commit.
  const reposDir = await tempDir('skf-ensure-repos-');
  const repo = path.join(reposDir, 'app');
  await writeFiles(repo, { '.git/HEAD': 'x\n', 'AGENTS.md': '# app\n', 'CLAUDE.md': '@AGENTS.md\n', 'skill-forge.json': '{"schemaVersion":2,"skills":{"dependencies":{}}}' });
  const printed = await ensure({ ...fx, repo }, base, ['--write-hook', '--ref', OLD_REF, '--repo', repo]);
  const line = printed.stdout.split('\n').find((text) => text.startsWith('Skills: '));
  await fs.writeFile(path.join(repo, 'AGENTS.md'), `# app\n\n${line}\n`);
  await writeFiles(fx.homeDir, { '.claude/skill-forge/state.json': JSON.stringify({ version: 2, ref: REF, files: {}, versions: {} }) });
  const { stdout } = await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', '--offline'], { env: { ...process.env, HOME: fx.homeDir } });
  const findings = JSON.parse(stdout).findings;
  assert.ok(findings.some((entry) => entry.id === 'D-repo-local-hook-pin'));
  assert.ok(!findings.some((entry) => entry.id === 'D-repo-settings-ignored'));
  assert.deepEqual(findings.map((entry) => entry.id).filter((id) => /remote|machine|restates/.test(id)), [], 'the published line is not flagged');
});

test('flags: a bad --ref or a flag with no value is a usage error; a malformed manifest warns; --check --json is always JSON', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0', 'bad name!': '^1.0.0' });
  assert.equal((await ensure(fx, base, ['--ref', 'abc'])).code, 2);
  assert.match((await ensure(fx, base, ['--ref'])).stdout, /--ref needs a value/);
  assert.equal((await ensure(fx, base, ['--repo', '--check'])).code, 2);

  const json = await ensure(fx, base, ['--check', '--json']);
  const report = JSON.parse(json.stdout);
  assert.equal(report.version, 1);
  assert.match(report.warnings.join('\n'), /bad name or range/);

  const broken = await checkout({});
  await fs.writeFile(path.join(broken.repo, 'skill-forge.json'), '{ nope');
  const result = await ensure(broken, base, ['--check', '--json']);
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).warnings[0], /not a regular file of valid JSON/);

  const linked = await checkout({ alpha: '^0.2.0' });
  await fs.mkdir(path.join(linked.repo, '.agents/skills'), { recursive: true });
  await fs.mkdir(path.join(linked.repo, '.claude'));
  await fs.symlink('../.agents/skills', path.join(linked.repo, '.claude/skills'));
  assert.equal(JSON.parse((await ensure(linked, base, ['--check', '--json'])).stdout).managedBy, 'skf sync');
  assert.deepEqual(await ensure(linked, base, ['--hook']), { code: 0, stdout: '' }, 'silent in the hook');
});

test('a symlinked .claude/skill-forge is refused, nothing written through it', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  const elsewhere = await tempDir('skf-ensure-elsewhere-');
  await fs.mkdir(path.join(fx.repo, '.claude'));
  await fs.symlink(elsewhere, path.join(fx.repo, '.claude/skill-forge'));
  const result = await ensure(fx, base);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /is a symlink/);
  assert.deepEqual(await fs.readdir(elsewhere), []);
});
