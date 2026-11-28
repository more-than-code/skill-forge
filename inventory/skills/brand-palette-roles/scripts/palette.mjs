#!/usr/bin/env node
// Seeds + look in, 11 palette roles out, with contrast and colour-blind checks.
//
//   node palette.mjs --primary '#2E6F5E' [--secondary HEX] [--accent HEX] [--background HEX]
//                    [--look light|dark] [--harmony split|complementary|analogous|triadic]
//                    [--preset KEY] [--format json|css|pptx] [--name TEXT] [--prefix NAME-]
//
// Exit 0 when every WCAG check passes, 1 when one fails, 2 on bad input.
// Dependency-free; Node 18+.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normHex, oklch, fromOklch, mix, deltaE, contrastRatio, apcaLc, cvdMinDelta, isMain } from './color.mjs';

export const ROLES = ['brand', 'secondary', 'accent', 'deep', 'paper', 'soft', 'card', 'line', 'tint', 'ink', 'ink-2'];

// Hue offsets in OKLCH degrees for derived seeds: [secondary, accent].
// The secondary stays a near neighbour of the primary except in triadic; the harmony mostly picks the accent.
export const HARMONIES = {
  split: [30, 150],
  complementary: [30, 180],
  analogous: [30, -30],
  triadic: [120, 240],
};

// Fallback accent for a neutral (near-grey) primary, where rotating the hue gives nothing.
const NEUTRAL_ACCENT = '#E86A2B';
const NEUTRAL_CHROMA = 0.03;

// Per look: default canvas and text, the colour surfaces mix toward, the near-black deep is mixed
// toward, the share of that mix, and the OKLCH lightness a background seed must have to be the canvas.
const LOOKS = {
  light: { paper: '#F7F6F2', ink: '#1E1D1B', ink2: '#635F59', surfaceMix: '#1D1C1A', deepMix: '#141519', deepShare: 0.78, paperOk: (L) => L >= 0.9 },
  dark: { paper: '#0F131C', ink: '#F3F2EE', ink2: '#A7B0C0', surfaceMix: '#FFFFFF', deepMix: '#07090E', deepShare: 0.7, paperOk: (L) => L <= 0.3 },
};

// Minimum OKLab distance between deep and paper, so an emphasis band reads as a band.
export const DEEP_MIN_DELTA = 0.04;

// Targets: WCAG 2.2 minimum (the gate) and APCA |Lc| (also met by the guards, reported as a second check).
export const TARGETS = {
  body: { wcag: 4.5, apca: 75 },
  secondaryText: { wcag: 4.5, apca: 60 },
  nonText: { wcag: 3, apca: 45 },
};
export const CVD_MIN_DELTA = 0.08;

const meets = (fg, bg, t) => contrastRatio(fg, bg) >= t.wcag && Math.abs(apcaLc(fg, bg)) >= t.apca;

// Move a colour's OKLCH lightness, keeping hue (chroma drops only to stay in gamut), until it meets
// target `t` on every background. Darkens on a light canvas, lightens on a dark one.
export function guard(hex, bgs, t, dark) {
  if (bgs.every((bg) => meets(hex, bg, t))) return hex;
  const [L, C, h] = oklch(hex);
  const dir = dark ? 1 : -1;
  for (let step = 1; step <= 100; step++) {
    const next = fromOklch(L + dir * step * 0.01, C, h);
    if (bgs.every((bg) => meets(next, bg, t))) return next;
  }
  return dark ? '#FFFFFF' : '#000000';
}

const rotate = (hex, deg, chromaScale = 1, dL = 0) => {
  const [L, C, h] = oklch(hex);
  return fromOklch(L + dL, C * chromaScale, (h + deg + 360) % 360);
};

// mix(a, b, t) for t stepping from `from` to `to` in hundredths; the first that passes `ok`, else the last.
function firstMix(a, b, from, to, ok) {
  const start = Math.round(from * 100);
  const end = Math.round(to * 100);
  const step = end >= start ? 1 : -1;
  for (let i = start; ; i += step) {
    const c = mix(a, b, i / 100);
    if (ok(c) || i === end) return c;
  }
}

const cvdOk = (a, b) => cvdMinDelta(a, b).delta >= CVD_MIN_DELTA;

export function buildPalette(input) {
  const look = input.look ?? 'light';
  if (!Object.hasOwn(LOOKS, look)) throw new Error(`look must be light or dark, not ${JSON.stringify(look)}`);
  const harmony = input.harmony ?? 'split';
  if (!Object.hasOwn(HARMONIES, harmony)) throw new Error(`harmony must be one of ${Object.keys(HARMONIES).join(', ')}`);
  if (!input.primary) throw new Error('primary is required');
  const dark = look === 'dark';
  const D = LOOKS[look];
  const seeds = {
    primary: normHex(input.primary),
    secondary: input.secondary ? normHex(input.secondary) : null,
    accent: input.accent ? normHex(input.accent) : null,
    background: input.background ? normHex(input.background) : null,
  };
  const notes = [];

  // 1. Canvas. A background seed that does not fit the look is ignored, never forced.
  let paper = D.paper;
  if (seeds.background) {
    if (D.paperOk(oklch(seeds.background)[0])) paper = seeds.background;
    else notes.push(`background ${seeds.background} is too ${dark ? 'light' : 'dark'} for a ${look} look; using ${paper}`);
  }

  // 2. Surfaces: fixed mixes of paper with ink (light) or white (dark), in OKLab.
  const soft = mix(paper, D.surfaceMix, dark ? 0.06 : 0.045);
  const card = mix(paper, '#FFFFFF', dark ? 0.1 : 0.65);
  const line = mix(paper, D.surfaceMix, dark ? 0.15 : 0.12);
  const textBgs = [paper, soft, card];

  // 3. Text: the look's warm neutrals, pushed further only when a surface needs it.
  const ink = guard(D.ink, textBgs, TARGETS.body, dark);
  const ink2 = guard(D.ink2, textBgs, TARGETS.secondaryText, dark);

  // 4. Seeds: given ones are kept unless too weak on paper; missing ones come from the harmony.
  const onPaper = (c) => guard(c, [paper], TARGETS.nonText, dark);
  const fix = (name, raw) => {
    const out = onPaper(raw);
    if (out !== raw) notes.push(`${name} ${raw} moved to ${out} to reach 3:1 and APCA 45 on paper`);
    return out;
  };
  const brand = fix('brand', seeds.primary);
  const neutral = oklch(seeds.primary)[1] < NEUTRAL_CHROMA;
  const [secOff, accOff] = HARMONIES[harmony];

  // Derived seeds try the harmony hue at a few lightness steps and keep the first that stays apart
  // from the colours already chosen under simulated colour-vision deficiency, else the furthest apart.
  const pickApart = (base, others) => {
    const L0 = oklch(base)[0];
    const tries = [0, 0.08, -0.08, 0.16, -0.16, 0.24, -0.24]
      .filter((dL) => dL === 0 || (L0 + dL > 0.05 && L0 + dL < 0.97)) // past the ends, chroma collapses to grey
      .map((dL) => onPaper(rotate(base, 0, 1, dL)));
    // The guard pulls failing steps back to the same passing colour; try each colour once.
    const unique = [...new Set(tries)];
    const score = (c) => Math.min(...others.map((o) => cvdMinDelta(c, o).delta));
    return unique.find((c) => others.every((o) => cvdOk(c, o))) ?? unique.reduce((a, b) => (score(b) > score(a) ? b : a));
  };

  let secondary;
  if (seeds.secondary) secondary = fix('secondary', seeds.secondary);
  else {
    // A derived secondary is a quieter partner: 80% of the primary's chroma. A derived accent keeps it all.
    secondary = pickApart(neutral ? rotate(brand, 0, 1, dark ? -0.2 : 0.2) : rotate(seeds.primary, secOff, 0.8), [brand]);
    notes.push(`secondary derived (${neutral ? 'neutral primary: lightness step' : `${harmony}, ${secOff} deg`}): ${secondary}`);
  }

  let accent;
  if (seeds.accent) accent = fix('accent', seeds.accent);
  else {
    accent = pickApart(neutral ? NEUTRAL_ACCENT : rotate(seeds.primary, accOff), [brand, secondary]);
    notes.push(`accent derived (${neutral ? 'neutral primary: default accent' : `${harmony}, ${accOff} deg`}): ${accent}`);
  }

  // 5. Emphasis and soft-primary surfaces, tuned by mix share rather than lightness.
  // Deep: brand mixed toward near-black, from the look's share up until text on it passes and it
  // stands apart from paper. Text on deep is paper (light look) or ink (dark look).
  const onDeep = dark ? ink : paper;
  const deepOk = (c) => meets(onDeep, c, TARGETS.body) && deltaE(c, paper) >= DEEP_MIN_DELTA;
  const deep = firstMix(brand, D.deepMix, D.deepShare, 1, deepOk);
  // Tint: paper mixed toward brand, from 14% (light) or 20% (dark) down until ink on it passes.
  const tint = firstMix(paper, brand, dark ? 0.2 : 0.14, 0, (c) => meets(ink, c, TARGETS.body));

  const roles = { brand, secondary, accent, deep, paper, soft, card, line, tint, ink, 'ink-2': ink2 };
  const result = { look, harmony, seeds, roles, onDeep, checks: runChecks(roles, onDeep), cvd: cvdChecks(roles), notes };
  if (deltaE(deep, paper) < DEEP_MIN_DELTA) notes.push(`deep ${deep} is close to paper; use a line or a card edge to mark the band`);
  return result;
}

export function runChecks(roles, onDeep) {
  const rows = [
    ['ink', 'paper', 'body'], ['ink', 'card', 'body'], ['ink', 'soft', 'body'], ['ink', 'tint', 'body'],
    ['ink-2', 'paper', 'secondaryText'], ['ink-2', 'card', 'secondaryText'], ['ink-2', 'soft', 'secondaryText'],
    ['brand', 'paper', 'nonText'], ['secondary', 'paper', 'nonText'], ['accent', 'paper', 'nonText'],
    ['on-deep', 'deep', 'body'],
  ];
  return rows.map(([fg, bg, kind]) => {
    const t = TARGETS[kind];
    const f = fg === 'on-deep' ? onDeep : roles[fg];
    const b = roles[bg];
    const wcag = contrastRatio(f, b);
    const lc = apcaLc(f, b);
    return {
      pair: `${fg} on ${bg}`, fg: f, bg: b, kind,
      wcag: Math.floor(wcag * 100) / 100, wcagMin: t.wcag, pass: wcag >= t.wcag,
      apca: Number(lc.toFixed(1)), apcaTarget: t.apca, apcaOk: Math.abs(lc) >= t.apca,
      bodyTextOk: wcag >= 4.5,
    };
  });
}

// Pairs that must stay apart under colour-vision deficiency. Two roles that are the same colour on
// purpose (a one-accent look, where accent repeats brand) are reported as "same" and not flagged.
export function cvdChecks(roles) {
  return [['secondary', 'accent'], ['brand', 'accent'], ['brand', 'secondary']].map(([a, b]) => {
    if (roles[a] === roles[b]) return { pair: `${a} vs ${b}`, same: true, ok: true };
    const { vision, delta } = cvdMinDelta(roles[a], roles[b]);
    return { pair: `${a} vs ${b}`, worstVision: vision, deltaE: Number(delta.toFixed(3)), min: CVD_MIN_DELTA, ok: delta >= CVD_MIN_DELTA };
  });
}

export function toCss(result, prefix = '') {
  const lines = ROLES.map((r) => `  --${prefix}${r}: ${result.roles[r]};`);
  lines.push(`  --${prefix}on-deep: ${result.onDeep};`);
  return `:root {\n  color-scheme: ${result.look};\n${lines.join('\n')}\n}\n`;
}

// PowerPoint theme colour slots (a:clrScheme in ppt/theme/theme1.xml).
// dk1/lt1 are always the darker/lighter text-and-canvas pair; a dark deck maps bg1 to dk1 in the master.
export function pptxSlots(result) {
  const r = result.roles;
  const light = result.look === 'light';
  const chartShade = (c) => guard(mix(c, r.ink, 0.35), [r.paper], TARGETS.nonText, !light);
  const slots = {
    dk1: light ? r.ink : r.paper,
    lt1: light ? r.paper : r.ink,
    dk2: light ? r.deep : r.soft,
    lt2: light ? r.soft : r['ink-2'],
    accent1: r.brand, accent2: r.secondary, accent3: r.accent,
    // Chart series 4-6: brand, secondary and accent shifted toward ink, still 3:1 on paper.
    accent4: chartShade(r.brand), accent5: chartShade(r.secondary), accent6: chartShade(r.accent),
    // Links are body-size text: the brand when it reaches body contrast, else the brand moved until it does.
    hlink: guard(r.brand, [r.paper], TARGETS.body, !light),
    folHlink: guard(r.secondary, [r.paper], TARGETS.body, !light),
  };
  const clrMap = light ? 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"' : 'bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"';
  return { slots, clrMap };
}

export function toPptxText(result, name = 'Brand palette') {
  const { slots, clrMap } = pptxSlots(result);
  const safe = String(name).replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 60) || 'Brand palette';
  const body = Object.entries(slots).map(([k, v]) => `  <a:${k}><a:srgbClr val="${v.slice(1)}"/></a:${k}>`).join('\n');
  const accents = [1, 2, 3, 4, 5, 6].map((n) => `accent${n}="accent${n}"`).join(' ');
  return `<a:clrScheme name="${safe}">\n${body}\n</a:clrScheme>\n<!-- slide master: <p:clrMap ${clrMap} ${accents} hlink="hlink" folHlink="folHlink"/> -->\n`;
}

export function loadPresets() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(path.join(here, '..', 'presets.json'), 'utf8'));
}

function findPreset(key) {
  const all = loadPresets();
  const p = all.presets.find((x) => x.key === key);
  if (!p) throw new Error(`unknown preset ${JSON.stringify(key)}`);
  return { p, fonts: all.fonts };
}

// A preset's seeds and look, as buildPalette input. With the brand's own primary, the preset's
// secondary and accent (tuned to the preset's primary) are dropped so they derive from the brand;
// the preset keeps the look and background.
export function presetInput(key, { ownPrimary = false } = {}) {
  const { p } = findPreset(key);
  const { primary, secondary, accent, background } = p.seeds;
  return ownPrimary ? { background, look: p.look } : { primary, secondary, accent, background, look: p.look };
}

// The rest of a preset (font with its CSS stack and PowerPoint name, image prompt, backgrounds).
export function presetDetails(key) {
  const { p, fonts } = findPreset(key);
  const { seeds, ...rest } = p;
  return { ...rest, font: { key: p.font, ...fonts[p.font] } };
}

const OPTIONS = new Set(['primary', 'secondary', 'accent', 'background', 'look', 'harmony', 'preset', 'format', 'name', 'prefix']);
// A CSS custom-property prefix such as `deck-`, so the roles never redefine an app's own tokens.
const PREFIX = /^[a-z][a-z0-9-]{0,23}$/;
const USAGE = 'usage: palette.mjs --primary HEX [--secondary HEX] [--accent HEX] [--background HEX] [--look light|dark] [--harmony split|complementary|analogous|triadic] [--preset KEY] [--format json|css|pptx] [--name TEXT] [--prefix NAME-]\n';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    const key = a.startsWith('--') ? a.slice(2) : null;
    if (!key || !OPTIONS.has(key)) throw new Error(`unknown argument: ${JSON.stringify(a)}`);
    const val = argv[++i];
    if (val === undefined) throw new Error(`${a} needs a value`);
    out[key] = val;
  }
  return out;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return void process.stdout.write(USAGE);
    const input = args.preset ? presetInput(args.preset, { ownPrimary: Boolean(args.primary) }) : {};
    for (const k of ['primary', 'secondary', 'accent', 'background', 'look', 'harmony']) if (args[k]) input[k] = args[k];
    const format = args.format ?? 'json';
    if (!['json', 'css', 'pptx'].includes(format)) throw new Error('format must be json, css or pptx');
    const prefix = args.prefix ?? '';
    if (prefix && !PREFIX.test(prefix)) throw new Error('prefix must be lowercase letters, digits and hyphens, starting with a letter (e.g. deck-)');
    const result = buildPalette(input);
    if (format === 'css') process.stdout.write(toCss(result, prefix));
    else if (format === 'pptx') process.stdout.write(toPptxText(result, args.name ?? args.preset));
    else {
      const preset = args.preset ? presetDetails(args.preset) : undefined;
      process.stdout.write(JSON.stringify({ ...result, preset, css: toCss(result, prefix), pptx: pptxSlots(result) }, null, 2) + '\n');
    }
    for (const c of result.checks) {
      if (!c.pass) process.stderr.write(`FAIL ${c.pair}: ${c.wcag}:1 is below ${c.wcagMin}:1\n`);
      else if (!c.apcaOk) process.stderr.write(`warn ${c.pair}: APCA Lc ${c.apca} is below ${c.apcaTarget}\n`);
    }
    for (const c of result.cvd) if (!c.ok) process.stderr.write(`warn ${c.pair}: hard to tell apart under ${c.worstVision} (deltaE ${c.deltaE})\n`);
    process.exitCode = result.checks.every((c) => c.pass) ? 0 : 1;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) main();
