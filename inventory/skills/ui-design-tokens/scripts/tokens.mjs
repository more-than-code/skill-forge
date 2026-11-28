// Build tokens.css from a DTCG tokens.json, and check the contrast pairs it declares.
//   node tokens.mjs css   [tokens.json]          print the generated CSS
//   node tokens.mjs check [tokens.json] [--json] WCAG 2.2 gate, APCA advisory; exit 1 on a WCAG fail
// Dependency-free; Node >= 18.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseColor, checkPair } from './color.mjs';

const X = 'com.skillforgecloud';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TOKENS = path.join(HERE, '..', 'tokens.json');

const isToken = (node) => node && typeof node === 'object' && '$value' in node;

/** Flatten a DTCG tree into [{path, type, value, dark, cssName, description}]. */
export function flatten(tree) {
  const out = [];
  const walk = (node, keys, type, prefix, prefixDepth) => {
    const ext = node.$extensions?.[`${X}.css`];
    if (ext?.prefix !== undefined) {
      prefix = ext.prefix;
      prefixDepth = keys.length;
    }
    type = node.$type ?? type;
    if (isToken(node)) {
      let cssName = null;
      if (ext?.name) cssName = ext.name;
      else if (prefix !== undefined) cssName = prefix + keys.slice(prefixDepth).join('-');
      out.push({
        path: keys.join('.'),
        type,
        value: node.$value,
        dark: node.$extensions?.[`${X}.modes`]?.dark,
        cssName,
        description: node.$description,
      });
      return;
    }
    for (const [k, child] of Object.entries(node)) {
      if (k.startsWith('$') || typeof child !== 'object') continue;
      walk(child, [...keys, k], type, prefix, prefixDepth);
    }
  };
  walk(tree, [], undefined, undefined, 0);
  return out;
}

const aliasPath = (v) => (typeof v === 'string' && /^\{[^}]+\}$/.test(v) ? v.slice(1, -1) : null);

function cssColor(v, byPath) {
  const ref = aliasPath(v);
  if (ref) return `var(--${byPath.get(ref).cssName})`;
  const c = parseColor(v);
  if (c.a === 1) return v.hex ?? `rgb(${c.r} ${c.g} ${c.b})`;
  return `rgb(${[c.r, c.g, c.b].map(Math.round).join(' ')} / ${c.a})`;
}

const dim = (v) => `${v.value}${v.unit}`;

function cssValue(t, byPath) {
  const ref = aliasPath(t.value);
  if (ref && t.type !== 'color') return `var(--${byPath.get(ref).cssName})`;
  switch (t.type) {
    case 'color': {
      const light = cssColor(t.value, byPath);
      const dark = t.dark === undefined ? light : cssColor(t.dark, byPath);
      return light === dark ? light : `light-dark(${light}, ${dark})`;
    }
    case 'dimension':
      return dim(t.value);
    case 'duration':
      return `${t.value.value}${t.value.unit}`;
    case 'cubicBezier':
      return `cubic-bezier(${t.value.join(', ')})`;
    case 'fontFamily':
      return t.value.map((f) => (/^[\w-]+$/.test(f) && !/\s/.test(f) ? f : `"${f}"`)).join(', ');
    case 'fontWeight':
    case 'number':
      return String(t.value);
    case 'shadow':
      return [].concat(t.value)
        .map((l) => {
          const color = cssColor(l.color, byPath);
          return `${l.inset ? 'inset ' : ''}${dim(l.offsetX)} ${dim(l.offsetY)} ${dim(l.blur)} ${dim(l.spread)} ${color}`;
        })
        .join(', ');
    default:
      throw new Error(`${t.path}: unsupported $type ${t.type}`);
  }
}

// Fixed rules that make the tokens work: theme selection, motion preferences,
// forced colours and the font aliases. Kept here so tokens.css stays generated.
const STATIC = `
/* Theme: no data-theme follows the system; data-theme forces one mode. */
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }

/* Suppress transitions for the frame in which the theme changes. */
html.theme-switching *, html.theme-switching *::before, html.theme-switching *::after {
  transition: none !important;
}

/* Motion: the OS preference wins unless the user turned motion on; data-motion="off" always wins. */
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion="on"]) { --t-fast: 0ms; --t-med: 0ms; --t-slow: 0ms; }
  :root:not([data-motion="on"]) *, :root:not([data-motion="on"]) *::before, :root:not([data-motion="on"]) *::after {
    animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important;
  }
  :root:not([data-motion="on"])::view-transition-group(*),
  :root:not([data-motion="on"])::view-transition-old(*),
  :root:not([data-motion="on"])::view-transition-new(*) { animation: none !important; }
}
:root[data-motion="off"] { --t-fast: 0ms; --t-med: 0ms; --t-slow: 0ms; }
:root[data-motion="off"] *, :root[data-motion="off"] *::before, :root[data-motion="off"] *::after {
  animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important;
}
:root[data-motion="off"]::view-transition-group(*),
:root[data-motion="off"]::view-transition-old(*),
:root[data-motion="off"]::view-transition-new(*) { animation: none !important; }

/* Forced colours (Windows high contrast) drop box-shadow, so --edge, --shadow and --ring vanish.
   Map the focus indicator and control borders to system colours; leave fills to the browser,
   which draws its own backplate behind text. */
@media (forced-colors: active) {
  :root { --focus: Highlight; --line-strong: CanvasText; }
}

/* Font aliases: local faces only, one per weight token, so no weight is synthesised. */
@font-face { font-family: "App Sans"; src: local("Segoe UI Light"), local("SegoeUI-Light"); font-weight: 100 349; }
@font-face { font-family: "App Sans"; src: local("Segoe UI"), local("SegoeUI"); font-weight: 350 549; }
@font-face { font-family: "App Sans"; src: local("Segoe UI Bold"), local("SegoeUI-Bold"); font-weight: 550 900; }
@font-face { font-family: "App Sans CJK"; src: local("Microsoft YaHei Light"), local("MicrosoftYaHeiLight"), local("PingFangSC-Light"); font-weight: 100 349; }
@font-face { font-family: "App Sans CJK"; src: local("Microsoft YaHei"), local("MicrosoftYaHei"), local("PingFangSC-Regular"); font-weight: 350 549; }
@font-face { font-family: "App Sans CJK"; src: local("Microsoft YaHei Bold"), local("MicrosoftYaHei-Bold"), local("PingFangSC-Semibold"); font-weight: 550 900; }
`;

/** Generate tokens.css text from a parsed tokens.json. */
export function buildCss(tree) {
  const tokens = flatten(tree);
  const byPath = new Map(tokens.map((t) => [t.path, t]));
  const lines = tokens
    .filter((t) => t.cssName)
    .map((t) => `  --${t.cssName}: ${cssValue(t, byPath)};`);
  const notEmitted = tokens.filter((t) => !t.cssName).map((t) => `${t.path} = ${dim(t.value)}`);
  return [
    '/* Generated from tokens.json by scripts/tokens.mjs css. Do not edit by hand. */',
    notEmitted.length ? `/* Not custom properties (use the literal values): ${notEmitted.join(', ')} */` : null,
    ':root {',
    '  color-scheme: light dark;',
    ...lines,
    '}',
    STATIC.trimEnd(),
    '',
  ].filter((l) => l !== null).join('\n');
}

/** Resolve a colour token to a concrete value for one mode, following aliases. */
function resolveColor(byPath, p, mode, seen = new Set()) {
  if (seen.has(p)) throw new Error(`alias cycle at ${p}`);
  seen.add(p);
  const t = byPath.get(p);
  if (!t || t.type !== 'color') throw new Error(`unknown colour token ${p}`);
  const v = mode === 'dark' && t.dark !== undefined ? t.dark : t.value;
  const ref = aliasPath(v);
  return ref ? resolveColor(byPath, ref, mode, seen) : v;
}

/** Check every declared pair in both modes. Returns {results, failures, advisories}. */
export function checkTokens(tree) {
  const tokens = flatten(tree);
  const byPath = new Map(tokens.map((t) => [t.path, t]));
  const pairs = tree.$extensions?.[`${X}.contrast`]?.pairs ?? [];
  const results = [];
  for (const mode of ['light', 'dark']) {
    for (const [fg, bg, use] of pairs) {
      const r = checkPair(
        resolveColor(byPath, `color.${fg}`, mode),
        resolveColor(byPath, `color.${bg}`, mode),
        use,
      );
      results.push({ mode, fg, bg, use, ratio: r.ratio, lc: r.lc, pass: r.pass, apcaPass: r.apcaPass });
    }
  }
  return {
    results,
    failures: results.filter((r) => !r.pass),
    advisories: results.filter((r) => r.pass && !r.apcaPass),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  const file = rest.find((a) => !a.startsWith('--')) ?? DEFAULT_TOKENS;
  let tree;
  try {
    tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
  if (cmd === 'css') {
    process.stdout.write(buildCss(tree));
  } else if (cmd === 'check') {
    const { results, failures, advisories } = checkTokens(tree);
    if (json) {
      console.log(JSON.stringify({ checked: results.length, failures, advisories }, null, 2));
    } else {
      for (const r of [...failures, ...advisories]) {
        const tag = r.pass ? 'APCA below advisory' : 'WCAG FAIL';
        console.log(`${tag}  ${r.mode}  ${r.fg} on ${r.bg} (${r.use}): ${r.ratio}:1, Lc ${r.lc}`);
      }
      console.log(`${results.length} pairs checked (light and dark): ${failures.length} WCAG failures, ${advisories.length} APCA advisories`);
    }
    process.exit(failures.length ? 1 : 0);
  } else {
    console.error('usage: node tokens.mjs css|check [tokens.json] [--json]');
    process.exit(2);
  }
}
