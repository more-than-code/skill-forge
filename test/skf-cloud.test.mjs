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

test('doctor does not mistake a host name such as grok-bot-box for the Grok workflow', async () => {
  const homeDir = await tempDir('skf-cloud-home-');
  const reposDir = await tempDir('skf-cloud-repos-');
  await writeFiles(reposDir, {
    'one/.git/HEAD': 'x\n',
    'one/CLAUDE.md': '@AGENTS.md\n',
    'one/AGENTS.md': '# one\n\nnodes.json: grok-bot-box has systemd false.\n'
  });
  assert.ok(!ids(await doctor(homeDir, reposDir)).includes('D-repo-restates-rules'));
  await fs.writeFile(path.join(reposDir, 'one/AGENTS.md'), '# one\n\nNo Grok or external workers.\n');
  assert.ok(ids(await doctor(homeDir, reposDir)).includes('D-repo-restates-rules'));
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
    'one/skill-forge.json': manifest({ alpha: '^0.1.0', beta: '^0.1.0' }),
    'one/.agents/skills/alpha/SKILL.md': SKILL_A,
    'one/.agents/skills/beta/SKILL.md': SKILL_B,
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
  assert.match(one.fix, /git rm the \.claude\/skills symlink and \.agents\/skills\/,.*"\/\.claude\/skills" and "\/\.agents\/skills\/"/);
  assert.match(two.evidence, /: alpha$/, 'the repo\'s own skill is not a duplicate');
  assert.match(two.fix, /keep the \.claude\/skills symlink.*git rm \.agents\/skills\/alpha\//);
  assert.match(three.fix, /keep the \.claude\/skills symlink.*git rm \.agents\/skills\/alpha\/ and/, 'an undeclared skill behind the link is kept');
  assert.doesNotMatch(three.fix, /\/\//, 'a trailing slash in the link does not double up');
});
