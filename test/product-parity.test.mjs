import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO_ROOT, 'inventory', 'skills', 'product-parity', 'scripts');
const GATE = path.join(SCRIPTS, 'parity-gate.mjs');
const { columns } = await import(path.join(SCRIPTS, 'parity-columns.mjs'));

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

// A repo with a config, an empty manifest and an `out` tree. `files` maps paths under
// `parity-out` to contents; `ages` maps the same paths to an age in minutes.
async function fixture(config, files = {}, ages = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-'));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, 'parity.config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ captures: [] }));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, 'parity-out', rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, typeof body === 'string' ? body : JSON.stringify(body));
    if (ages[rel] !== undefined) {
      const t = new Date(Date.now() - ages[rel] * 60_000);
      await fs.utimes(p, t, t);
    }
  }
  return dir;
}

async function gate(cwd) {
  try {
    const { stdout } = await run('node', [GATE, '--json'], { cwd });
    return { code: 0, ...JSON.parse(stdout) };
  } catch (err) {
    if (err.code === 2) return { code: 2, stderr: err.stderr };
    return { code: err.code, ...JSON.parse(err.stdout) };
  }
}

const desktopFirst = {
  manifest: 'manifest.json',
  source: { name: 'desktop client', column: 'desktop', routes: { list: [] } },
  mirror: { name: 'iOS app', column: 'ios' },
};

test('columns default to a web source and a Flutter mirror', () => {
  assert.deepEqual(columns({}), {
    source: { id: 'web', label: 'webapp' },
    mirror: { id: 'mobile', label: 'Flutter mobile app' },
  });
});

test('columns read name and column from the source and mirror blocks', () => {
  assert.deepEqual(columns(desktopFirst), {
    source: { id: 'desktop', label: 'desktop client' },
    mirror: { id: 'ios', label: 'iOS app' },
  });
});

test('columns refuse a source and mirror that share an output column', () => {
  assert.throws(() => columns({ source: { column: 'app' }, mirror: { column: 'app' } }), /both use the column "app"/);
});

test('gate exits 2 when there is no config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-'));
  tempDirs.push(dir);
  const result = await gate(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No parity config found/);
});

test('capture validity reads the configured columns, not web/mobile', async () => {
  const dir = await fixture(
    desktopFirst,
    {
      'desktop/home.png': 'a',
      'desktop/settings.png': 'a',
      'ios/home.png': 'b',
      'findings.json': { results: [] },
    },
    { 'desktop/home.png': 180, 'desktop/settings.png': 180, 'ios/home.png': 0, 'findings.json': 0 },
  );
  const result = await gate(dir);
  const checks = result.failures.map((f) => f.check);
  assert.ok(checks.includes('duplicate-captures:desktop'), checks.join(', '));
  const skew = result.failures.find((f) => f.check === 'capture-columns-skewed');
  assert.ok(skew, checks.join(', '));
  assert.match(skew.message, /desktop client and iOS app captures/);
});

test('a11y ratchet ignores the source client semantics dump', async () => {
  const dir = await fixture(
    { manifest: 'manifest.json', source: { routes: { list: [] } } },
    {
      'semantics/home.json': { capture: 'home', nodes: [{ tappable: true, label: 'Send' }] },
      // Source dumps name nodes `name`, not `label`; counting them would report both as unlabelled.
      'semantics/home.web.json': { capture: 'home', nodes: [{ tappable: true, name: 'Send' }, { tappable: true, name: 'Menu' }] },
    },
  );
  const result = await gate(dir);
  assert.ok(result.notes.includes('a11y: 0/1 interactive controls have no accessible name'), result.notes.join('\n'));
});
