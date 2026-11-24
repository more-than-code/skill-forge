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
  const env = { ...process.env, HOME: homeDir, SKF_BASE: mirror.base, SKF_REF: REF, ...decl };
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
  await install(mirror, homeDir, { ...DECL, SKF_SKILLS: 'alpha' });
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
