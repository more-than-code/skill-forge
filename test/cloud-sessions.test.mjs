import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Cloud sessions (tasks/spec-cloud-sessions.md, P0 as re-scoped by
// tasks/spec-project-thread-setup.md): the `cloud` instructions variant, which needs the
// claude-code shim and has a line budget, and the skipped-is-not-passed gate rule.

const run = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'cli.js');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
};

const END = '<!-- <<< skill-forge instructions <<< -->';
const BEGIN_CLOUD = '<!-- >>> skill-forge instructions cloud@0.1.0 >>> -->';
const CLOUD_CORE = '# Cloud core\n\nRules.\n';
const CLOUD_CLAUDE = '## Claude in this repo\n';

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

/** A registry with a `cloud` variant (needs Claude, 150-line budget). */
async function registryFixture() {
  const root = await tempDir('skf-cloud-reg-');
  await writeFiles(root, {
    'inventory/skills/.keep': '',
    'inventory/agents/variants/cloud/core.md': CLOUD_CORE,
    'inventory/agents/variants/cloud/CLAUDE.md': CLOUD_CLAUDE
  });
  const registry = {
    name: 'skill-forge-test',
    version: '0.0.0',
    schemaVersion: 1,
    skills: [],
    managedAgents: [],
    managedSubagents: [],
    managedHooks: [],
    instructionVariants: [
      {
        name: 'cloud',
        version: '0.1.0',
        description: 'Cloud rules.',
        core: 'inventory/agents/variants/cloud/core.md',
        claude: 'inventory/agents/variants/cloud/CLAUDE.md',
        requiresClaude: true,
        maxLines: 150
      }
    ]
  };
  const env = { ...process.env, ...GIT_ENV, SKILL_FORGE_ROOT: root };
  const fx = {
    root,
    registry,
    cli: (cwd, args) => run('node', [CLI, ...args], { cwd, env }),
    async writeRegistry(next) {
      await fs.writeFile(path.join(root, 'registry.json'), `${JSON.stringify(next, null, 2)}\n`);
      await fx.cli(root, ['lock']);
    }
  };
  await fx.writeRegistry(registry);
  return fx;
}

async function projectAt(dir, files = {}, { shims = ['claude-code'], instructions } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const manifest = { schemaVersion: 2, extends: [], skills: { dependencies: {}, shims } };
  if (instructions !== undefined) manifest.instructions = instructions;
  await writeFiles(dir, { 'skill-forge.json': `${JSON.stringify(manifest, null, 2)}\n`, ...files });
  return dir;
}

const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');
const exists = (p) => fs.lstat(p).then(() => true, () => false);
const readJson = async (dir, rel) => JSON.parse(await read(dir, rel));
const failsWith = async (promise, pattern) => {
  const error = await promise.then(() => null, (caught) => caught);
  assert.ok(error, 'expected a non-zero exit');
  assert.match(`${error.stdout}\n${error.stderr}`, pattern);
};

// --- cloud variant ---

test('use cloud adds the claude-code shim, writes both blocks and passes sync --check', async () => {
  const fx = await registryFixture();
  const dir = await projectAt(await tempDir('skf-cloud-'), { 'AGENTS.md': '# Mine\n' }, { shims: [] });
  const { stdout } = await fx.cli(dir, ['project', 'instructions', 'use', 'cloud']);
  assert.match(stdout, /claude-code shim/);

  const manifest = await readJson(dir, 'skill-forge.json');
  assert.deepEqual(manifest.skills.shims, ['claude-code']);
  assert.deepEqual(manifest.instructions, { variant: 'cloud', version: '^0.1.0' });
  assert.equal(await read(dir, 'AGENTS.md'), `# Mine\n\n${BEGIN_CLOUD}\n${CLOUD_CORE.trimEnd()}\n${END}\n`);
  assert.equal(await read(dir, 'CLAUDE.md'), `@AGENTS.md\n\n${BEGIN_CLOUD}\n${CLOUD_CLAUDE.trimEnd()}\n${END}\n`);
  await fx.cli(dir, ['sync', '--check']);
});

test('sync refuses a cloud variant whose profile has no claude-code shim, before writing anything', async () => {
  const fx = await registryFixture();
  const dir = await projectAt(await tempDir('skf-cloud-'), { 'AGENTS.md': '# Mine\n' }, {
    shims: [],
    instructions: { variant: 'cloud', version: '^0.1.0' }
  });
  await failsWith(fx.cli(dir, ['sync']), /cloud.*claude-code shim/s);
  assert.equal(await read(dir, 'AGENTS.md'), '# Mine\n');
  assert.equal(await exists(path.join(dir, 'skill-forge.lock.json')), false);
});

test('validate rejects a variant over its line budget and a non-boolean requiresClaude', async () => {
  const fx = await registryFixture();
  await fs.writeFile(path.join(fx.root, 'inventory/agents/variants/cloud/core.md'), 'line\n'.repeat(150));
  await failsWith(fx.cli(fx.root, ['validate']), /cloud.*151 lines.*150/s);

  await fs.writeFile(path.join(fx.root, 'inventory/agents/variants/cloud/core.md'), CLOUD_CORE);
  const next = structuredClone(fx.registry);
  next.instructionVariants[0].requiresClaude = 'yes';
  await fs.writeFile(path.join(fx.root, 'registry.json'), `${JSON.stringify(next, null, 2)}\n`);
  await failsWith(fx.cli(fx.root, ['validate']), /requiresClaude/);
});

test('the shipped cloud variant fits its budget and carries no workstation-only facilities', async () => {
  const registry = JSON.parse(await fs.readFile(path.join(REPO, 'registry.json'), 'utf8'));
  const cloud = registry.instructionVariants.find((variant) => variant.name === 'cloud');
  assert.ok(cloud, 'registry declares the cloud variant');
  assert.equal(cloud.requiresClaude, true);
  const core = await fs.readFile(path.join(REPO, cloud.core), 'utf8');
  const claude = await fs.readFile(path.join(REPO, cloud.claude), 'utf8');
  const lines = core.trimEnd().split('\n').length + claude.trimEnd().split('\n').length;
  assert.ok(lines <= 150, `cloud blocks are ${lines} lines`);
  for (const banned of [/tasks\/todo\.md/, /tasks\/lessons\.md/, /podman/i, /grok/i, /external[- ]worker/i, /~\//]) {
    assert.doesNotMatch(`${core}\n${claude}`, banned);
  }
});

test('skipped-is-not-passed ships in full, cloud and testing-strategy', async () => {
  const full = await fs.readFile(path.join(REPO, 'inventory/agents/core.md'), 'utf8');
  const cloud = await fs.readFile(path.join(REPO, 'inventory/agents/variants/cloud/core.md'), 'utf8');
  const skill = await fs.readFile(path.join(REPO, 'inventory/skills/testing-strategy/SKILL.md'), 'utf8');
  for (const text of [full, cloud]) {
    assert.match(text, /Skipped is not passed/);
    assert.match(text, /not run: <reason>/);
  }
  assert.match(skill, /### Gate the environment cannot run/);
});

test('full, then cloud, then none round-trips user prose and keeps the shim cloud added', async () => {
  const fx = await registryFixture();
  const next = structuredClone(fx.registry);
  await writeFiles(fx.root, { 'inventory/agents/core.md': '# Full core\n' });
  next.instructionVariants.unshift({ name: 'full', version: '0.1.1', description: 'Full.', core: 'inventory/agents/core.md' });
  await fx.writeRegistry(next);
  const agents = '# Mine\n\nKeep this.\n';
  const claude = '@AGENTS.md\n\n# Claude extras\n';
  const dir = await projectAt(await tempDir('skf-cloud-'), { 'AGENTS.md': agents, 'CLAUDE.md': claude });

  await fx.cli(dir, ['project', 'instructions', 'use', 'full']);
  await fx.cli(dir, ['project', 'instructions', 'use', 'cloud']);
  assert.equal(await read(dir, 'AGENTS.md'), `${agents}\n${BEGIN_CLOUD}\n${CLOUD_CORE.trimEnd()}\n${END}\n`);
  assert.equal(await read(dir, 'CLAUDE.md'), `${claude}\n${BEGIN_CLOUD}\n${CLOUD_CLAUDE.trimEnd()}\n${END}\n`);
  await fx.cli(dir, ['project', 'instructions', 'use', 'none']);
  assert.equal(await read(dir, 'AGENTS.md'), agents);
  assert.equal(await read(dir, 'CLAUDE.md'), claude);
  assert.deepEqual((await readJson(dir, 'skill-forge.json')).skills.shims, ['claude-code']);
  await fx.cli(dir, ['sync', '--check']);
});


test('claude-project-steward uses only frontmatter a claude.ai account skill accepts', async () => {
  const text = await fs.readFile(path.join(REPO, 'inventory/skills/claude-project-steward/SKILL.md'), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
  const keys = frontmatter.split('\n').filter((line) => /^[a-z-]+:/.test(line)).map((line) => line.split(':')[0]);
  const allowed = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
  assert.deepEqual(keys.filter((key) => !allowed.includes(key)), []);
  assert.match(text, /skf-cloud\.mjs/);
});
