#!/usr/bin/env node
// Seeds + look in, 11 palette roles out, with contrast and colour-blind checks.
//
//   node palette.mjs --primary '#2E6F5E' [--secondary HEX] [--accent HEX] [--background HEX]
//                    [--look light|dark] [--harmony split|complementary|analogous|triadic]
//                    [--preset KEY] [--format json|css|pptx] [--name TEXT]
//
// Exit 0 when every WCAG check passes, 1 when one fails, 2 on bad input.
// Dependency-free; Node 18+.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normHex, oklch, fromOklch, mix, contrastRatio, apcaLc, cvdMinDelta } from './color.mjs';

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

const LOOKS = {
  light: { paper: '#F7F6F2', ink: '#1E1D1B', ink2: '#635F59', shade: '#1D1C1A', deepBase: '#141519', paperOk: (L) => L >= 0.9 },
  dark: { paper: '#0F131C', ink: '#F3F2EE', ink2: '#A7B0C0', shade: '#07090E', paperOk: (L) => L <= 0.3 },
};

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

const cvdOk = (a, b) => cvdMinDelta(a, b).delta >= CVD_MIN_DELTA;

export function buildPalette(input) {
  const look = input.look ?? 'light';
  if (!LOOKS[look]) throw new Error(`look must be light or dark, not ${JSON.stringify(look)}`);
  const harmony = input.harmony ?? 'split';
  if (!HARMONIES[harmony]) throw new Error(`harmony must be one of ${Object.keys(HARMONIES).join(', ')}`);
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
  const soft = dark ? mix(paper, '#FFFFFF', 0.06) : mix(paper, D.shade, 0.045);
  const card = dark ? mix(paper, '#FFFFFF', 0.1) : mix(paper, '#FFFFFF', 0.65);
  const line = dark ? mix(paper, '#FFFFFF', 0.15) : mix(paper, D.shade, 0.12);
  const textBgs = [paper, soft, card];

  // 3. Text: the look's warm neutrals, pushed further only when a surface needs it.
  const ink = guard(D.ink, textBgs, TARGETS.body, dark);
  const ink2 = guard(D.ink2, textBgs, TARGETS.secondaryText, dark);

  // 4. Seeds: given ones are kept unless too weak on paper; missing ones come from the harmony.
  const fix = (name, raw) => {
    const out = guard(raw, [paper], TARGETS.nonText, dark);
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
      .map((dL) => guard(rotate(base, 0, 1, dL), [paper], TARGETS.nonText, dark));
    const score = (c) => Math.min(...others.map((o) => cvdMinDelta(c, o).delta));
    return tries.find((c) => others.every((o) => cvdOk(c, o))) ?? tries.reduce((a, b) => (score(b) > score(a) ? b : a));
  };

  let secondary;
  if (seeds.secondary) secondary = fix('secondary', seeds.secondary);
  else {
    secondary = pickApart(neutral ? rotate(brand, 0, 1, dark ? -0.2 : 0.2) : rotate(seeds.primary, secOff, 0.8), [brand]);
    notes.push(`secondary derived (${neutral ? 'neutral primary: lightness step' : `${harmony}, ${secOff} deg`}): ${secondary}`);
  }

  let accent;
  if (seeds.accent) accent = fix('accent', seeds.accent);
  else {
    accent = pickApart(neutral ? NEUTRAL_ACCENT : rotate(seeds.primary, accOff), [brand, secondary]);
    notes.push(`accent derived (${neutral ? 'neutral primary: default accent' : `${harmony}, ${accOff} deg`}): ${accent}`);
  }

  // 5. Emphasis and soft-primary surfaces. Text on deep is paper (light look) or ink (dark look).
  const onDeep = dark ? ink : paper;
  let deep = dark ? mix(paper, D.shade, 0.35) : mix(brand, D.deepBase, 0.78);
  for (let t = 0.79; !dark && !meets(onDeep, deep, TARGETS.body) && t <= 1; t += 0.01) deep = mix(brand, D.deepBase, t);
  let tint = mix(paper, brand, dark ? 0.2 : 0.14);
  for (let t = dark ? 0.19 : 0.13; !meets(ink, tint, TARGETS.body) && t >= 0; t -= 0.01) tint = mix(paper, brand, t);

  const roles = { brand, secondary, accent, deep, paper, soft, card, line, tint, ink, 'ink-2': ink2 };
  return { look, harmony, seeds, roles, onDeep, checks: runChecks(roles, onDeep), cvd: cvdChecks(roles), notes };
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
      wcag: Number(wcag.toFixed(2)), wcagMin: t.wcag, pass: wcag >= t.wcag,
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
  const slots = {
    dk1: light ? r.ink : r.paper,
    lt1: light ? r.paper : r.ink,
    dk2: light ? r.deep : r.soft,
    lt2: light ? r.soft : r['ink-2'],
    accent1: r.brand, accent2: r.secondary, accent3: r.accent,
    accent4: r.tint, accent5: r['ink-2'], accent6: r.line,
    hlink: contrastRatio(r.brand, r.paper) >= 4.5 ? r.brand : r.ink,
    folHlink: r['ink-2'],
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

// A preset's seeds and look, as buildPalette input.
export function presetInput(key) {
  const p = loadPresets().presets.find((x) => x.key === key);
  if (!p) throw new Error(`unknown preset ${JSON.stringify(key)}`);
  return { ...p.seeds, look: p.look };
}

const OPTIONS = new Set(['primary', 'secondary', 'accent', 'background', 'look', 'harmony', 'preset', 'format', 'name']);
const USAGE = 'usage: palette.mjs --primary HEX [--secondary HEX] [--accent HEX] [--background HEX] [--look light|dark] [--harmony split|complementary|analogous|triadic] [--preset KEY] [--format json|css|pptx] [--name TEXT]\n';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    const key = a.startsWith('--') ? a.slice(2) : null;
    if (!key || !OPTIONS.has(key)) throw new Error(`unknown argument: ${a}`);
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
    const input = args.preset ? presetInput(args.preset) : {};
    for (const k of ['primary', 'secondary', 'accent', 'background', 'look', 'harmony']) if (args[k]) input[k] = args[k];
    const format = args.format ?? 'json';
    if (!['json', 'css', 'pptx'].includes(format)) throw new Error('format must be json, css or pptx');
    const result = buildPalette(input);
    if (format === 'css') process.stdout.write(toCss(result));
    else if (format === 'pptx') process.stdout.write(toPptxText(result, args.name ?? args.preset));
    else process.stdout.write(JSON.stringify({ ...result, css: toCss(result), pptx: pptxSlots(result) }, null, 2) + '\n');
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
