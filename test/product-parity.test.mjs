import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'os';
import { createHash } from 'node:crypto';
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

// --- 0.10.0: freshness (M), asset parity (N), images in check K ---------------------------
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

// A source repo at <dir>/web with one UI commit `minutesAgo` minutes old.
async function sourceRepo(dir, minutesAgo, subject = 'Add brand wordmark to the header') {
  const web = path.join(dir, 'web');
  await fs.mkdir(path.join(web, 'src', 'lib'), { recursive: true });
  await fs.writeFile(path.join(web, 'src', 'lib', 'Header.svelte'), '<img alt="Brand" src="wordmark.svg">\n');
  const when = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  await run('git', ['init', '-q'], { cwd: web, env });
  await run('git', ['add', '-A'], { cwd: web, env });
  await run('git', ['commit', '-q', '-m', subject], { cwd: web, env });
}

test('freshness fails when captures predate the newest source UI commit', async () => {
  const config = { manifest: 'manifest.json', freshness: { paths: ['web/src/lib'] } };
  const dir = await fixture(config, { 'web/home.png': 'a', 'mobile/home.png': 'b' }, { 'web/home.png': 120, 'mobile/home.png': 120 });
  await sourceRepo(dir, 30);
  const stale = await gate(dir);
  const f = stale.failures.find((x) => x.check === 'captures-stale');
  assert.ok(f, JSON.stringify(stale.failures));
  assert.match(f.message, /older than 1 source commit/);
  assert.ok(f.items.some((i) => i.includes('Add brand wordmark to the header')), f.items.join('\n'));

  // Captures newer than the commit: pass, with a note saying what was compared.
  const fresh = await fixture(config, { 'web/home.png': 'a', 'mobile/home.png': 'b' }, { 'web/home.png': 5, 'mobile/home.png': 5 });
  await sourceRepo(fresh, 30);
  const ok = await gate(fresh);
  assert.equal(ok.failures.find((x) => x.check === 'captures-stale'), undefined, JSON.stringify(ok.failures));
  assert.ok(ok.notes.some((n) => n.startsWith('freshness: captures are newer than the last commit')), ok.notes.join('\n'));
});

test('asset parity fails on a source asset with no mirror counterpart, and honours a full waiver', async () => {
  const files = {
    'web/brand/wordmark.svg': '<svg/>',
    'web/brand/mark-dark.svg': '<svg/>',
    'mobile/assets/brand/wordmark.png': 'png',
  };
  const pairs = [{ name: 'brand', source: 'web/brand', mirror: 'mobile/assets/brand' }];
  const write = async (dir) => {
    for (const [rel, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), body);
    }
  };

  const failing = await fixture({ manifest: 'manifest.json', assets: { pairs } });
  await write(failing);
  const result = await gate(failing);
  const f = result.failures.find((x) => x.check === 'asset-parity:brand');
  assert.ok(f, JSON.stringify(result.failures));
  assert.deepEqual(f.items, ['mark-dark.svg']);

  const waived = await fixture({
    manifest: 'manifest.json',
    assets: { pairs, waivers: [{ asset: 'brand/mark-dark.svg', reason: 'dark mode not on mobile', owner: 'o', addedOn: '2026-11-07', removeWhen: 'mobile ships dark mode' }] },
  });
  await write(waived);
  assert.equal((await gate(waived)).failures.find((x) => x.check.startsWith('asset-parity')), undefined);

  const bare = await fixture({ manifest: 'manifest.json', assets: { pairs, waivers: [{ asset: 'brand/mark-dark.svg' }] } });
  await write(bare);
  const bad = await gate(bare);
  assert.ok(bad.failures.some((x) => x.check === 'asset-parity:waivers' && /missing: reason, owner, addedOn, removeWhen/.test(x.message)), JSON.stringify(bad.failures));
});

test('check K: a source image the mirror renders as text is a failure', async () => {
  const config = { manifest: 'manifest.json', names: { regions: [{ name: 'header', capture: 'home', y1: 0, y2: 0.2 }] } };
  const sourceDump = { nodes: [{ name: 'Brand', role: 'img', y: 0.05 }, { name: 'Menu', role: 'button', y: 0.05 }] };

  const asText = await fixture(config, {
    'semantics/home.web.json': sourceDump,
    'semantics/home.json': { nodes: [{ label: 'Brand', role: 'text', fy: 0.05 }, { label: 'Menu', role: 'button', fy: 0.05 }] },
  });
  const failing = await gate(asText);
  const f = failing.failures.find((x) => x.check === 'names:header');
  assert.ok(f, JSON.stringify(failing.failures));
  assert.match(f.message, /image on the source, text on the mirror: brand/);

  const asImage = await fixture(config, {
    'semantics/home.web.json': sourceDump,
    'semantics/home.json': { nodes: [{ label: 'Brand', isImage: true, fy: 0.05 }, { label: 'Menu', role: 'button', fy: 0.05 }] },
  });
  const passing = await gate(asImage);
  assert.equal(passing.failures.find((x) => x.check === 'names:header'), undefined, JSON.stringify(passing.failures));
  assert.ok(passing.notes.some((n) => n.includes('1 control(s) and 1 image(s) agree')), passing.notes.join('\n'));
});

// --- 0.11.0: gaps that let a restructured screen drift with a green gate -------------------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function writeRepoFiles(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, typeof body === 'string' ? body : JSON.stringify(body));
  }
}

test('i18n: a source key with no mirror counterpart fails unless listed with a reason', async () => {
  const files = {
    'en.ts': "const en = {\n\tgreeting: 'Hello',\n\tsettings_sfx: 'Sound effects',\n\tauth_web_sso: 'SSO',\n\tauth_web_magic: 'Magic link',\n};",
    'app_en.arb': { greeting: 'Hello' },
  };
  const failing = await i18nGate({ sourceFile: 'en.ts', mirrorFile: 'app_en.arb' }, files);
  const f = failing.failures.find((x) => x.check === 'i18n-source-only');
  assert.ok(f, JSON.stringify(failing.failures));
  assert.deepEqual(f.items, ['auth_web_magic', 'auth_web_sso', 'settings_sfx']);

  const listed = await i18nGate(
    { sourceFile: 'en.ts', mirrorFile: 'app_en.arb', sourceOnly: { 'auth_web_*': 'web-only sign-in', settings_sfx: '' } },
    files,
  );
  const g = listed.failures.find((x) => x.check === 'i18n-source-only');
  // A listing with no reason is not a decision, so settings_sfx still fails.
  assert.ok(g, JSON.stringify(listed.failures));
  assert.deepEqual(g.items, ['settings_sfx']);
});

test('route waivers need an owner and removeWhen, and a tracker must have an open item', async () => {
  const base = { manifest: 'manifest.json', source: { routes: { list: ['/about', '/settings'] } } };
  const full = { reason: 'web-first', date: '2026-11-05', owner: 'mobile', removeWhen: 'mobile mirrors it' };
  const setup = async (waivers, extra = {}) => {
    const dir = await fixture({ ...base, waivers: 'waivers.json' });
    await writeRepoFiles(dir, { 'waivers.json': { routes: waivers }, ...extra });
    return gate(dir);
  };

  const bare = await setup({ '/settings': { reason: 'web-first', date: '2026-11-05' }, '/about': full });
  const missing = bare.failures.find((x) => x.check === 'coverage-waivers');
  assert.ok(missing, JSON.stringify(bare.failures));
  assert.deepEqual(missing.items, ['/settings: missing owner, removeWhen']);
  assert.ok(bare.failures.some((x) => x.check === 'coverage-ratchet' && x.items.includes('/settings')), JSON.stringify(bare.failures));

  const todo = '## Auth shell\n- [x] web done\n- ON HOLD mobile\n## Settings mirror\n- [ ] mobile sections\n';
  const closed = await setup({ '/settings': { ...full, tracker: 'todo.md#Auth shell' }, '/about': { ...full, tracker: 'todo.md#Settings mirror' } }, { 'todo.md': todo });
  const t = closed.failures.find((x) => x.check === 'coverage-waivers');
  assert.ok(t, JSON.stringify(closed.failures));
  assert.deepEqual(t.items, ['/settings: tracker todo.md#Auth shell has no unchecked "- [ ]" item']);

  const gone = await setup({ '/settings': { ...full, tracker: 'todo.md#Nope' }, '/about': full }, { 'todo.md': todo });
  assert.ok(gone.failures.some((x) => x.check === 'coverage-waivers' && x.items[0].includes('no heading "Nope"')), JSON.stringify(gone.failures));

  // One gap per waiver: text that names another route is flagged.
  const bundled = await setup({
    '/about': { ...full, reason: 'shell is web-first; /settings sections also wait until mirrored' },
    '/settings': full,
  });
  assert.equal(bundled.failures.find((x) => x.check === 'coverage-waivers'), undefined, JSON.stringify(bundled.failures));
  assert.ok(bundled.notes.some((n) => n.startsWith('waiver warning: /about') && n.includes('/settings')), bundled.notes.join('\n'));
  // Bare words are prose, not a second gap: "settings" alone does not warn.
  const prose = await setup({ '/about': { ...full, reason: 'web-first; settings link styling differs' }, '/settings': full });
  assert.ok(!prose.notes.some((n) => n.startsWith('waiver warning')), prose.notes.join('\n'));
});

test('tracker parsing ignores fenced code, keeps "#" in headings, and rejects a directory', async () => {
  const base = { manifest: 'manifest.json', source: { routes: { list: ['/settings'] } }, waivers: 'waivers.json' };
  const full = { reason: 'web-first', date: '2026-11-05', owner: 'mobile', removeWhen: 'mobile mirrors it' };
  const run1 = async (tracker, todo) => {
    const dir = await fixture(base);
    await writeRepoFiles(dir, { 'waivers.json': { routes: { '/settings': { ...full, tracker } } }, 'todo.md': todo });
    await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
    return gate(dir);
  };
  const fencedComment = '## Issue #12\r\n```sh\r\n# run the capture\r\n```\r\n- [ ] mobile sections\r\n';
  const ok = await run1('todo.md#Issue #12', fencedComment);
  assert.equal(ok.failures.find((x) => x.check === 'coverage-waivers'), undefined, JSON.stringify(ok.failures));

  const fencedBox = '## Settings\n- [x] done\n```md\n- [ ] template line\n```\n';
  const closed = await run1('todo.md#Settings', fencedBox);
  assert.ok(closed.failures.some((x) => x.check === 'coverage-waivers'), JSON.stringify(closed.failures));

  const dirTracker = await run1('tasks#Settings', '');
  assert.ok(dirTracker.failures.some((x) => x.check === 'coverage-waivers' && /does not resolve/.test(x.items[0])), JSON.stringify(dirTracker.failures));
});

test('freshness and assets fail when unconfigured, unless opted out with a reason', async () => {
  const unset = await gate(await fixture({ manifest: 'manifest.json' }));
  const checks = unset.failures.map((x) => x.check);
  assert.ok(checks.includes('freshness-not-configured'), checks.join(', '));
  assert.ok(checks.includes('assets-not-configured'), checks.join(', '));

  const optedOut = await gate(
    await fixture({ manifest: 'manifest.json', freshness: { optOut: 'captures rebuilt in CI on every merge' }, assets: { optOut: 'no image assets' } }),
  );
  const after = optedOut.failures.map((x) => x.check);
  assert.ok(!after.includes('freshness-not-configured') && !after.includes('assets-not-configured'), after.join(', '));
  assert.ok(optedOut.notes.some((n) => n.startsWith('freshness: opted out — captures rebuilt in CI')), optedOut.notes.join('\n'));
  assert.ok(optedOut.notes.some((n) => n.startsWith('assets: opted out — no image assets')), optedOut.notes.join('\n'));
});

test('accepted findings are pinned to the source capture and lapse when it changes', async () => {
  const finding = { category: 'copy-mismatch', severity: 'low', summary: 'x', evidence: 'y' };
  const setup = async (accepted, sourcePng) => {
    const dir = await fixture(
      { manifest: 'manifest.json', acceptedFindings: 'accepted.json' },
      {
        'web/settings.png': sourcePng,
        'mobile/settings.png': 'm',
        'findings.json': { results: [{ id: 'settings', reviewedAt: new Date().toISOString(), findings: [finding] }] },
      },
      { 'web/settings.png': 5, 'mobile/settings.png': 5 },
    );
    await writeRepoFiles(dir, { 'accepted.json': { accepted } });
    return gate(dir);
  };

  const legacy = await setup({ settings: ['copy-mismatch'] }, 'old');
  const unpinned = legacy.failures.find((x) => x.check === 'accepted-findings-unpinned');
  assert.ok(unpinned, JSON.stringify(legacy.failures));
  assert.deepEqual(unpinned.items, [`settings: sourceSha256 ${sha256('old')}`]);

  const pinned = { settings: { categories: ['copy-mismatch'], sourceSha256: sha256('old') } };
  const same = await setup(pinned, 'old');
  const sameChecks = same.failures.map((x) => x.check);
  assert.ok(!sameChecks.includes('visual-parity-ratchet') && !sameChecks.includes('accepted-findings-lapsed'), JSON.stringify(same.failures));

  const restructured = await setup(pinned, 'new');
  const lapsed = restructured.failures.find((x) => x.check === 'accepted-findings-lapsed');
  assert.ok(lapsed, JSON.stringify(restructured.failures));
  assert.deepEqual(lapsed.items, [`settings: source capture is now ${sha256('new')}`]);
  assert.ok(restructured.failures.some((x) => x.check === 'visual-parity-ratchet'), JSON.stringify(restructured.failures));
  // The legacy form fails once but is still honoured, so it does not also re-fire the ratchet.
  assert.ok(!legacy.failures.some((x) => x.check === 'visual-parity-ratchet'), JSON.stringify(legacy.failures));
});

test('api: an endpoint neither client requested fails as a stale manifest entry', async () => {
  const dir = await fixture(
    { manifest: 'manifest.json' },
    { 'api/settings-root-user.json': { 'GET /api/me': 1 }, 'api/settings-root-user.mobile.json': { consumed: ['GET /api/me'] } },
  );
  await writeRepoFiles(dir, { 'manifest.json': { captures: [{ id: 'settings-root-user', api: ['GET /api/me', 'GET /api/usage'] }] } });
  const result = await gate(dir);
  const f = result.failures.find((x) => x.check === 'api-parity:settings-root-user');
  assert.ok(f, JSON.stringify(result.failures));
  assert.match(f.message, /requested by NEITHER client/);

  // Asymmetric: each client skipped a different endpoint. Neither is a stale declaration.
  const asym = await fixture(
    { manifest: 'manifest.json' },
    { 'api/s.json': { 'GET /a': 1 }, 'api/s.mobile.json': { consumed: ['GET /b'] } },
  );
  await writeRepoFiles(asym, { 'manifest.json': { captures: [{ id: 's', api: ['GET /a', 'GET /b'] }] } });
  const msgs = (await gate(asym)).failures.filter((x) => x.check === 'api-parity:s').map((x) => x.message);
  assert.equal(msgs.length, 2, msgs.join('\n'));
  assert.ok(msgs.every((m) => !/NEITHER/.test(m)), msgs.join('\n'));
});

test('freshness and assets fail when a configured path resolves to nothing', async () => {
  const result = await gate(
    await fixture({
      manifest: 'manifest.json',
      freshness: { paths: ['web/src/lib-typo'] },
      assets: { pairs: [{ name: 'brand', source: 'web/brand-typo', mirror: 'mobile/assets/brand' }] },
    }),
  );
  const checks = result.failures.map((x) => x.check);
  assert.ok(checks.includes('freshness-unresolved'), checks.join(', '));
  assert.ok(checks.includes('assets-unresolved:brand'), checks.join(', '));
});

// --- 0.12.0: the API bag contract -----------------------------------------------------------
test('api bags: only the documented marker may stand in for a body, and never on a 2xx read', async () => {
  const marker = (kind, status) => ({ _parity: { kind, status, reason: 'r' } });
  const dir = await fixture(
    { manifest: 'manifest.json' },
    {
      'api/home.json': {
        'GET /api/me': { name: 'Ana' },
        'GET /api/tips': marker('stub', 0),
        'GET /api/feed': marker('error', 503),
        'GET /api/app-build': marker('error', 200),
      },
      'api/settings.json': {
        'GET /api/a': { _parity_error: 'json_parse_failed', status: 200 },
        'GET /api/b': { __status: 404 },
        'GET /api/c': { _parity_non_json: true, status: 200, contentType: 'text/html' },
        'GET /api/d': { _parity: { kind: 'oops', status: 500 } },
      },
      // The mirror's record has its own shape and is not a bag.
      'api/home.mobile.json': { consumed: ['GET /api/me'] },
    },
  );
  const result = await gate(dir);
  const shape = result.failures.find((x) => x.check === 'api-bag');
  assert.ok(shape, JSON.stringify(result.failures));
  assert.deepEqual(shape.items, ['settings: GET /api/a', 'settings: GET /api/b', 'settings: GET /api/c', 'settings: GET /api/d']);
  const read = result.failures.find((x) => x.check === 'api-bag:2xx-error');
  assert.ok(read, JSON.stringify(result.failures));
  assert.deepEqual(read.items, ['home: GET /api/app-build (status 200)']);
  assert.ok(result.notes.some((n) => n.startsWith('api bags: 3 marker(s) across 1 capture(s)')), result.notes.join('\n'));
});
