import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// skf-cloud.mjs: the dependency-free installer and doctor for Claude Project threads
// (tasks/spec-project-thread-setup.md). Install reads a fixture registry through SKF_BASE, a
// local mirror laid out as <base>/<ref>/<path>, exactly like raw.githubusercontent.com.

const run = promisify(execFile);
// Tests run inside cloud sessions too: thread-only findings appear only where a test asks for them.
delete process.env.CLAUDE_CODE_REMOTE;
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'cli.js');
const CLOUD = path.join(REPO, 'bin', 'skf-cloud.mjs');
const REF = 'a'.repeat(40);
const CORE = '# Cloud rules\n\nUse `{{tool}}`.\n';
const CLAUDE_BLOCK = '## Claude\n\nClaude notes.\n';
const REVIEWER = '---\nname: reviewer\ndescription: Review.\n---\nReview.\n';
const VALIDATOR = '---\nname: validator\ndescription: Validate.\n---\nValidate.\n';
const SKILL_A = '---\nname: alpha\ndescription: Alpha skill.\n---\nAlpha.\n';
const SKILL_A_EXTRA = 'Alpha examples.\n';
const SKILL_B = '---\nname: beta\ndescription: Beta skill.\n---\nBeta.\n';

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
const sha = (text) => `sha256-${crypto.createHash('sha256').update(text).digest('base64')}`;
const read = (file) => fs.readFile(file, 'utf8');
const exists = (file) => fs.lstat(file).then(() => true, () => false);

/** A locked fixture registry, mirrored at <base>/<REF>. */
async function registryMirror() {
  const root = await tempDir('skf-cloud-reg-');
  await writeFiles(root, {
    'inventory/agents/variants/cloud/core.md': CORE,
    'inventory/agents/variants/cloud/CLAUDE.md': CLAUDE_BLOCK,
    'inventory/subagents/claude-code/reviewer.md': REVIEWER,
    'inventory/subagents/claude-code/validator.md': VALIDATOR,
    'inventory/skills/alpha/SKILL.md': SKILL_A,
    'inventory/skills/alpha/EXAMPLES.md': SKILL_A_EXTRA,
    'inventory/skills/beta/SKILL.md': SKILL_B,
    'inventory/skills/podman/SKILL.md': '---\nname: podman\ndescription: Mac only.\n---\nPodman.\n'
  });
  const skill = (name, tags = []) => ({ type: 'skill', name, version: '0.1.0', scope: 'custom', path: `inventory/skills/${name}`, installable: true, tags });
  const registry = {
    name: 'skill-forge-test',
    version: '0.0.0',
    schemaVersion: 1,
    skills: [skill('alpha'), skill('beta'), skill('podman', ['containers', 'workstation-only'])],
    managedAgents: [],
    managedSubagents: [{ type: 'subagents', name: 'claude-code-subagents', version: '0.2.0', scope: 'claude-code', path: 'inventory/subagents/claude-code', installable: false, runtimeTarget: '~/.claude/agents' }],
    managedHooks: [],
    instructionVariants: [{ name: 'cloud', version: '0.1.0', description: 'Cloud.', core: 'inventory/agents/variants/cloud/core.md', claude: 'inventory/agents/variants/cloud/CLAUDE.md', vars: { tool: 'Explore' } }]
  };
  await fs.writeFile(path.join(root, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
  await run('node', [CLI, 'lock'], { cwd: root, env: { ...process.env, SKILL_FORGE_ROOT: root } });
  const base = await tempDir('skf-cloud-base-');
  await fs.symlink(root, path.join(base, REF));
  return { root, base };
}

async function install(mirror, homeDir, decl) {
  // Repos are read from SKF_REPOS_DIR; default to an empty folder so the test runner's cwd never counts.
  const reposDir = decl.SKF_REPOS_DIR ?? await tempDir('skf-cloud-norepos-');
  const env = { ...process.env, HOME: homeDir, SKF_BASE: mirror.base, SKF_REF: REF, SKF_REPOS_DIR: reposDir, ...decl };
  const { stdout } = await run('node', [CLOUD, 'install'], { env });
  return stdout;
}

async function treeHashes(dir) {
  const out = {};
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = sha(await fs.readFile(full));
    }
  };
  await walk(dir);
  return out;
}

const DECL = { SKF_RULES: 'cloud', SKF_AGENTS: 'claude-code', SKF_SKILLS: 'alpha beta' };

test('install writes exactly the declared rules, agents and skills, byte-identical, and records state', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, DECL);
  const claude = path.join(homeDir, '.claude');
  assert.equal(await read(path.join(claude, 'rules/skill-forge.md')), '# Cloud rules\n\nUse `Explore`.\n\n## Claude\n\nClaude notes.\n');
  assert.equal(await read(path.join(claude, 'agents/reviewer.md')), REVIEWER);
  assert.equal(await read(path.join(claude, 'agents/validator.md')), VALIDATOR);
  assert.equal(await read(path.join(claude, 'skills/alpha/SKILL.md')), SKILL_A);
  assert.equal(await read(path.join(claude, 'skills/alpha/EXAMPLES.md')), SKILL_A_EXTRA);
  assert.equal(await read(path.join(claude, 'skills/beta/SKILL.md')), SKILL_B);
  assert.equal(await exists(path.join(claude, 'CLAUDE.md')), false, 'never writes CLAUDE.md');
  const state = JSON.parse(await read(path.join(claude, 'skill-forge/state.json')));
  assert.equal(state.ref, REF);
  assert.deepEqual(state.failed, []);
  assert.equal(Object.keys(state.files).length, 6);
  assert.ok(await exists(path.join(claude, 'skill-forge/skf-cloud.mjs')), 'keeps a copy of itself for doctor');
  assert.match(await read(path.join(homeDir, 'skf-setup.log')), /done: all files verified/);
});

test('a file whose bytes do not match the lock is not written; install still exits 0', async () => {
  const mirror = await registryMirror();
  await fs.appendFile(path.join(mirror.root, 'inventory/skills/beta/SKILL.md'), 'tampered\n');
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, DECL);
  assert.equal(await exists(path.join(homeDir, '.claude/skills/beta/SKILL.md')), false);
  assert.equal(await read(path.join(homeDir, '.claude/skills/alpha/SKILL.md')), SKILL_A);
  assert.match(await read(path.join(homeDir, 'skf-setup.log')), /FAILED inventory\/skills\/beta\/SKILL\.md: hash mismatch/);
});

test('an unreachable registry or a bad ref writes nothing and still exits 0', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  await install({ base: '/nonexistent-skf-mirror' }, homeDir, DECL);
  assert.match(await read(path.join(homeDir, 'skf-setup.log')), /FAILED install/);
  assert.equal(await exists(path.join(homeDir, '.claude/skills')), false);

  const mirror = await registryMirror();
  await install(mirror, homeDir, { ...DECL, SKF_REF: 'main' });
  assert.match(await read(path.join(homeDir, 'skf-setup.log')), /SKF_REF must be a full 40-character/);
});

test('a second run is a no-op, unowned files are left alone, and dropped skills are removed only while unedited', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  // A platform-owned file and a user skill that happens to share a name: never touched.
  await writeFiles(homeDir, { '.claude/CLAUDE.md': 'platform\n', '.claude/skills/beta/SKILL.md': 'mine\n' });
  await install(mirror, homeDir, DECL);
  assert.equal(await read(path.join(homeDir, '.claude/CLAUDE.md')), 'platform\n');
  assert.equal(await read(path.join(homeDir, '.claude/skills/beta/SKILL.md')), 'mine\n');
  assert.match(await read(path.join(homeDir, 'skf-setup.log')), /kept .*beta\/SKILL\.md: not installed by skill-forge/);

  const before = await treeHashes(path.join(homeDir, '.claude'));
  await install(mirror, homeDir, DECL);
  assert.deepEqual(await treeHashes(path.join(homeDir, '.claude')), before);

  // Dropping alpha removes its files; an edited one stays.
  await fs.appendFile(path.join(homeDir, '.claude/skills/alpha/EXAMPLES.md'), 'my note\n');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'beta' });
  assert.equal(await exists(path.join(homeDir, '.claude/skills/alpha/SKILL.md')), false);
  assert.equal(await read(path.join(homeDir, '.claude/skills/alpha/EXAMPLES.md')), `${SKILL_A_EXTRA}my note\n`);
});

test('project rules from SKF_PROJECT_RULES_FILE land in ~/.claude/rules/project.md', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const rulesFile = path.join(homeDir, 'project-rules.md');
  await fs.writeFile(rulesFile, '# Project rules\n\nPull requests go into `dev`.\n');
  await install(mirror, homeDir, { ...DECL, SKF_PROJECT_RULES_FILE: rulesFile });
  assert.equal(await read(path.join(homeDir, '.claude/rules/project.md')), '# Project rules\n\nPull requests go into `dev`.\n');
});

/** Two cloned repos under a fake /home/user, shaped like the Deploybot audit found them. */
async function deploybotLikeRepos() {
  const reposDir = await tempDir('skf-cloud-repos-');
  const team = '## How the team works\n\nOne defect per thread. Joe merges every pull request into dev after review.\n';
  const block = '<!-- >>> skill-forge instructions full@0.1.0 >>> -->\n# Agent Core\n\nLog approvals in tasks/todo.md.\n<!-- <<< skill-forge instructions <<< -->\n';
  await writeFiles(reposDir, {
    'plane/.git/HEAD': 'ref: refs/heads/main\n',
    'plane/CLAUDE.md': '@AGENTS.md\n',
    'plane/AGENTS.md': `# plane\n\nNo external workers here.\n${'x'.repeat(9000)}\n\n${team}\n${block}`,
    'plane/.claude/skills/alpha/SKILL.md': SKILL_A,
    'plane/.claude/agents/reviewer.md': 'my own reviewer\n',
    'plane/skill-forge.json': JSON.stringify({ schemaVersion: 2, skills: { dependencies: { alpha: '^0.1.0', gamma: '^0.1.0' } } }),
    'agent/.git/HEAD': 'ref: refs/heads/main\n',
    'agent/AGENTS.md': `# agent\n\n${team}`,
    'agent/skill-forge.json': JSON.stringify({ schemaVersion: 2, skills: { dependencies: { alpha: '^0.1.0' } } })
  });
  return reposDir;
}

async function doctor(homeDir, reposDir, extra = []) {
  const env = { ...process.env, HOME: homeDir };
  const { stdout } = await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', '--offline', ...extra], { env });
  return JSON.parse(stdout);
}
const ids = (report) => report.findings.map((entry) => entry.id).sort();

test('doctor without a setup reports it missing and still checks the repositories', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await deploybotLikeRepos();
  const report = await doctor(homeDir, reposDir);
  assert.deepEqual(report.repos, ['agent', 'plane']);
  for (const id of ['D-setup-missing', 'D-repo-no-claude-md', 'D-repo-managed-block', 'D-repo-size']) {
    assert.ok(ids(report).includes(id), `expected ${id} in ${ids(report).join(', ')}`);
  }
  const noClaude = report.findings.find((entry) => entry.id === 'D-repo-no-claude-md');
  assert.match(noClaude.evidence, /^agent /);
  assert.equal(noClaude.owner, 'thread-pr');
});

test('doctor after install reproduces the Deploybot audit findings and changes nothing', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha beta' });
  const reposDir = await deploybotLikeRepos();
  const beforeHome = await treeHashes(homeDir);
  const beforeRepos = await treeHashes(reposDir);
  const report = await doctor(homeDir, reposDir);
  assert.deepEqual(await treeHashes(homeDir), beforeHome, 'doctor writes nothing in HOME');
  assert.deepEqual(await treeHashes(reposDir), beforeRepos, 'doctor writes nothing in the repos');

  const found = ids(report);
  for (const id of ['D-repo-no-claude-md', 'D-repo-managed-block', 'D-repo-size', 'D-repo-duplicate-section', 'D-repo-vendored-skill', 'D-repo-agent-shadow', 'D-skill-missing', 'D-skill-unused', 'D-repo-restates-rules']) {
    assert.ok(found.includes(id), `expected ${id} in ${found.join(', ')}`);
  }
  assert.ok(!found.includes('D-setup-missing'));
  const missing = report.findings.find((entry) => entry.id === 'D-skill-missing');
  assert.match(missing.evidence, /gamma/);
  const unused = report.findings.find((entry) => entry.id === 'D-skill-unused');
  assert.match(unused.evidence, /beta/);
  const dup = report.findings.find((entry) => entry.id === 'D-repo-vendored-skill');
  assert.match(dup.evidence, /plane:alpha/);

  const env = { ...process.env, HOME: homeDir };
  await assert.rejects(run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--offline', '--check'], { env }), 'issues fail --check');
});

test('doctor reports an edited installed file and a clean setup with clean repos', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha' });
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'ref: refs/heads/main\n',
    'one/CLAUDE.md': '@AGENTS.md\n',
    'one/AGENTS.md': '# one\n\nRun `make test`.\n',
    'one/skill-forge.json': JSON.stringify({ schemaVersion: 2, skills: { dependencies: { alpha: '^0.1.0' } } })
  });
  const env = { ...process.env, HOME: homeDir };
  const clean = await doctor(homeDir, reposDir);
  assert.deepEqual(clean.findings, []);
  await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--offline', '--check'], { env });

  await fs.appendFile(path.join(homeDir, '.claude/rules/skill-forge.md'), 'edited\n');
  assert.deepEqual(ids(await doctor(homeDir, reposDir)), ['D-setup-tampered']);
});

test('doctor --context flags Project instructions without a PR base and with restated workflow rules', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const context = path.join(homeDir, 'instructions.txt');
  await fs.writeFile(context, 'Use risk tiers. Record approvals in tasks/todo.md.\n');
  const found = ids(await doctor(homeDir, reposDir, ['--context', context]));
  assert.ok(found.includes('D-context-pr-base'));
  assert.ok(found.includes('D-context-restates-rules'));

  await fs.writeFile(context, 'Repos: plane owns the API.\nPull requests go into `dev`.\n');
  const ok = ids(await doctor(homeDir, reposDir, ['--context', context]));
  assert.ok(!ok.includes('D-context-pr-base'));
  assert.ok(!ok.includes('D-context-restates-rules'));
});

test('a bad name or a failed file skips only that part; files installed before are kept', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, DECL);
  // Second run: beta's file now fails to verify, a typo and a workstation-only skill are declared.
  await fs.appendFile(path.join(mirror.root, 'inventory/skills/beta/SKILL.md'), 'tampered\n');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha beta nosuch podman' });
  const claude = path.join(homeDir, '.claude');
  assert.equal(await read(path.join(claude, 'skills/beta/SKILL.md')), SKILL_B, 'the copy that worked is kept');
  assert.equal(await read(path.join(claude, 'rules/skill-forge.md')).then((text) => text.startsWith('# Cloud rules')), true);
  assert.equal(await exists(path.join(claude, 'skills/podman')), false);
  const state = JSON.parse(await read(path.join(claude, 'skill-forge/state.json')));
  assert.ok(state.files[path.join(claude, 'skills/beta/SKILL.md')], 'still owned');
  assert.equal(state.failed.length, 3);
  assert.match(state.failed.join('\n'), /beta\/SKILL\.md \(hash mismatch\)/);
  assert.match(state.failed.join('\n'), /skill nosuch \(unknown/);
  assert.match(state.failed.join('\n'), /skill podman \(workstation-only/);
  const report = await doctor(homeDir, await tempDir('skf-cloud-repos-'));
  assert.ok(ids(report).includes('D-setup-failed'));
});

test('a tampered state never steers a delete outside ~/.claude, and edited owned files are kept on update', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, DECL);
  const victim = path.join(homeDir, 'precious.txt');
  await fs.writeFile(victim, 'keep\n');
  const statePath = path.join(homeDir, '.claude/skill-forge/state.json');
  const state = JSON.parse(await read(statePath));
  state.files[victim] = sha('keep\n');
  await fs.writeFile(statePath, JSON.stringify(state));
  await fs.appendFile(path.join(homeDir, '.claude/agents/reviewer.md'), 'my tweak\n');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha' });
  assert.equal(await read(victim), 'keep\n');
  assert.equal(await read(path.join(homeDir, '.claude/agents/reviewer.md')), `${REVIEWER}my tweak\n`);
  assert.match(await read(path.join(homeDir, 'skf-setup.log')), /kept .*reviewer\.md: edited since install/);
});

test('install never writes through a symlink under ~/.claude', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const elsewhere = await tempDir('skf-cloud-elsewhere-');
  await fs.mkdir(path.join(homeDir, '.claude/skills'), { recursive: true });
  await fs.symlink(elsewhere, path.join(homeDir, '.claude/skills/alpha'));
  await install(mirror, homeDir, DECL);
  assert.deepEqual(await fs.readdir(elsewhere), []);
  assert.match(await read(path.join(homeDir, 'skf-setup.log')), /FAILED write .*alpha.*is a symlink/);
  assert.equal(await read(path.join(homeDir, '.claude/skills/beta/SKILL.md')), SKILL_B);
});

test('doctor: import checks, shared skills, notes-only --check, context size and ref-behind', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  // The explicit-list mode (SKF_FROM_REPOS=0): shared skills are the owner's to add to SKF_SKILLS.
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha', SKF_FROM_REPOS: '0' });
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'x\n',
    'one/CLAUDE.md': '# one\n\nSee notes.\n',
    'one/AGENTS.md': '# one facts\n',
    'one/skill-forge.json': JSON.stringify({ skills: { dependencies: { alpha: '^0.1.0', beta: '^0.1.0' } } }),
    'two/.git/HEAD': 'x\n',
    'two/CLAUDE.md': 'Read @AGENTS.md first.\n',
    'two/AGENTS.md': '# two facts\n',
    'two/skill-forge.json': JSON.stringify({ skills: { dependencies: { beta: '^0.1.0' } } })
  });
  const found = ids(await doctor(homeDir, reposDir));
  assert.ok(found.includes('D-repo-claude-no-import'), 'one/CLAUDE.md does not import AGENTS.md');
  assert.equal(found.filter((id) => id === 'D-repo-claude-no-import').length, 1, 'an inline @AGENTS.md counts as the import');
  assert.ok(found.includes('D-skill-shared-not-installed'), 'beta is declared by both repos');

  // Notes only: --check passes.
  await fs.writeFile(path.join(reposDir, 'one/CLAUDE.md'), '@AGENTS.md\n');
  const env = { ...process.env, HOME: homeDir };
  const notes = await doctor(homeDir, reposDir);
  assert.ok(notes.findings.length > 0 && notes.findings.every((entry) => entry.severity === 'note'));
  await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--offline', '--check'], { env });

  const context = path.join(homeDir, 'instructions.txt');
  await fs.writeFile(context, `Pull requests go into \`dev\`.\n${'x'.repeat(16001)}\n`);
  assert.ok(ids(await doctor(homeDir, reposDir, ['--context', context])).includes('D-context-size'));

  // ref-behind: the registry's main has a newer alpha than the pinned ref.
  const registry = JSON.parse(await read(path.join(mirror.root, 'registry.json')));
  registry.skills[0].version = '0.2.0';
  const mainDir = path.join(mirror.base, 'main');
  await fs.mkdir(mainDir);
  await fs.writeFile(path.join(mainDir, 'registry.json'), JSON.stringify(registry));
  const { stdout } = await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json'], { env: { ...env } });
  const behind = JSON.parse(stdout).findings.find((entry) => entry.id === 'D-ref-behind');
  assert.match(behind.evidence, /skill:alpha 0\.1\.0 -> 0\.2\.0/);

  // A pin ahead of main (main lags the integration branch) is not "behind".
  registry.skills[0].version = '0.0.9';
  await fs.writeFile(path.join(mainDir, 'registry.json'), JSON.stringify(registry));
  const ahead = await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json'], { env: { ...env } });
  assert.ok(!JSON.parse(ahead.stdout).findings.some((entry) => entry.id === 'D-ref-behind'));
});

test('doctor flags Grok only as a workflow, not a host name or a product\'s agent adapter', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/CLAUDE.md': '@AGENTS.md\n' });
  const flagged = async (text) => {
    await fs.writeFile(path.join(reposDir, 'one/AGENTS.md'), `# one\n\n${text}\n`);
    return ids(await doctor(homeDir, reposDir)).includes('D-repo-restates-rules');
  };
  assert.equal(await flagged('nodes.json: grok-bot-box has systemd false.'), false, 'a host name');
  assert.equal(await flagged('Coding-agent adapters: `grok` (default), `claude`, `antigravity`; `start_fix`+`grok` is the worker path.'), false, 'a product adapter');
  assert.equal(await flagged('Delegate builds to Grok workers.'), true);
  assert.equal(await flagged('Use the grok-build-harness skill.'), true);
  assert.equal(await flagged('Run a Grok build for bulk edits.'), true);
  assert.equal(await flagged('No external workers.'), true);
});

test('doctor flags a repo line that forbids committing or pushing, which the cloud rules override for the thread branch', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/CLAUDE.md': '@AGENTS.md\n' });
  const report = async (text) => {
    await fs.writeFile(path.join(reposDir, 'one/AGENTS.md'), `# one\n\n${text}\n`);
    return (await doctor(homeDir, reposDir)).findings.find((entry) => entry.id === 'D-repo-restates-rules');
  };
  const flagged = async (text) => Boolean((await report(text))?.evidence.includes('"do not commit / do not push"'));
  for (const text of [
    'Do not commit unless the user asks. Do not push.',
    'Do not commit / do not push.',
    "- Don't push.",
    'Don\u2019t commit unless you are asked to.',
    '**Do not commit** unless asked.',
    'Do not commit or push without asking.',
    'Do not commit/push.',
    'Never push.',
    'DO NOT COMMIT.',
    'Do not push unless explicitly asked.'
  ]) assert.equal(await flagged(text), true, text);
  for (const text of [
    'Never push to main; pull requests go into dev.',
    'Do not commit generated files.',
    'Do not commit without running tests.',
    'Do not commit unless tests pass.',
    'Do not commit:\n- .env\n- build output',
    'Do not commit\ngenerated files.',
    'Do not commit, e.g. build output.',
    'Do not commit; use make release.',
    'Commits and pushes: cloud sessions and Project threads follow the shared workflow rules (Git and pull requests).',
    '<!-- >>> skill-forge instructions cloud@0.1.1 >>> -->\nA repository\'s blanket "do not commit unless asked / do not push" default is for local sessions.\nDo not push.\n<!-- <<< skill-forge instructions <<< -->'
  ]) assert.equal(await flagged(text), false, text);
  const found = await report('Do not commit unless the user asks.');
  assert.match(found.fix, /pointer to the shared workflow rules/);
  assert.doesNotMatch(found.evidence, /\\b/, 'a label, not the pattern source');
  assert.doesNotMatch((await report('No external workers.')).fix, /pointer/, 'the pointer hint only for a commit ban');
});

// --- Repo manifests drive skill installs (tasks/spec-manifest-skill-install.md) ---

const manifest = (dependencies, extra = {}) => JSON.stringify({ schemaVersion: 2, skills: { dependencies, ...extra } });
const readStateFile = async (homeDir) => JSON.parse(await read(path.join(homeDir, '.claude/skill-forge/state.json')));
const skillDirs = async (homeDir) => (await fs.readdir(path.join(homeDir, '.claude/skills')).catch(() => [])).sort();

test('install adds repo-declared skills once each, after SKF_SKILLS, and skips local, workstation-only and broken manifests', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'x\n',
    'one/skill-forge.json': manifest({ alpha: '^0.1.0', beta: '^0.1.0', podman: '^0.1.0' }, { local: { mine: '.claude/skills/mine' } }),
    'two/.git/HEAD': 'x\n',
    'two/skill-forge.json': manifest({ beta: '~0.1.0' }),
    'three/.git/HEAD': 'x\n',
    'three/skill-forge.json': '{ not json',
    'loose/skill-forge.json': manifest({ gamma: '^0.1.0' }),
    'four/.git/HEAD': 'x\n',
    'secret.json': manifest({ beta: '^0.1.0' }),
    'five/.git/HEAD': 'x\n',
    'five/skill-forge.json': JSON.stringify({ skills: { dependencies: ['alpha'] } }),
    'six/.git/HEAD': 'x\n',
    'six/skill-forge.json': manifest({ '../evil': '^0.1.0', beta: 'latest', alpha: 1 }),
    'seven/.git/HEAD': 'x\n'
  });
  // A manifest that is a symlink (it could point at a root-only file or a FIFO) is never read.
  await fs.symlink(path.join(reposDir, 'secret.json'), path.join(reposDir, 'four/skill-forge.json'));
  await fs.symlink('loop', path.join(reposDir, 'loop'));
  const out = await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha', SKF_REPOS_DIR: reposDir });
  assert.deepEqual(await skillDirs(homeDir), ['alpha', 'beta'], 'each name once; no podman, no local skill, no non-git folder');
  assert.equal(await read(path.join(homeDir, '.claude/skills/beta/SKILL.md')), SKILL_B);
  assert.match(out, /skipped three\/skill-forge\.json/);
  assert.match(out, /skipped four\/skill-forge\.json: not a regular file/);
  assert.match(out, /repos: five, four, one, seven, six, three, two\n/, 'a looping link is not a repository and does not stop the scan');
  assert.match(out, /skipped five\/skill-forge\.json: skills\.dependencies is not an object/);
  assert.equal((out.match(/skipped six dependency/g) || []).length, 3, 'unsafe name, bad range and non-string range are each skipped');
  const state = await readStateFile(homeDir);
  assert.equal(state.version, 2);
  assert.equal(state.fromRepos, true);
  assert.deepEqual(state.skills, ['alpha'], 'skills stays the SKF_SKILLS list');
  assert.deepEqual(state.skillSources, { alpha: 'env', beta: ['one', 'two'] });
  assert.deepEqual(state.skipped, { podman: { reason: 'workstation-only', repos: ['one'], detail: '', version: '0.1.0' } });
  assert.deepEqual(state.failed, [], 'a skip is not a failure');
  assert.equal(state.versions['skill:beta'], '0.1.0');

  const report = await doctor(homeDir, reposDir);
  const found = ids(report);
  assert.ok(found.includes('D-skill-workstation-only'), found.join(', '));
  assert.match(report.findings.find((entry) => entry.id === 'D-skill-workstation-only').evidence, /^one declares 1 workstation-only skill\(s\), not installed in threads: podman$/);
  for (const id of ['D-skill-missing', 'D-skill-unused', 'D-skill-shared-not-installed', 'D-setup-failed']) assert.ok(!found.includes(id), `unexpected ${id}`);
  assert.ok(!report.findings.some((entry) => /\bmine\b/.test(entry.evidence)), 'a skills.local skill raises nothing');
});

test('install reads the repos in its working directory when SKF_REPOS_DIR is unset (the setup script case)', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/skill-forge.json': manifest({ beta: '^0.1.0' }) });
  const env = { ...process.env, HOME: homeDir, SKF_BASE: mirror.base, SKF_REF: REF, ...DECL, SKF_SKILLS: '' };
  delete env.SKF_REPOS_DIR;
  await run('node', [CLOUD, 'install'], { env, cwd: reposDir });
  assert.deepEqual(await skillDirs(homeDir), ['beta']);
});

test('satisfiesRange in skf-cloud.mjs matches lib/skill-helpers.js', async () => {
  const { satisfiesRange: lib } = await import(path.join(REPO, 'lib', 'skill-helpers.js'));
  const source = (await read(CLOUD)).match(/function satisfiesRange\(version, range\) \{[\s\S]*?\n\}\n/)[0];
  const cloud = new Function(`${source}; return satisfiesRange;`)();
  const versions = ['0.0.3', '0.0.4', '0.1.0', '0.1.1', '0.2.0', '0.2.5', '1.0.0', '1.2.3', '1.2.9', '1.3.0', '2.0.0'];
  const ranges = ['0.1.0', '^0.0.3', '^0.1.0', '^0.1.1', '^0.2.3', '~0.2.0', '^1.2.3', '~1.2.3', '1.2.3', '^1.0.0'];
  for (const range of ranges) for (const version of versions) {
    assert.equal(cloud(version, range), lib(version, range), `${version} vs ${range}`);
  }
  assert.equal(cloud('1.0.0', 'latest'), null, 'a malformed range is null, not a throw');
});

test('a version outside a repo range skips that skill alone; install exits 0 and doctor reports D-skill-range', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'x\n',
    'one/skill-forge.json': manifest({ alpha: '0.1.0', beta: '^0.1.1' }),
    'two/.git/HEAD': 'x\n',
    'two/skill-forge.json': manifest({ beta: '~0.1.0', gone: '^1.0.0' })
  });
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: '', SKF_REPOS_DIR: reposDir });
  assert.deepEqual(await skillDirs(homeDir), ['alpha'], 'an exact range matches; ^0.1.1 rejects 0.1.0');
  const state = await readStateFile(homeDir);
  assert.equal(state.skipped.beta.reason, 'range');
  assert.match(state.skipped.beta.detail, /SKF_REF has 0\.1\.0; one wants \^0\.1\.1/);
  assert.doesNotMatch(state.skipped.beta.detail, /two wants/, 'only the repos whose range fails are named');
  assert.equal(state.skipped.gone.reason, 'not-in-registry');
  assert.deepEqual(state.failed, []);

  const report = await doctor(homeDir, reposDir);
  const range = report.findings.filter((entry) => entry.id === 'D-skill-range');
  assert.deepEqual(range.map((entry) => entry.severity), ['issue', 'issue']);
  assert.ok(range.some((entry) => /beta/.test(entry.evidence)) && range.some((entry) => /gone/.test(entry.evidence)));
  assert.ok(!ids(report).includes('D-skill-missing'));
});

test('SKF_FROM_REPOS=0 ignores the repos: same files and state as without them', async () => {
  const mirror = await registryMirror();
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/skill-forge.json': manifest({ beta: '^0.1.0' }) });
  const withRepos = await tempDir('skf-cloud-home-');
  const without = await tempDir('skf-cloud-home-');
  await install(mirror, withRepos, { ...DECL, SKF_SKILLS: 'alpha', SKF_FROM_REPOS: '0', SKF_REPOS_DIR: reposDir });
  await install(mirror, without, { ...DECL, SKF_SKILLS: 'alpha', SKF_FROM_REPOS: '0' });
  const strip = (hashes) => Object.fromEntries(Object.entries(hashes).filter(([rel]) => !rel.startsWith('skill-forge/')));
  assert.deepEqual(strip(await treeHashes(path.join(withRepos, '.claude'))), strip(await treeHashes(path.join(without, '.claude'))));
  const [a, b] = [await readStateFile(withRepos), await readStateFile(without)];
  assert.equal(a.fromRepos, false);
  assert.deepEqual(a.skillSources, { alpha: 'env' });
  assert.deepEqual(a.skipped, {});
  assert.deepEqual(Object.keys(a.files).map((f) => path.relative(withRepos, f)), Object.keys(b.files).map((f) => path.relative(without, f)));
});

test('install --top-up adds a newly declared skill and leaves every other file untouched', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const env = { ...process.env, HOME: homeDir, SKF_REPOS_DIR: reposDir, SKF_BASE: mirror.base };
  const topUp = (args = []) => run('node', [path.join(homeDir, '.claude/skill-forge/skf-cloud.mjs'), 'install', '--top-up', ...args], { env });

  await assert.rejects(run('node', [CLOUD, 'install', '--top-up'], { env }), (error) => error.code === 1 && /has not run install/.test(error.stdout));

  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/skill-forge.json': manifest({ alpha: '^0.1.0' }) });
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: '', SKF_REPOS_DIR: reposDir });
  assert.match((await topUp()).stdout, /nothing to add/);

  // The manifest gains beta after the environment was built.
  await fs.writeFile(path.join(reposDir, 'one/skill-forge.json'), manifest({ alpha: '^0.1.0', beta: '^0.1.0' }));
  const missing = (await doctor(homeDir, reposDir)).findings.find((entry) => entry.id === 'D-skill-missing');
  assert.equal(missing.owner, 'thread');
  assert.match(missing.fix, /install --top-up/);

  const before = await treeHashes(path.join(homeDir, '.claude'));
  const { stdout } = await topUp(['--repos-dir', reposDir]);
  assert.match(stdout, /added: beta/);
  const after = await treeHashes(path.join(homeDir, '.claude'));
  for (const [rel, hash] of Object.entries(before)) {
    if (rel !== 'skill-forge/state.json') assert.equal(after[rel], hash, `${rel} unchanged`);
  }
  assert.deepEqual(Object.keys(after).filter((rel) => !(rel in before)), ['skills/beta/SKILL.md']);
  const state = await readStateFile(homeDir);
  assert.deepEqual(state.skillSources, { alpha: ['one'], beta: ['one'] });
  assert.equal(state.rules, 'cloud', 'the rest of the state is kept');
  assert.ok(!ids(await doctor(homeDir, reposDir)).includes('D-skill-missing'));
  assert.match(await read(path.join(homeDir, 'skf-setup.log')), /added: beta/, 'appends to the setup log');
});

test('doctor notes a repo-installed skill no repo declares any more, only when every recorded repo is cloned', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/skill-forge.json': manifest({ alpha: '^0.1.0', beta: '^0.1.0' }) });
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: '', SKF_REPOS_DIR: reposDir });
  assert.ok(!ids(await doctor(homeDir, reposDir)).includes('D-skill-repo-leftover'));

  // The repo stops declaring beta after the environment was built (or after a top-up).
  await fs.writeFile(path.join(reposDir, 'one/skill-forge.json'), manifest({ alpha: '^0.1.0' }));
  const leftovers = (await doctor(homeDir, reposDir)).findings.filter((entry) => entry.id === 'D-skill-repo-leftover');
  assert.equal(leftovers.length, 1);
  assert.equal(leftovers[0].severity, 'note');
  assert.equal(leftovers[0].owner, 'thread');
  assert.match(leftovers[0].evidence, /beta was installed for one, which no longer declares it/);
  assert.match(leftovers[0].fix, /next environment rebuild/);

  // A manifest that does not parse (mid-edit) may still declare it: say nothing.
  await fs.writeFile(path.join(reposDir, 'one/skill-forge.json'), '{');
  assert.ok(!ids(await doctor(homeDir, reposDir)).includes('D-skill-repo-leftover'));
  await fs.writeFile(path.join(reposDir, 'one/skill-forge.json'), manifest({ alpha: '^0.1.0' }));

  // A recorded repo that is not cloned here may still declare it: say nothing.
  await fs.rename(path.join(reposDir, 'one'), path.join(reposDir, 'renamed'));
  assert.ok(!ids(await doctor(homeDir, reposDir)).includes('D-skill-repo-leftover'));
});

test('doctor: committed copies are issues, and lock drift and a different variant are notes', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'x\n',
    'one/skill-forge.json': JSON.stringify({ schemaVersion: 2, instructions: { variant: 'full', version: '^0.1.0' }, skills: { dependencies: { alpha: '^0.1.0' } } }),
    'one/skill-forge.lock.json': JSON.stringify({ skills: { alpha: { version: '0.1.1', integrity: 'x', source: 'registry' }, mine: { path: 'p', integrity: 'y', source: 'local' } } }),
    'one/.claude/skills/alpha/SKILL.md': SKILL_A
  });
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: '', SKF_REPOS_DIR: reposDir });
  const report = await doctor(homeDir, reposDir);
  const byId = (id) => report.findings.filter((entry) => entry.id === id);
  assert.equal(byId('D-repo-vendored-skill')[0].severity, 'issue');
  assert.match(byId('D-repo-vendored-skill')[0].fix, /\.gitignore/);
  assert.match(byId('D-skill-version-drift')[0].evidence, /locks alpha 0\.1\.1; threads run 0\.1\.0/);
  assert.equal(byId('D-skill-version-drift').length, 1, 'local lock entries are not compared');
  assert.match(byId('D-rules-variant-differs')[0].evidence, /declares instructions variant full; threads load the environment's cloud/);
});

test('a range fixed after setup turns the skip into a top-up; a workstation-only skip leaves nothing to add', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/skill-forge.json': manifest({ beta: '^0.1.1', podman: '^0.1.0' }) });
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: '', SKF_REPOS_DIR: reposDir });
  const env = { ...process.env, HOME: homeDir, SKF_REPOS_DIR: reposDir, SKF_BASE: mirror.base };
  const topUp = () => run('node', [CLOUD, 'install', '--top-up'], { env });
  assert.match((await topUp()).stdout, /nothing to add/, 'skips that still hold are not retried');

  await fs.writeFile(path.join(reposDir, 'one/skill-forge.json'), manifest({ beta: '^0.1.0', podman: '^0.1.0' }));
  const report = await doctor(homeDir, reposDir);
  assert.ok(!ids(report).includes('D-skill-range'), 'the recorded skip is stale once the range is fixed');
  assert.equal(report.findings.find((entry) => entry.id === 'D-skill-missing').owner, 'thread');
  assert.match((await topUp()).stdout, /added: beta/);
  const state = await readStateFile(homeDir);
  assert.deepEqual(Object.keys(state.skipped), ['podman']);
});

test('a repo skill that failed to install at setup is retried by top-up, and its failure is cleared', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/skill-forge.json': manifest({ beta: '^0.1.0' }) });
  const betaFile = path.join(mirror.root, 'inventory/skills/beta/SKILL.md');
  await fs.writeFile(betaFile, 'corrupted in transit\n');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: '', SKF_REPOS_DIR: reposDir });
  let state = await readStateFile(homeDir);
  assert.equal(state.skillSources.beta, undefined, 'not recorded as installed');
  assert.equal(state.failed.length, 1);
  const found = ids(await doctor(homeDir, reposDir));
  assert.ok(found.includes('D-setup-failed') && found.includes('D-skill-missing'));

  await fs.writeFile(betaFile, SKILL_B);
  const env = { ...process.env, HOME: homeDir, SKF_REPOS_DIR: reposDir, SKF_BASE: mirror.base };
  assert.match((await run('node', [CLOUD, 'install', '--top-up'], { env })).stdout, /added: beta/);
  state = await readStateFile(homeDir);
  assert.deepEqual(state.failed, []);
  assert.ok(!ids(await doctor(homeDir, reposDir)).includes('D-setup-failed'));
});

test('an old (version 1) state: doctor keeps the explicit-list findings and top-up changes nothing', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha' });
  const statePath = path.join(homeDir, '.claude/skill-forge/state.json');
  const v2 = JSON.parse(await read(statePath));
  const v1 = { version: 1, ref: v2.ref, base: v2.base, rules: v2.rules, agents: v2.agents, skills: v2.skills, projectRules: false, versions: v2.versions, failed: [], files: v2.files };
  await fs.writeFile(statePath, JSON.stringify(v1));
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'x\n', 'one/skill-forge.json': manifest({ alpha: '^0.1.0', gamma: '^0.1.0' }), 'one/.claude/skills/alpha/SKILL.md': SKILL_A
  });
  const report = await doctor(homeDir, reposDir);
  const missing = report.findings.find((entry) => entry.id === 'D-skill-missing');
  assert.equal(missing.owner, 'owner-paste', 'the explicit-list fix: add it to SKF_SKILLS');
  assert.equal(report.findings.find((entry) => entry.id === 'D-repo-vendored-skill').severity, 'note');
  const env = { ...process.env, HOME: homeDir, SKF_REPOS_DIR: reposDir, SKF_BASE: mirror.base };
  assert.match((await run('node', [CLOUD, 'install', '--top-up'], { env })).stdout, /nothing changed/);
  assert.equal(await read(statePath), JSON.stringify(v1), 'state untouched');
});

test('doctor: a .claude/skills symlink (the skf sync claude-code shim) is one finding with a fix for the link', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'x\n',
    'one/skill-forge.json': manifest({ alpha: '^0.1.0', beta: '^0.1.0', podman: '^0.1.0' }),
    'one/.agents/skills/alpha/SKILL.md': SKILL_A,
    'one/.agents/skills/beta/SKILL.md': SKILL_B,
    'one/.agents/skills/podman/SKILL.md': '---\nname: podman\ndescription: Mac only.\n---\nPodman.\n',
    'two/.git/HEAD': 'x\n',
    'two/skill-forge.json': manifest({ alpha: '^0.1.0' }, { local: { mine: '.agents/skills/mine' } }),
    'two/.agents/skills/alpha/SKILL.md': SKILL_A,
    'two/.agents/skills/mine/SKILL.md': '---\nname: mine\ndescription: Mine.\n---\nMine.\n',
    'three/.git/HEAD': 'x\n',
    'three/skill-forge.json': manifest({ alpha: '^0.1.0' }),
    'three/.agents/skills/alpha/SKILL.md': SKILL_A,
    'three/.agents/skills/handmade/SKILL.md': '---\nname: handmade\ndescription: Not declared.\n---\nH.\n',
    'abs/.git/HEAD': 'x\n', 'abs/.claude/.keep': '',
    'out/.git/HEAD': 'x\n', 'out/.claude/.keep': '',
    'dangle/.git/HEAD': 'x\n', 'dangle/.claude/.keep': ''
  });
  await fs.mkdir(path.join(reposDir, 'one/.claude'));
  await fs.mkdir(path.join(reposDir, 'two/.claude'));
  await fs.symlink('../.agents/skills', path.join(reposDir, 'one/.claude/skills'));
  await fs.symlink('../.agents/skills', path.join(reposDir, 'two/.claude/skills'));
  await fs.mkdir(path.join(reposDir, 'three/.claude'));
  await fs.symlink('../.agents/skills/', path.join(reposDir, 'three/.claude/skills'));
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: '', SKF_REPOS_DIR: reposDir });
  // Links that leave the repo or dangle commit no copies: no finding, and nothing is listed through them.
  await fs.symlink(path.join(homeDir, '.claude/skills'), path.join(reposDir, 'abs/.claude/skills'));
  await fs.symlink('../../one/.agents/skills', path.join(reposDir, 'out/.claude/skills'));
  await fs.symlink('../nowhere', path.join(reposDir, 'dangle/.claude/skills'));

  const vendored = (await doctor(homeDir, reposDir)).findings.filter((entry) => entry.id === 'D-repo-vendored-skill');
  assert.deepEqual(vendored.map((entry) => entry.evidence.split(' ')[0]), ['one', 'three', 'two'], 'one finding per repo; none for abs, out or dangle');
  const [one, three, two] = vendored;
  assert.match(one.evidence, /^one commits \.claude\/skills as a symlink to \.agents\/skills\/,.*: alpha, beta$/);
  const block = (own) => ['# >>> skill-forge generated >>>', '/.agents/skills/*', ...own.map((name) => `!/.agents/skills/${name}/`), '# <<< skill-forge generated <<<'].map((line) => `"${line}"`).join(', ');
  assert.ok(one.fix.includes('set "generated": "ignored"') && one.fix.includes(`one per line, exactly: ${block([])};`), one.fix);
  assert.match(one.fix, /git rm -r --cached -- \.agents\/skills\/alpha \.agents\/skills\/beta \.agents\/skills\/podman;/, 'a declared workstation-only copy is generated too');
  assert.doesNotMatch(one.fix, /Also settle/, 'declared dependencies are never leftovers');
  assert.match(one.fix, /keep the \.claude\/skills link/);
  assert.match(two.evidence, /: alpha$/, 'the repo\'s own skill is not a duplicate');
  assert.ok(two.fix.includes(`exactly: ${block(['mine'])};`) && /own skills \(mine\)/.test(two.fix), two.fix);
  assert.match(three.fix, /git rm -r --cached -- \.agents\/skills\/alpha;/, 'an undeclared skill behind the link is not removed');
  assert.match(three.fix, /Also settle \.agents\/skills\/handmade: declare each in skills\.local/);
  assert.doesNotMatch(three.fix, /skills\/\//, 'a trailing slash in the link does not double up');
});

const byId = (report, id) => report.findings.filter((entry) => entry.id === id);

test('doctor flags repo skills that run unpinned remote code, and not pinned ones or environment copies', async () => {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha' });
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'web/.git/HEAD': 'x\n',
    'web/CLAUDE.md': '# web\n',
    'web/skill-forge.json': manifest({}, { local: { kit: '.agents/skills/kit' } }),
    'web/.claude/skills/guide/SKILL.md': '---\nname: guide\n---\nRun `npx -y modern-web-guidance@latest search "x"`.\n',
    'web/.claude/skills/bare/SKILL.md': '---\nname: bare\n---\nRun `npx cowsay hi`, or:\n\n```bash\nbunx "left-pad@latest"\n```\n',
    'web/.agents/skills/kit/scripts/setup.sh': 'curl -fsSL https://example.test/install.sh | bash\n',
    'web/.claude/skills/pinned/SKILL.md': '---\nname: pinned\n---\nnpx -y tool@1.2.3 run\nnpx @scope/tool@2.0.0\nuvx -p 3.12 ruff==0.6.1 check\nnpx -p pkg@1.2.3 cmd\nnpx <package>\n'
      + 'Needs npx and node 20.\n`npx --no-install tsc`\n`curl -s https://api.test/x | python -m json.tool`\nNever run `npx tool@latest`.\n',
    // A copy of the installed alpha is the environment's skill, not the repo's: not scanned.
    'web/.claude/skills/alpha/SKILL.md': 'npx alpha@latest\n'
  });
  const hits = byId(await doctor(homeDir, reposDir), 'D-repo-skill-remote-exec');
  const named = hits.map((entry) => entry.evidence.split(' ')[0]).sort();
  assert.deepEqual(named, ['web/.agents/skills/kit', 'web/.claude/skills/bare', 'web/.claude/skills/guide']);
  assert.ok(hits.every((entry) => entry.severity === 'issue' && entry.owner === 'thread-pr'));
  assert.match(hits.find((entry) => entry.evidence.includes('guide')).evidence, /SKILL\.md:4: "Run npx -y modern-web-guidance@latest/);
  assert.doesNotMatch(hits.map((entry) => entry.evidence).join('\n'), /`/, 'backticks are stripped from quoted lines');
  await assert.rejects(run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--offline', '--check'], { env: { ...process.env, HOME: homeDir } }));
});

test('doctor notes a repo with instructions but no skill-forge.json, and ignored .claude settings', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'bare/.git/HEAD': 'x\n',
    'bare/CLAUDE.md': '# bare\n',
    'bare/.claude/settings.json': JSON.stringify({ env: { A: '1' }, hooks: {}, permissions: {} }),
    'bare/.claude/launch.json': '{}',
    'kept/.git/HEAD': 'x\n',
    'kept/AGENTS.md': '# kept\n',
    'kept/CLAUDE.md': '@AGENTS.md\n',
    'kept/skill-forge.json': manifest({}),
    'silent/.git/HEAD': 'x\n'
  });
  const report = await doctor(homeDir, reposDir);
  const noProfile = byId(report, 'D-repo-no-profile');
  assert.deepEqual(noProfile.map((entry) => entry.evidence.split(' ')[0]), ['bare']);
  assert.equal(noProfile[0].severity, 'note');
  const settings = byId(report, 'D-repo-settings-ignored');
  assert.equal(settings.length, 1);
  assert.match(settings[0].evidence, /^bare has \.claude\/settings\.json \(env, hooks, permissions\), \.claude\/launch\.json/);
});

test('doctor flags another machine\'s setup in repo instructions, except under a local-sessions heading', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const shaw = 'Push only to the private repo: `git push private master:main`\nCommit as `CKShaw-N <CKShaw-N@users.noreply.github.com>`\nNotes live in /Users/shaw/notes/.\n';
  await writeFiles(reposDir, {
    'mos/.git/HEAD': 'x\n',
    'mos/.git/config': '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.test/mos.git\n',
    'mos/CLAUDE.md': `# mos\n\nRun \`git push origin HEAD\` from your branch.\n\n## Git\n\n${shaw}`,
    'mos/skill-forge.json': manifest({})
  });
  const report = await doctor(homeDir, reposDir);
  const [hit, ...rest] = byId(report, 'D-repo-machine-specific');
  assert.equal(rest.length, 0);
  assert.equal(hit.severity, 'issue');
  assert.match(hit.evidence, /CLAUDE\.md:7 "Push only to the private repo: git push private master:main" \(pushes to remote private, which this clone does not have; pushes to main\)/);
  assert.match(hit.evidence, /CLAUDE\.md:8 .*\(sets a commit identity\)/);
  assert.match(hit.evidence, /CLAUDE\.md:9 .*\(names a personal home path\)/);
  assert.doesNotMatch(hit.evidence, /origin HEAD/);

  await fs.writeFile(path.join(reposDir, 'mos/CLAUDE.md'), `# mos\n\n## Local sessions only (Shaw's machine)\n\n${shaw}`);
  assert.deepEqual(byId(await doctor(homeDir, reposDir), 'D-repo-machine-specific'), []);
});

test('in a thread, doctor prompts for the Project instructions, the thread-limits check and connectors', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, { 'one/.git/HEAD': 'x\n', 'one/CLAUDE.md': '# one\n', 'one/skill-forge.json': manifest({}) });
  const threadDoctor = async (extra = []) => {
    const env = { ...process.env, HOME: homeDir, CLAUDE_CODE_REMOTE: 'true' };
    return JSON.parse((await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', '--offline', ...extra], { env })).stdout);
  };
  assert.deepEqual(ids(await doctor(homeDir, reposDir)).filter((id) => /unchecked|thread-limits/.test(id)), [], 'outside a thread: no prompts');

  const report = await threadDoctor();
  for (const id of ['D-context-unchecked', 'D-repo-thread-limits', 'D-connectors-unchecked']) {
    assert.equal(byId(report, id).length, 1, `${id} once`);
  }
  assert.equal(byId(report, 'D-connectors-unchecked')[0].owner, 'owner-account');
  assert.match(byId(report, 'D-context-unchecked')[0].fix, /mktemp.*--context <that file>/);
  assert.match(byId(report, 'D-repo-thread-limits')[0].evidence, /^one loads instructions/);
  assert.ok(report.findings.filter((entry) => /unchecked|thread-limits/.test(entry.id)).every((entry) => entry.severity === 'note'), 'prompts never fail --check');

  const context = path.join(homeDir, 'instructions.txt');
  await fs.writeFile(context, '  \n');
  const empty = ids(await threadDoctor(['--context', context]));
  assert.ok(empty.includes('D-context-missing') && !empty.includes('D-context-pr-base') && !empty.includes('D-context-unchecked'), empty.join(', '));
});

/** Installs alpha, then widens the ref's registry: gamma (tagged), plus skills doctor must never list. */
async function suggestSetup() {
  const mirror = await registryMirror();
  const homeDir = await tempDir('skf-cloud-home-');
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha' });
  const registryFile = path.join(mirror.root, 'registry.json');
  const registry = JSON.parse(await read(registryFile));
  const skill = (name, extra) => ({ type: 'skill', name, version: '0.2.0', scope: 'custom', path: `inventory/skills/${name}`, installable: true, tags: [], ...extra });
  registry.skills.push(
    skill('gamma', { tags: ['frontend', 'workflow'] }),
    skill('delta', { workstationOnly: true }),
    skill('epsilon', { installable: false }),
    skill('zeta', { version: 'next' }),
    skill('eta', { path: 'elsewhere/eta' }));
  await fs.writeFile(registryFile, JSON.stringify(registry));
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'ref: refs/heads/main\n',
    'one/CLAUDE.md': '@AGENTS.md\n',
    'one/AGENTS.md': '# one\n\nRun `make test`.\n'
  });
  const env = { ...process.env, HOME: homeDir };
  const online = async (extra = []) => JSON.parse((await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', ...extra], { env })).stdout);
  const suggestions = async () => (await online()).findings.filter((entry) => entry.id.startsWith('D-skill-suggest'));
  return { mirror, homeDir, reposDir, online, suggestions };
}

test('doctor lists the installable registry skills nothing installs or declares as a prompt for the agent', async () => {
  const { mirror, suggestions } = await suggestSetup();
  // alpha is installed; podman (tag) and delta (flag) are workstation-only; epsilon, zeta and eta are not installable.
  const found = await suggestions();
  assert.deepEqual(found.map((entry) => [entry.id, entry.severity, entry.owner]), [['D-skill-suggest', 'note', 'thread']]);
  assert.equal(found[0].evidence, '2 registry skill(s) are neither installed nor declared by a repo: beta 0.1.0, gamma 0.2.0 [frontend, workflow]');
  assert.ok(found[0].fix.endsWith(`Skills (name, range, description): beta ^0.1.0 ${mirror.base}/${REF}/inventory/skills/beta/SKILL.md; gamma ^0.2.0 ${mirror.base}/${REF}/inventory/skills/gamma/SKILL.md`));
  assert.match(found[0].fix, /skill-forge\.json skills\.dependencies/);
  assert.match(found[0].fix, /install --top-up/);
});

test('a skill a repo declares, keeps locally or commits is not suggested; no candidates, no finding', async () => {
  const { reposDir, suggestions } = await suggestSetup();
  await writeFiles(reposDir, {
    'one/.claude/skills/beta/SKILL.md': SKILL_B,
    'one/skill-forge.json': JSON.stringify({ schemaVersion: 2, skills: { local: { gamma: 'skills/gamma' } } })
  });
  assert.deepEqual(await suggestions(), [], 'a committed copy and a local skill count');
  await fs.rm(path.join(reposDir, 'one/.claude'), { recursive: true });
  // A malformed range is reported elsewhere; the repo still names the skill, so it is not suggested again.
  await writeFiles(reposDir, { 'one/skill-forge.json': JSON.stringify({ schemaVersion: 2, skills: { dependencies: { beta: 'latest', gamma: '^0.2.0' } } }) });
  assert.deepEqual(await suggestions(), [], 'declarations count');
});

test('suggestions: --offline and a bad recorded ref skip them; an unreadable registry is one note; --check ignores both', async () => {
  const { mirror, homeDir, reposDir, online, suggestions } = await suggestSetup();
  const env = { ...process.env, HOME: homeDir };
  const checked = JSON.parse((await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', '--check'], { env })).stdout);
  assert.ok(checked.findings.some((entry) => entry.id === 'D-skill-suggest'), 'present in the run that exits 0');
  assert.ok(!(await online(['--offline'])).findings.some((entry) => entry.id.startsWith('D-skill-suggest')));

  const stateFile = path.join(homeDir, '.claude/skill-forge/state.json');
  const state = JSON.parse(await read(stateFile));
  await fs.writeFile(stateFile, JSON.stringify({ ...state, ref: '../x' }));
  assert.deepEqual(await suggestions(), [], 'a ref install would refuse is never fetched or echoed');
  await fs.writeFile(stateFile, JSON.stringify(state));

  await fs.unlink(path.join(mirror.base, REF));
  const unchecked = JSON.parse((await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', '--check'], { env })).stdout);
  assert.deepEqual(unchecked.findings.filter((entry) => entry.id.startsWith('D-skill-suggest')).map((entry) => [entry.id, entry.severity]),
    [['D-skill-suggest-unchecked', 'note']]);
});

test('doctor without an install state lists no suggestions', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const { stdout } = await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json'], { env: { ...process.env, HOME: homeDir } });
  assert.ok(!JSON.parse(stdout).findings.some((entry) => entry.id.startsWith('D-skill-suggest')));
});

test('machine-specific lines: prose, prohibitions and flags are not pushes; a local section holds its subheadings and fences', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const quiet = [
    '# app', '',
    'Run tests, then git push and open a PR.',
    'Never run `git push origin main`; do not git push to master.',
    'Use `git push -u` or `git push --tags` from your branch, and `git push -u origin HEAD`.',
    'Read `user.name = req.body.name` and run `git log --author=bot`.',
    'Containers use /home/node/app/ and /Users/Shared/cache/.', '',
    '## Local sessions only (Shaw\'s machine)', '',
    '### Git', '',
    '```bash', '# push to the private mirror', 'git push private master:main', '```',
    'Commit as `CKShaw-N <CKShaw-N@users.noreply.github.com>`.', ''
  ].join('\n');
  await writeFiles(reposDir, {
    'app/.git/HEAD': 'x\n',
    'app/.git/config': '[remote "origin"]\n\turl = https://example.test/app.git\n',
    'app/CLAUDE.md': quiet,
    'app/skill-forge.json': manifest({})
  });
  assert.deepEqual(byId(await doctor(homeDir, reposDir), 'D-repo-machine-specific'), []);

  // A same-level heading ends the local section; an import is checked under its own name.
  await writeFiles(reposDir, {
    'app/CLAUDE.md': `${quiet}\n## Release\n\nShip with \`git push origin feature:main\`.\n\n@docs/agent.md\n`,
    'app/docs/agent.md': '# Agent\n\nRun `git config user.email shaw@example.test` first.\n'
  });
  const report = await doctor(homeDir, reposDir);
  const [hit] = byId(report, 'D-repo-machine-specific');
  assert.match(hit.evidence, /CLAUDE\.md:\d+ "Ship with git push origin feature:main \." \(pushes to main\)/);
  assert.match(hit.evidence, /docs\/agent\.md:3 .*\(sets a commit identity\)/);
  assert.equal(hit.evidence.match(/" \(/g).length, 2, hit.evidence);
  const env = { ...process.env, HOME: homeDir };
  const checked = await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--offline', '--check'], { env }).then(() => 0, (error) => error.code);
  assert.equal(checked, 1, 'a machine-specific line fails --check');
});

test('doctor --check: empty Project instructions fail it; the new notes alone do not', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'bare/.git/HEAD': 'x\n',
    'bare/CLAUDE.md': '# bare\n',
    'bare/.claude/settings.json': '[1, 2]'
  });
  const context = path.join(homeDir, 'instructions.txt');
  await fs.writeFile(context, '');
  const env = { ...process.env, HOME: homeDir, CLAUDE_CODE_REMOTE: 'true' };
  const exit = (extra) => run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--offline', '--json', '--check', ...extra], { env })
    .then(({ stdout }) => [0, JSON.parse(stdout)], (error) => [error.code, JSON.parse(error.stdout)]);
  const [missingExit, missing] = await exit(['--context', context]);
  assert.equal(missingExit, 1);
  const [entry] = byId(missing, 'D-context-missing');
  assert.deepEqual([entry.severity, entry.owner], ['issue', 'owner-paste']);

  // With a setup and Project instructions, only notes are left: no profile, ignored settings and the thread prompts.
  const mirror = await registryMirror();
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha' });
  await fs.writeFile(context, 'Pull requests go into `dev`.\n');
  const [notesExit, notes] = await exit(['--context', context]);
  assert.equal(notesExit, 0, ids(notes).join(', '));
  for (const id of ['D-repo-no-profile', 'D-repo-settings-ignored', 'D-repo-thread-limits', 'D-connectors-unchecked']) assert.ok(ids(notes).includes(id), id);
  assert.match(byId(notes, 'D-repo-settings-ignored')[0].evidence, /^bare has \.claude\/settings\.json;/);
});

test('false positives from the PR #9 review: local bins, container homes, read-only git config, outside files', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const outside = await tempDir('skf-cloud-outside-');
  await fs.writeFile(path.join(outside, 'CLAUDE.md'), '# elsewhere\n\n`git push private master:main`\n');
  await writeFiles(reposDir, {
    'web/.git/HEAD': 'x\n',
    'web/.git/config': '[remote "origin"]\n\turl = https://example.test/web.git\n',
    'web/CLAUDE.md': '# web\n\nThe image runs from /home/app/ and /home/deploy/releases/.\nNever run `git config user.email` here.\nCheck with `git config user.email`.\n',
    'web/package.json': JSON.stringify({ devDependencies: { prettier: '3.3.3' } }),
    'web/skill-forge.json': manifest({}),
    'web/.claude/skills/fmt/SKILL.md': '---\nname: fmt\n---\nRun `npx prettier --check .`.\n',
    'web/.claude/skills/types/SKILL.md': '---\nname: types\n---\nRun `npx tsc --noEmit`.\n',
    'web/.claude/skills/gh/SKILL.md': '---\nname: gh\n---\nRun `npx github:someone/tool`.\n',
    'odd/.git/HEAD': 'x\n',
    'odd/.claude': 'not a folder\n',
    'odd/skill-forge.json': manifest({})
  });
  await fs.symlink(path.join(outside, 'CLAUDE.md'), path.join(reposDir, 'odd/CLAUDE.md'));
  const report = await doctor(homeDir, reposDir);
  const exec = byId(report, 'D-repo-skill-remote-exec').map((entry) => [entry.evidence.split(' ')[0], entry.severity]).sort();
  assert.deepEqual(exec, [['web/.claude/skills/gh', 'issue'], ['web/.claude/skills/types', 'note']], 'a declared devDependency bin is skipped; an undeclared bare name is a note');
  assert.deepEqual(byId(report, 'D-repo-machine-specific'), [], 'container homes, a prohibition and a read-only git config are not machine-specific; an outside CLAUDE.md is not quoted');
  assert.deepEqual(byId(report, 'D-repo-settings-ignored'), [], 'a .claude file is no settings folder');
});

const git = (cwd, ...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'init.defaultBranch=main', ...args], { cwd });
/** A real git repository under reposDir with the given files committed. */
async function gitRepo(reposDir, name, files) {
  const dir = path.join(reposDir, name);
  await writeFiles(dir, files);
  await git(reposDir, 'init', '-q', name);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('doctor flags tracked personal files as issues and unignored ones as a note', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  // Without an install, D-setup-missing is an issue too; --check must fail on the personal file alone.
  const issues = (report) => report.findings.filter((entry) => entry.severity === 'issue' && entry.id !== 'D-setup-missing').map((entry) => entry.id);
  await gitRepo(reposDir, 'leaky', {
    'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '# leaky\n', 'skill-forge.json': manifest({}),
    'CLAUDE.local.md': 'Reply in Simplified Chinese.\n', '.claude/settings.local.json': '{}'
  });
  let report = await doctor(homeDir, reposDir);
  const [tracked, ...more] = byId(report, 'D-repo-personal-file');
  assert.equal(more.length, 0);
  assert.equal(tracked.severity, 'issue');
  assert.match(tracked.evidence, /^leaky tracks CLAUDE\.local\.md, \.claude\/settings\.local\.json,/);
  assert.match(tracked.fix, /git rm --cached -- CLAUDE\.local\.md \.claude\/settings\.local\.json/);
  assert.deepEqual(byId(report, 'D-repo-personal-unignored'), [], 'a tracked file is not reported twice');
  assert.deepEqual(issues(report), ['D-repo-personal-file']);

  const dir = path.join(reposDir, 'leaky');
  await git(dir, 'rm', '-q', '--cached', '--', 'CLAUDE.local.md', '.claude/settings.local.json');
  await git(dir, 'commit', '-q', '-m', 'untrack');
  report = await doctor(homeDir, reposDir);
  assert.deepEqual(byId(report, 'D-repo-personal-file'), []);
  const [unignored] = byId(report, 'D-repo-personal-unignored');
  assert.equal(unignored.severity, 'note');
  assert.match(unignored.evidence, /does not cover CLAUDE\.local\.md, \.claude\/settings\.local\.json/);

  await fs.writeFile(path.join(dir, '.gitignore'), '/CLAUDE.local.md\n');
  assert.match(byId(await doctor(homeDir, reposDir), 'D-repo-personal-unignored')[0].evidence, /does not cover \.claude\/settings\.local\.json,/);
  await fs.writeFile(path.join(dir, '.gitignore'), '/CLAUDE.local.md\n/.claude/settings.local.json\n');
  report = await doctor(homeDir, reposDir);
  assert.deepEqual(byId(report, 'D-repo-personal-unignored'), []);
  assert.deepEqual(issues(report), []);
});

test('doctor says nothing about personal files where git cannot read the repository', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  // A .git that is not a repository: git must not fall back to a repository above it.
  await writeFiles(reposDir, { 'fake/.git/HEAD': 'x\n', 'fake/CLAUDE.md': '@AGENTS.md\n', 'fake/AGENTS.md': '# fake\n', 'fake/CLAUDE.local.md': 'mine\n' });
  await gitRepo(reposDir, '.', { 'outer.txt': 'x\n' });
  const found = ids(await doctor(homeDir, reposDir));
  assert.ok(!found.some((id) => id.startsWith('D-repo-personal')), found.join(', '));
});

test('doctor suggests AGENTS.md for a repo whose instructions live only in CLAUDE.md', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'only/.git/HEAD': 'x\n', 'only/CLAUDE.md': '# only\n\nRun `make test`.\n',
    'imports/.git/HEAD': 'x\n', 'imports/CLAUDE.md': '@docs/agents.md\n\n', 'imports/docs/agents.md': '# imports\n',
    'shared/.git/HEAD': 'x\n', 'shared/CLAUDE.md': '@AGENTS.md\n', 'shared/AGENTS.md': '# shared\n',
    'shim/.git/HEAD': 'x\n', 'shim/CLAUDE.md': '@AGENTS.md\r\n',
    'block/.git/HEAD': 'x\n', 'block/CLAUDE.md': '<!-- >>> skill-forge instructions full@0.1.0 >>> -->\n# Core\n<!-- <<< skill-forge instructions <<< -->\n'
  });
  const hits = byId(await doctor(homeDir, reposDir), 'D-repo-no-agents-md');
  assert.deepEqual(hits.map((entry) => [entry.evidence.split(' ')[0], entry.severity, entry.owner]), [['only', 'note', 'thread-pr']]);
  assert.match(hits[0].fix, /single line @AGENTS\.md/);
});

test('doctor checks that each repo has the PR base the Project instructions name', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const remotes = await tempDir('skf-cloud-remotes-');
  const env = { ...process.env, HOME: homeDir };
  const online = async (extra) => JSON.parse((await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', ...extra], { env })).stdout);
  const files = { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '# r\n', 'skill-forge.json': manifest({}) };
  for (const name of ['withdev', 'nodev']) {
    const dir = await gitRepo(reposDir, name, files);
    await git(remotes, 'init', '-q', '--bare', `${name}.git`);
    await git(dir, 'remote', 'add', 'origin', path.join(remotes, `${name}.git`));
    await git(dir, 'push', '-q', 'origin', 'main');
    if (name === 'withdev') await git(dir, 'push', '-q', 'origin', 'main:dev');
  }
  const context = path.join(homeDir, 'instructions.txt');
  await fs.writeFile(context, 'Pull requests go into `dev`.\n');
  let report = await online(['--context', context]);
  const [missing, ...more] = byId(report, 'D-context-base-missing');
  assert.equal(more.length, 0);
  assert.deepEqual([missing.severity, missing.owner], ['issue', 'owner-paste']);
  assert.match(missing.evidence, /into dev, but nodev has no dev branch on origin$/);
  assert.deepEqual(byId(report, 'D-context-base-unchecked'), []);
  assert.deepEqual(byId(await online(['--context', context, '--offline']), 'D-context-base-missing'), [], '--offline skips it');

  await fs.writeFile(context, 'PRs go into main.\n');
  report = await online(['--context', context]);
  assert.deepEqual(ids(report).filter((id) => id.startsWith('D-context-base')), []);

  // An unreachable origin is a note, never an issue.
  await git(path.join(reposDir, 'nodev'), 'remote', 'set-url', 'origin', path.join(remotes, 'gone.git'));
  await fs.writeFile(context, 'Pull requests go into `dev`.\n');
  report = await online(['--context', context]);
  assert.deepEqual(byId(report, 'D-context-base-missing'), []);
  assert.match(byId(report, 'D-context-base-unchecked')[0].evidence, /^could not check that nodev has a dev branch/);

  // Only a backticked name is checked, after a determiner; different bases on different lines check nothing.
  for (const [text, expected] of [
    ['Pull requests go into the `dev` branch.\n', ['D-context-base-unchecked']],
    ['PRs go into `dev`; the owner merges dev into main.\n', ['D-context-base-unchecked']],
    ['Pull requests go into the default branch.\n', []],
    ['PRs into `dev` for nodev.\nPRs into `main` for withdev.\n', []],
    ['PRs go into `dev` for apps, `main` for docs.\n', []],
    ['Never open pull requests into `main`.\nPull requests go into `dev`.\n', ['D-context-base-unchecked']],
    ['Never open pull requests into `main`.\n', []]
  ]) {
    await fs.writeFile(context, text);
    assert.deepEqual(ids(await online(['--context', context])).filter((id) => id.startsWith('D-context-base')), expected, text);
  }
  assert.equal(byId(report, 'D-context-base-unchecked')[0].owner, 'thread');

  // A base that git could read as an option never reaches git.
  await fs.writeFile(context, 'Pull requests go into `--upload-pack=touch`.\n');
  assert.deepEqual(ids(await online(['--context', context])).filter((id) => id.startsWith('D-context-base')), []);
});

test('doctor stays fast on a CLAUDE.md line of many @ characters and ignores a hostile uploadpack', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const remotes = await tempDir('skf-cloud-remotes-');
  const dir = await gitRepo(reposDir, 'odd', { 'CLAUDE.md': `${'@'.repeat(60)}\`\n`, 'skill-forge.json': manifest({}) });
  const started = Date.now();
  assert.equal(byId(await doctor(homeDir, reposDir), 'D-repo-no-agents-md').length, 1);
  assert.ok(Date.now() - started < 5000, 'no catastrophic backtracking');

  await git(remotes, 'init', '-q', '--bare', 'odd.git');
  await git(dir, 'remote', 'add', 'origin', path.join(remotes, 'odd.git'));
  await git(dir, 'push', '-q', 'origin', 'main');
  const marker = path.join(homeDir, 'ran');
  await git(dir, 'config', 'remote.origin.uploadpack', `touch ${marker}; git-upload-pack`);
  const context = path.join(homeDir, 'instructions.txt');
  await fs.writeFile(context, 'Pull requests go into `dev`.\n');
  const env = { ...process.env, HOME: homeDir };
  const report = JSON.parse((await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', '--context', context], { env })).stdout);
  assert.equal(await exists(marker), false, 'the repo config ran no command');
  assert.match(byId(report, 'D-context-base-missing')[0].evidence, /odd has no dev branch/);
});

test('doctor\'s git ignores a repo\'s credential helper and askpass on an https origin that asks for a password', async (t) => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  const certDir = await tempDir('skf-cloud-cert-');
  try {
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-days', '1',
      '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')]);
  } catch {
    t.skip('openssl is not available');
    return;
  }
  const https = await import('node:https');
  let asked = 0;
  const server = https.createServer({ key: await read(path.join(certDir, 'key.pem')), cert: await read(path.join(certDir, 'cert.pem')) }, (req, res) => {
    asked += 1;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `https://127.0.0.1:${server.address().port}/r.git`;
  const dir = await gitRepo(reposDir, 'locked', { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '# locked\n', 'skill-forge.json': manifest({}) });
  const marker = path.join(homeDir, 'ran');
  const askpass = path.join(homeDir, 'askpass.sh');
  await fs.writeFile(askpass, `#!/bin/sh\ntouch ${marker}\necho secret\n`, { mode: 0o755 });
  await git(dir, 'remote', 'add', 'origin', url);
  await git(dir, 'config', 'http.sslVerify', 'false');
  await git(dir, 'config', 'credential.helper', `!touch ${marker}.helper; echo`);
  await git(dir, 'config', `credential.${url}.helper`, `!touch ${marker}.scoped; echo`);
  await git(dir, 'config', 'core.askPass', askpass);
  const context = path.join(homeDir, 'instructions.txt');
  await fs.writeFile(context, 'Pull requests go into `dev`.\n');
  const env = { ...process.env, HOME: homeDir, SSH_ASKPASS: askpass, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  const report = JSON.parse((await run('node', [CLOUD, 'doctor', '--repos-dir', reposDir, '--json', '--context', context], { env })).stdout);
  assert.ok(asked > 0, 'git reached the server');
  for (const suffix of ['', '.helper', '.scoped']) assert.equal(await exists(marker + suffix), false, `nothing ran (${suffix || 'askpass'})`);
  assert.match(byId(report, 'D-context-base-unchecked')[0].evidence, /locked/);
});
