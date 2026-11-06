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

// --- i18n -----------------------------------------------------------------------------
// Writes repo files (not under parity-out) and returns the gate result.
async function i18nGate(i18n, files) {
  const dir = await fixture({ manifest: 'manifest.json', i18n });
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return gate(dir);
}

const SOURCE_TS = [
  'const en = {',
  "\tgreeting: 'Hello',",
  '\tlong_hint:',
  "\t\t'Wrapped onto its own line',",
  '\tquoted: "Let\'s go",',
  "\tjoined: 'one ' +",
  "\t\t'two',",
  '};',
  'export default en;',
].join('\n');

test('copy drift parses multi-line, double-quoted and concatenated source values', async () => {
  const result = await i18nGate(
    { sourceFile: 'en.ts', mirrorFile: 'app_en.arb' },
    {
      'en.ts': SOURCE_TS,
      'app_en.arb': { greeting: 'Hello', long_hint: 'Wrapped differently', quoted: "Let's go", joined: 'one two' },
    },
  );
  const drift = result.failures.find((f) => f.check === 'i18n-copy-drift');
  assert.ok(drift, JSON.stringify(result.failures));
  assert.deepEqual(drift.items, ['long_hint: source="Wrapped onto its own line" mirror="Wrapped differently"']);
  assert.ok(result.notes.includes('i18n: 4 shared keys compared'), result.notes.join('\n'));
});

test('a source value the parser cannot read fails instead of being excluded', async () => {
  const result = await i18nGate(
    { sourceFile: 'en.ts', mirrorFile: 'app_en.arb' },
    { 'en.ts': 'const en = {\n\tok: \'Fine\',\n\tbuilt: `Hi ${name}`,\n\tcalled: t(\'x\'),\n};', 'app_en.arb': { ok: 'Fine' } },
  );
  const unparsed = result.failures.find((f) => f.check === 'i18n-unparsed');
  assert.ok(unparsed, JSON.stringify(result.failures));
  assert.deepEqual(unparsed.items, ['en.ts: built', 'en.ts: called']);
});

const DART_MAP = `
const _localizedValues = <String, Map<String, String>>{
  'en': <String, String>{
    '@@locale': "en",
    'greeting': "Hello",
    'long_hint':
        "Wrapped onto its own line",
    'mirror_only': "Only on mobile",
  },
  'fr': <String, String>{
    '@@locale': "fr",
    'greeting': "Bonjour",
  },
};
`;

test('locale coverage fails for base-locale keys missing from another locale of the shipped map', async () => {
  const result = await i18nGate(
    { sourceFile: 'en.ts', mirrorFile: 'app_localizations.dart', mirrorFormat: 'dart-map' },
    { 'en.ts': "const en = {\n\tgreeting: 'Hello',\n\tlong_hint:\n\t\t'Wrapped onto its own line',\n};", 'app_localizations.dart': DART_MAP },
  );
  const coverage = result.failures.find((f) => f.check === 'i18n-locale-coverage');
  assert.ok(coverage, JSON.stringify(result.failures));
  // Both the ported key and the mirror-only key count: neither is shared-key drift.
  assert.deepEqual(coverage.items, ['fr: 2 missing — long_hint, mirror_only']);
  assert.equal(result.failures.find((f) => f.check === 'i18n-copy-drift'), undefined);
});

test('locale coverage reads per-locale ARB files and ratchets against a baseline', async () => {
  const files = {
    'en.ts': "const en = {\n\tgreeting: 'Hello',\n};",
    'l10n/app_en.arb': { '@@locale': 'en', greeting: 'Hello', extra: 'Extra', '@extra': { description: 'x' } },
    'l10n/app_fr.arb': { '@@locale': 'fr', greeting: 'Bonjour' },
    'l10n/app_ja.arb': { '@@locale': 'ja', greeting: 'こんにちは', extra: '追加' },
  };
  const i18n = { sourceFile: 'en.ts', mirrorFile: 'l10n/app_en.arb', mirrorLocaleFiles: 'l10n/app_{locale}.arb' };

  const failing = await i18nGate(i18n, files);
  const coverage = failing.failures.find((f) => f.check === 'i18n-locale-coverage');
  assert.ok(coverage, JSON.stringify(failing.failures));
  assert.deepEqual(coverage.items, ['fr: 1 missing — extra']);

  const passing = await i18nGate(
    { ...i18n, coverageBaseline: 'baseline.json' },
    { ...files, 'baseline.json': { missing: { fr: 1 } } },
  );
  assert.equal(passing.failures.find((f) => f.check === 'i18n-locale-coverage'), undefined);
  assert.ok(passing.notes.some((n) => n.startsWith('i18n: fr 1 missing (baseline 1)')), passing.notes.join('\n'));
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
