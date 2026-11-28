import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'inventory', 'skills', 'ui-design-tokens');
const SCRIPTS = path.join(SKILL, 'scripts');
const { wcagRatio, apcaLc, composite, checkPair } = await import(path.join(SCRIPTS, 'color.mjs'));
const { buildCss, checkTokens, flatten } = await import(path.join(SCRIPTS, 'tokens.mjs'));
const tokens = JSON.parse(await fs.readFile(path.join(SKILL, 'tokens.json'), 'utf8'));

test('WCAG ratio matches known values', () => {
  assert.equal(Math.round(wcagRatio('#000', '#fff') * 100) / 100, 21);
  assert.equal(Math.round(wcagRatio('#777777', '#ffffff') * 100) / 100, 4.48);
  assert.equal(wcagRatio('#fff', '#000'), wcagRatio('#000', '#fff'));
});

test('APCA Lc matches the apca-w3 0.0.98G reference values', () => {
  const cases = [
    ['#888888', '#ffffff', 63.06],
    ['#ffffff', '#888888', -68.54],
    ['#000000', '#aaaaaa', 58.15],
    ['#aaaaaa', '#000000', -56.24],
    ['#112233', '#ddeeff', 91.67],
  ];
  for (const [text, bg, want] of cases) {
    assert.ok(Math.abs(apcaLc(text, bg) - want) < 0.05, `${text} on ${bg}: ${apcaLc(text, bg)} != ${want}`);
  }
});

test('translucent colours are composited over the background', () => {
  const c = composite('rgba(0,0,0,.5)', '#ffffff');
  assert.deepEqual([c.r, c.g, c.b].map(Math.round), [128, 128, 128]);
  assert.throws(() => composite('#000', 'rgba(0,0,0,.5)'), /opaque/);
});

test('checkPair applies the per-use WCAG minimum', () => {
  assert.equal(checkPair('#777777', '#ffffff', 'text').pass, false);
  assert.equal(checkPair('#777777', '#ffffff', 'ui').pass, true);
  assert.throws(() => checkPair('#000', '#fff', 'body'), /unknown use/);
});

test('every colour token has a dark value', () => {
  const colours = flatten(tokens).filter((t) => t.type === 'color');
  assert.ok(colours.length > 30);
  for (const t of colours) assert.ok(t.dark !== undefined, `${t.path} has no dark value`);
});

test('the default preset passes WCAG in light and dark', () => {
  const { results, failures } = checkTokens(tokens);
  assert.ok(results.length > 100);
  assert.deepEqual(failures, []);
});

test('tokens.css is generated from tokens.json and not stale', async () => {
  const committed = await fs.readFile(path.join(SKILL, 'tokens.css'), 'utf8');
  assert.equal(committed, buildCss(tokens));
  assert.match(committed, /--surface: light-dark\(#f7f7f5, #151517\);/);
  assert.match(committed, /--edge: inset 0px 0px 0px 1px var\(--edge-color\);/);
  assert.equal((committed.match(/--ink:/g) || []).length, 1, 'dark values are not duplicated');
});

test('check CLI exits 1 on a WCAG failure and 0 on the preset', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uidt-'));
  try {
    const broken = structuredClone(tokens);
    broken.color['ink-3'].$value = '#aaaaaa';
    const file = path.join(dir, 'tokens.json');
    await fs.writeFile(file, JSON.stringify(broken));
    await assert.rejects(run('node', [path.join(SCRIPTS, 'tokens.mjs'), 'check', file, '--json']), (err) => {
      assert.equal(err.code, 1);
      const out = JSON.parse(err.stdout);
      assert.ok(out.failures.some((f) => f.fg === 'ink-3' && f.mode === 'light'));
      return true;
    });
    const ok = await run('node', [path.join(SCRIPTS, 'tokens.mjs'), 'check', '--json']);
    assert.equal(JSON.parse(ok.stdout).failures.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
