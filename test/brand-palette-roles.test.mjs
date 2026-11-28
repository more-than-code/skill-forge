import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO_ROOT, 'inventory', 'skills', 'brand-palette-roles', 'scripts');
const color = await import(path.join(SCRIPTS, 'color.mjs'));
const palette = await import(path.join(SCRIPTS, 'palette.mjs'));

const HEX = /^#[0-9A-F]{6}$/;

async function cli(script, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [path.join(SCRIPTS, script), ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test('WCAG 2.2 contrast ratio matches known values', () => {
  assert.equal(color.contrastRatio('#000000', '#FFFFFF'), 21);
  assert.equal(color.contrastRatio('#FFFFFF', '#000000'), 21);
  assert.equal(color.contrastRatio('#777777', '#FFFFFF').toFixed(2), '4.48');
  assert.equal(color.contrastRatio('#3A6DF0', '#3A6DF0'), 1);
});

test('APCA Lc matches the APCA-W3 reference values', () => {
  assert.equal(color.apcaLc('#000000', '#FFFFFF').toFixed(2), '106.04');
  assert.equal(color.apcaLc('#FFFFFF', '#000000').toFixed(2), '-107.88');
  assert.equal(color.apcaLc('#888888', '#FFFFFF').toFixed(2), '63.06');
  assert.equal(color.apcaLc('#FFFFFF', '#888888').toFixed(2), '-68.54');
  assert.equal(color.apcaLc('#808080', '#808080'), 0);
});

test('hex parsing accepts #rgb and #rrggbb and rejects anything else', () => {
  assert.equal(color.normHex('#abc'), '#AABBCC');
  assert.equal(color.normHex('3a6df0'), '#3A6DF0');
  for (const bad of ['', '#12345', 'red', '#GGGGGG', 'url(x)']) assert.throws(() => color.normHex(bad));
});

test('OKLCH matches known values for red and white', () => {
  const [L, C, h] = color.oklch('#FF0000');
  assert.ok(Math.abs(L - 0.628) < 0.001 && Math.abs(C - 0.2577) < 0.001 && Math.abs(h - 29.23) < 0.05);
  assert.ok(Math.abs(color.oklch('#FFFFFF')[0] - 1) < 1e-6);
});

test('OKLCH round-trips and clamps out-of-gamut chroma', () => {
  for (const hex of ['#3A6DF0', '#E86A2B', '#F7F6F2', '#0F131C', '#2E6F5E']) {
    assert.equal(color.fromOklch(...color.oklch(hex)), hex);
  }
  const clamped = color.fromOklch(0.7, 0.5, 145);
  assert.match(clamped, HEX);
  const [L, C, h] = color.oklch(clamped);
  assert.ok(Math.abs(L - 0.7) < 0.01 && Math.abs(h - 145) < 2 && C < 0.5);
  assert.equal(color.mix('#000000', '#FFFFFF', 0), '#000000');
  assert.equal(color.mix('#000000', '#FFFFFF', 1), '#FFFFFF');
});

test('colour-vision simulation flags red vs green and passes blue vs orange', () => {
  const rg = color.cvdMinDelta('#D62728', '#2CA02C');
  assert.ok(color.CVD_TYPES.includes(rg.vision));
  assert.ok(rg.delta < palette.CVD_MIN_DELTA);
  assert.ok(color.cvdMinDelta('#1F77B4', '#FF7F0E').delta >= palette.CVD_MIN_DELTA);
});

const SEED_SETS = [
  { primary: '#3A6DF0' },
  { primary: '#2E6F5E', accent: '#E86A2B' },
  { primary: '#FFE14D' }, // very pale
  { primary: '#00FF00' }, // very saturated
  { primary: '#111111' }, // one dark neutral colour
  { primary: '#F0F0F0' }, // one pale neutral colour
  { primary: '#D62728', secondary: '#2CA02C', accent: '#FFD400', background: '#FFFDF5' },
];

test('every seed set gives 11 hex roles and passes every WCAG check in both looks', () => {
  for (const seeds of SEED_SETS) {
    for (const look of ['light', 'dark']) {
      const r = palette.buildPalette({ ...seeds, look });
      assert.deepEqual(Object.keys(r.roles), ['brand', 'secondary', 'accent', 'deep', 'paper', 'soft', 'card', 'line', 'tint', 'ink', 'ink-2']);
      assert.ok(color.deltaE(r.roles.deep, r.roles.paper) >= palette.DEEP_MIN_DELTA, `${JSON.stringify(seeds)} ${look}: deep vs paper`);
      assert.ok(color.contrastRatio(palette.pptxSlots(r).slots.hlink, r.roles.paper) >= 4.5, `${JSON.stringify(seeds)} ${look}: hlink`);
      for (const v of Object.values(r.roles)) assert.match(v, HEX);
      const failed = r.checks.filter((c) => !c.pass).map((c) => c.pair);
      assert.deepEqual(failed, [], `${JSON.stringify(seeds)} ${look}`);
      for (const c of r.checks) assert.ok(c.apcaOk, `${JSON.stringify(seeds)} ${look}: ${c.pair} APCA ${c.apca}`);
    }
  }
});

test('a weak seed is moved, keeping its hue, and the move is noted', () => {
  const r = palette.buildPalette({ primary: '#FFE14D', look: 'light' });
  assert.notEqual(r.roles.brand, '#FFE14D');
  assert.ok(Math.abs(color.oklch(r.roles.brand)[2] - color.oklch('#FFE14D')[2]) < 5);
  assert.ok(r.notes.some((n) => n.startsWith('brand #FFE14D moved')));
  const d = palette.buildPalette({ primary: '#1B2A6B', accent: '#2A1B0B', look: 'dark' });
  assert.ok(color.oklch(d.roles.brand)[0] > color.oklch('#1B2A6B')[0]);
  assert.ok(d.notes.some((n) => n.startsWith('brand #1B2A6B moved')));
  assert.ok(d.notes.some((n) => n.startsWith('accent #2A1B0B moved')));
  const kept = palette.buildPalette({ primary: '#3A6DF0', look: 'light' });
  assert.equal(kept.roles.brand, '#3A6DF0');
  assert.ok(!kept.notes.some((n) => n.startsWith('brand')));
});

test('a background seed that does not fit the look is ignored with a note', () => {
  const r = palette.buildPalette({ primary: '#3A6DF0', background: '#0F131C', look: 'light' });
  assert.equal(r.roles.paper, '#F7F6F2');
  assert.ok(r.notes.some((n) => n.includes('too dark for a light look')));
  assert.equal(palette.buildPalette({ primary: '#3A6DF0', background: '#FFFDF5' }).roles.paper, '#FFFDF5');
  const pale = palette.buildPalette({ primary: '#3A6DF0', background: '#FFFDF5', look: 'dark' });
  assert.equal(pale.roles.paper, '#0F131C');
  assert.ok(pale.notes.some((n) => n.includes('too light for a dark look')));
  const own = palette.buildPalette({ primary: '#3A6DF0', background: '#15100E', look: 'dark' });
  assert.equal(own.roles.paper, '#15100E');
  assert.ok(!own.notes.some((n) => n.startsWith('background')));
  for (const look of ['light', 'dark']) {
    const grey = palette.buildPalette({ primary: '#3A6DF0', background: '#808080', look });
    assert.notEqual(grey.roles.paper, '#808080', look);
  }
});

test('a neutral primary falls back to the default accent hue and a lightness-step secondary', () => {
  for (const primary of ['#111111', '#F0F0F0']) {
    for (const look of ['light', 'dark']) {
      const r = palette.buildPalette({ primary, look });
      assert.ok(Math.abs(color.oklch(r.roles.accent)[2] - color.oklch('#E86A2B')[2]) < 5, `${primary} ${look}`);
      assert.notEqual(color.oklch(r.roles.secondary)[0].toFixed(3), color.oklch(r.roles.brand)[0].toFixed(3));
      assert.ok(r.notes.some((n) => n.includes('neutral primary')));
    }
  }
  // Just above the neutral cut-off, the harmony applies.
  const tinted = palette.buildPalette({ primary: '#6E6A80' });
  assert.ok(color.oklch('#6E6A80')[1] > 0.03);
  assert.ok(tinted.notes.some((n) => n.startsWith('accent derived (split')));
});

test('harmonies set the derived secondary and accent hues', () => {
  const base = color.oklch('#2E6F5E')[2];
  const off = (hex) => (color.oklch(hex)[2] - base + 360) % 360;
  const near = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) < 3;
  for (const [h, [sec, acc]] of Object.entries(palette.HARMONIES)) {
    for (const look of ['light', 'dark']) {
      const r = palette.buildPalette({ primary: '#2E6F5E', harmony: h, look });
      assert.ok(near(off(r.roles.secondary), (sec + 360) % 360), `${h} ${look} secondary ${off(r.roles.secondary)}`);
      assert.ok(near(off(r.roles.accent), (acc + 360) % 360), `${h} ${look} accent ${off(r.roles.accent)}`);
    }
  }
  assert.equal(palette.buildPalette({ primary: '#2E6F5E' }).harmony, 'split');
  assert.throws(() => palette.buildPalette({ primary: '#3A6DF0', look: 'constructor' }), /look must be/);
  assert.throws(() => palette.buildPalette({ primary: '#3A6DF0', harmony: 'toString' }), /harmony must be/);
  assert.throws(() => palette.buildPalette({ primary: '#3A6DF0', harmony: 'tetradic' }));
  assert.throws(() => palette.buildPalette({ primary: '#3A6DF0', look: 'sepia' }));
  assert.throws(() => palette.buildPalette({}));
});

test('every preset passes every WCAG check and reports its one-accent look as same', () => {
  const { presets, fonts } = palette.loadPresets();
  assert.ok(presets.some((p) => p.key === 'default'));
  for (const p of presets) {
    assert.ok(fonts[p.font], `${p.key} font`);
    const r = palette.buildPalette(palette.presetInput(p.key));
    assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => c.pair), [], p.key);
    const brandAccent = r.cvd.find((c) => c.pair === 'brand vs accent');
    if (p.seeds.accent === p.seeds.primary) assert.equal(brandAccent.same, true, p.key);
    else assert.ok(!brandAccent.same && brandAccent.ok, p.key);
  }
  assert.deepEqual(palette.presetDetails('editorial').font.pptx, 'SimSun');
  assert.ok(palette.presetDetails('editorial').imagePrompt.length > 0);
});

test('a preset with the brand primary derives secondary and accent from it', () => {
  const input = palette.presetInput('cinematic', { ownPrimary: true });
  assert.deepEqual(Object.keys(input).sort(), ['background', 'look']);
  const r = palette.buildPalette({ ...input, primary: '#B0463A' });
  assert.equal(r.roles.paper, '#15100E');
  assert.ok(r.notes.some((n) => n.startsWith('accent derived')));
});

test('cvdChecks reports same colours as same and flags close pairs', () => {
  const same = palette.cvdChecks({ brand: '#3A6DF0', secondary: '#3A6DF0', accent: '#E86A2B' });
  assert.deepEqual(same.find((c) => c.pair === 'brand vs secondary'), { pair: 'brand vs secondary', same: true, ok: true });
  const close = palette.cvdChecks({ brand: '#1F77B4', secondary: '#D62728', accent: '#2CA02C' });
  const rg = close.find((c) => c.pair === 'secondary vs accent');
  assert.equal(rg.ok, false);
  assert.ok(color.CVD_TYPES.includes(rg.worstVision));
  // Derived colours stay apart from a strongly coloured primary.
  const derived = palette.buildPalette({ primary: '#D62728' });
  assert.ok(derived.cvd.every((c) => c.ok), JSON.stringify(derived.cvd));
});

test('PowerPoint slots keep dk1 darker than lt1 in both looks', () => {
  for (const look of ['light', 'dark']) {
    const r = palette.buildPalette({ primary: '#2E6F5E', look });
    const { slots, clrMap } = palette.pptxSlots(r);
    assert.deepEqual(Object.keys(slots), ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']);
    assert.ok(color.luminance(slots.dk1) < color.luminance(slots.lt1));
    assert.equal(slots.accent1, r.roles.brand);
    assert.match(clrMap, look === 'light' ? /bg1="lt1"/ : /bg1="dk1"/);
  }
  const r = palette.buildPalette({ primary: '#2E6F5E' });
  const text = palette.toPptxText(r, 'Acme "deck" <x>');
  assert.match(text, /^<a:clrScheme name="Acme deck x">/);
  assert.equal((text.match(/<a:srgbClr val="[0-9A-F]{6}"\/>/g) || []).length, 12);
  assert.match(palette.toPptxText(r, 'A&B<script>'), /name="ABscript"/);
  assert.match(palette.toPptxText(r, '"<>'), /name="Brand palette"/);
  assert.match(palette.toPptxText(r, '品牌 色板'), /name="品牌 色板"/);
  assert.match(palette.toPptxText(r, 'x'.repeat(80)), new RegExp(`name="${'x'.repeat(60)}"`));
  for (const k of ['accent4', 'accent5', 'accent6']) assert.ok(color.contrastRatio(palette.pptxSlots(r).slots[k], r.roles.paper) >= 3, k);
});

test('palette CLI: exit codes and formats', async () => {
  const ok = await cli('palette.mjs', ['--primary', '#2E6F5E', '--format', 'css']);
  assert.equal(ok.code, 0);
  for (const role of [...palette.ROLES, 'on-deep']) assert.match(ok.stdout, new RegExp(`--${role}: #[0-9A-F]{6};`));
  assert.match(ok.stdout, /color-scheme: light;/);
  assert.match(palette.toCss(palette.buildPalette({ primary: '#2E6F5E', look: 'dark' }), 'x-'), /color-scheme: dark;[\s\S]*--x-ink-2: /);
  const json = JSON.parse((await cli('palette.mjs', ['--preset', 'editorial'])).stdout);
  assert.equal(json.look, 'light');
  assert.equal(json.preset.font.key, 'song');
  assert.equal(json.css, palette.toCss(palette.buildPalette(palette.presetInput('editorial'))));
  const pptx = await cli('palette.mjs', ['--preset', 'editorial', '--format', 'pptx']);
  assert.match(pptx.stdout, /^<a:clrScheme name="editorial">/);
  assert.match((await cli('palette.mjs', ['--help'])).stdout, /^usage:/);
  for (const [args, msg] of [
    [['--primary', 'nope'], /not a hex colour/],
    [['--primary', '#3A6DF0', '--evil', 'x'], /unknown argument/],
    [['--preset', 'missing'], /unknown preset/],
    [[], /primary is required/],
    [['--primary', '#3A6DF0', '--look', 'sepia'], /look must be/],
    [['--primary', '#3A6DF0', '--format', 'xml'], /format must be/],
  ]) {
    const r = await cli('palette.mjs', args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, msg);
    assert.equal(r.stdout, '');
  }
});

test('contrast CLI: AA gate and bad input', async () => {
  const pass = await cli('contrast.mjs', ['#1E1D1B', '#F7F6F2']);
  assert.equal(pass.code, 0);
  assert.match(pass.stdout, /AAA/);
  assert.equal((await cli('contrast.mjs', ['#E86A2B', '#F7F6F2'])).code, 1);
  assert.equal((await cli('contrast.mjs', ['#767676', '#FFFFFF'])).code, 0);
  const below = await cli('contrast.mjs', ['#777777', '#FFFFFF']);
  assert.equal(below.code, 1);
  assert.match(below.stdout, /4\.47:1 \(AA large\/non-text only\)/);
  assert.equal((await cli('contrast.mjs', ['#000'])).code, 2);
  assert.equal((await cli('contrast.mjs', ['--json'])).code, 2);
  const bad = await cli('contrast.mjs', ['nope', '#fff']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not a hex colour/);
  const rows = JSON.parse((await cli('contrast.mjs', ['#000', '#fff', '#fff', '#000', '--json'])).stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].wcag, 21);
  assert.equal(rows[1].wcag, 21);
  assert.ok(rows[1].apca < 0);
});
