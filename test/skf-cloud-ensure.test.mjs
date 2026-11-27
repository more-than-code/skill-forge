import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

async function ensure(fx, base, args = [], extraEnv = {}) {
  const env = { ...process.env, HOME: fx.homeDir, USERPROFILE: fx.homeDir, SKF_BASE: base, SKF_DEFAULT_SKILLS: '0', ...extraEnv };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  try {
    const { stdout } = await run('node', [CLOUD, 'ensure', ...args], { cwd: fx.repo, env });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout };
  }
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
  assert.match(text.stdout, /copies: .*\.claude\/skills \(0\.2\.0\), ~\/\.claude\/skills \(0\.2\.3\)/);
  assert.equal((await ensure(fx, base)).stdout, '', 'nothing to install: no parent copy is duplicated');
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

test('the version comes from the lock commit, else --ref; without either nothing is fetched', async () => {
  const base = await mirror({ [REF]: { alpha: '0.2.1' }, [OLD_REF]: { alpha: '0.2.0' } });
  const fx = await checkout({ alpha: '^0.2.0' }, { lock: OLD_REF });
  await ensure(fx, base, ['--ref', REF]);
  assert.equal(await read(path.join(fx.repo, '.claude/skills/alpha/SKILL.md')), skillText('alpha', '0.2.0'), 'the lock wins');

  const bare = await checkout({ alpha: '^0.2.0' }, { lock: null });
  const none = await ensure(bare, base);
  assert.equal(none.code, 1);
  assert.match(none.stdout, /no pinned commit/);
  await ensure(bare, base, ['--ref', REF]);
  assert.equal(await read(path.join(bare.repo, '.claude/skills/alpha/SKILL.md')), skillText('alpha', '0.2.1'));
});

test('the steward comes along unless a copy exists or SKF_DEFAULT_SKILLS=0', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  const result = await ensure(fx, base, [], { SKF_DEFAULT_SKILLS: undefined });
  assert.match(result.stdout, /installed claude-project-steward, alpha/);
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

  const offline = await checkout({ alpha: '^0.2.0' });
  const failed = await ensure(offline, 'https://127.0.0.1:9', ['--hook']);
  assert.equal(failed.code, 0);
  assert.match(JSON.parse(failed.stdout).systemMessage, /could not install/);
});

test('--write-hook merges the pinned entry into .claude/settings.json, idempotently, and prints the AGENTS.md line', async () => {
  const fx = await checkout({ alpha: '^0.2.0' });
  await writeFiles(fx.repo, { '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }) });
  const first = await ensure(fx, '/unused', ['--write-hook', '--ref', REF]);
  assert.equal(first.code, 0, first.stdout);
  assert.match(first.stdout, /use the `claude-project-steward` skill/);
  const written = await read(path.join(fx.repo, '.claude/settings.json'));
  await ensure(fx, '/unused', ['--write-hook', '--ref', REF]);
  assert.equal(await read(path.join(fx.repo, '.claude/settings.json')), written, 'idempotent');
  const settings = JSON.parse(written);
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] }, 'other keys kept');
  assert.equal(settings.hooks.SessionStart.length, 2, 'the other hook is kept');
  const command = settings.hooks.SessionStart[1].hooks[0].command;
  assert.match(command, new RegExp(`skf-cloud-${REF}\\.mjs`));
  assert.match(command, /^node -e '[^'"$]+' -- --hook$/, 'one pair of single quotes, no quotes or $ inside');
});

test('the bootstrap runs through bash from a cached script, and warns once when it cannot fetch', async () => {
  const base = await mirror();
  const fx = await checkout({ alpha: '^0.2.0' });
  await ensure(fx, '/unused', ['--write-hook', '--ref', REF]);
  const command = JSON.parse(await read(path.join(fx.repo, '.claude/settings.json'))).hooks.SessionStart[0].hooks[0].command;
  const env = { ...process.env, HOME: fx.homeDir, SKF_BASE: base, SKF_DEFAULT_SKILLS: '0', CLAUDE_PROJECT_DIR: fx.repo };
  const runHook = (extra = {}) => run('bash', ['-c', command], { cwd: fx.repo, env: { ...env, ...extra } });

  const offline = await runHook({ SKF_BASE: 'https://127.0.0.1:9' });
  assert.match(JSON.parse(offline.stdout).systemMessage, /could not check the declared skills/);

  await fs.mkdir(path.join(fx.repo, '.claude/skill-forge'), { recursive: true });
  await fs.copyFile(CLOUD, path.join(fx.repo, `.claude/skill-forge/skf-cloud-${REF}.mjs`));
  const { stdout } = await runHook();
  assert.match(JSON.parse(stdout).systemMessage, /installed alpha/);
  assert.equal((await runHook()).stdout, '', 'quiet once everything is there');
});

test('the bootstrap text runs unchanged under PowerShell', { skip: !(await run('pwsh', ['-v']).then(() => true, () => false)) && 'pwsh is not installed here' }, async () => {
  const fx = await checkout({ alpha: '^0.2.0' });
  await ensure(fx, '/unused', ['--write-hook', '--ref', REF]);
  const command = JSON.parse(await read(path.join(fx.repo, '.claude/settings.json'))).hooks.SessionStart[0].hooks[0].command;
  const { stdout } = await run('pwsh', ['-NoProfile', '-Command', command], { cwd: fx.repo, env: { ...process.env, HOME: fx.homeDir, SKF_BASE: 'https://127.0.0.1:9', CLAUDE_PROJECT_DIR: fx.repo } });
  assert.match(JSON.parse(stdout).systemMessage, /could not check the declared skills/);
});
