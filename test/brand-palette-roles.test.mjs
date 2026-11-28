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

test('OKLCH round-trips and clamps out-of-gamut chroma', () => {
  for (const hex of ['#3A6DF0', '#E86A2B', '#F7F6F2', '#0F131C', '#2E6F5E']) {
    assert.equal(color.fromOklch(...color.oklch(hex)), hex);
  }
  assert.match(color.fromOklch(0.7, 0.5, 145), HEX);
  assert.equal(color.mix('#000000', '#FFFFFF', 0), '#000000');
  assert.equal(color.mix('#000000', '#FFFFFF', 1), '#FFFFFF');
});

test('colour-vision simulation flags red vs green and passes blue vs orange', () => {
  const rg = color.cvdMinDelta('#D62728', '#2CA02C');
  assert.equal(rg.vision, 'deuteranopia');
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
      assert.deepEqual(Object.keys(r.roles), palette.ROLES);
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
});

test('a background seed that does not fit the look is ignored with a note', () => {
  const r = palette.buildPalette({ primary: '#3A6DF0', background: '#0F131C', look: 'light' });
  assert.equal(r.roles.paper, '#F7F6F2');
  assert.ok(r.notes.some((n) => n.includes('too dark for a light look')));
  assert.equal(palette.buildPalette({ primary: '#3A6DF0', background: '#FFFDF5' }).roles.paper, '#FFFDF5');
});

test('a neutral primary falls back to the default accent hue', () => {
  const r = palette.buildPalette({ primary: '#111111', look: 'light' });
  assert.ok(Math.abs(color.oklch(r.roles.accent)[2] - color.oklch('#E86A2B')[2]) < 5);
});

test('harmonies rotate the derived accent hue', () => {
  const hue = (h) => color.oklch(palette.buildPalette({ primary: '#3A6DF0', harmony: h }).roles.accent)[2];
  const base = color.oklch('#3A6DF0')[2];
  const off = (h) => (hue(h) - base + 360) % 360;
  assert.ok(Math.abs(off('complementary') - 180) < 15);
  assert.ok(Math.abs(off('triadic') - 240) < 15);
  assert.throws(() => palette.buildPalette({ primary: '#3A6DF0', harmony: 'tetradic' }));
  assert.throws(() => palette.buildPalette({ primary: '#3A6DF0', look: 'sepia' }));
  assert.throws(() => palette.buildPalette({}));
});

test('every preset passes every WCAG check', () => {
  const { presets, fonts } = palette.loadPresets();
  assert.equal(presets.length, 9);
  for (const p of presets) {
    assert.ok(fonts[p.font], `${p.key} font`);
    const r = palette.buildPalette(palette.presetInput(p.key));
    assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => c.pair), [], p.key);
    assert.ok(r.cvd.every((c) => c.same || c.ok || c.pair === 'brand vs secondary'), p.key);
  }
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
  const text = palette.toPptxText(palette.buildPalette({ primary: '#2E6F5E' }), 'Acme "deck" <x>');
  assert.match(text, /^<a:clrScheme name="Acme deck x">/);
  assert.equal((text.match(/<a:srgbClr val="[0-9A-F]{6}"\/>/g) || []).length, 12);
});

test('palette CLI: exit codes and formats', async () => {
  const ok = await cli('palette.mjs', ['--primary', '#2E6F5E', '--format', 'css']);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /--brand: #2E6F5E;/);
  assert.match(ok.stdout, /--on-deep: #/);
  const json = JSON.parse((await cli('palette.mjs', ['--preset', 'editorial'])).stdout);
  assert.equal(json.look, 'light');
  assert.equal(json.roles.brand, '#C83E2B');
  assert.equal((await cli('palette.mjs', ['--primary', 'nope'])).code, 2);
  assert.equal((await cli('palette.mjs', ['--primary', '#3A6DF0', '--evil', 'x'])).code, 2);
  assert.equal((await cli('palette.mjs', ['--preset', 'missing'])).code, 2);
});

test('contrast CLI: AA gate and bad input', async () => {
  const pass = await cli('contrast.mjs', ['#1E1D1B', '#F7F6F2']);
  assert.equal(pass.code, 0);
  assert.match(pass.stdout, /AAA/);
  assert.equal((await cli('contrast.mjs', ['#E86A2B', '#F7F6F2'])).code, 1);
  assert.equal((await cli('contrast.mjs', ['#000'])).code, 2);
  const rows = JSON.parse((await cli('contrast.mjs', ['#000', '#fff', '#fff', '#000', '--json'])).stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].wcag, 21);
});
