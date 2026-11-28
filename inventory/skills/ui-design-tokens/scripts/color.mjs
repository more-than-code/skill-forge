// Dependency-free colour maths for contrast checks: parse sRGB colours, composite
// translucent colours over a background, WCAG 2.2 contrast ratio and APCA Lc.
// Node >= 18; the exported functions also run in a browser. No dependencies.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() into {r,g,b,a} (0-255, alpha 0-1). */
export function parseColor(input) {
  if (input && typeof input === 'object' && Array.isArray(input.components)) {
    // DTCG colour object: only sRGB is supported. The hex, when present, is what CSS ships.
    if (input.colorSpace !== 'srgb') throw new Error(`unsupported colorSpace ${JSON.stringify(input.colorSpace)} (srgb only)`);
    const a = input.alpha ?? 1;
    if (input.hex) return { ...parseColor(input.hex), a };
    const [r, g, b] = input.components.map((c) => {
      if (typeof c !== 'number') throw new Error(`unsupported colour component ${JSON.stringify(c)}`);
      return Math.round(c * 255);
    });
    return { r, g, b, a };
  }
  if (input && typeof input === 'object' && 'r' in input) return { a: 1, ...input };
  const s = String(input).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  throw new Error(`unsupported colour: ${JSON.stringify(input)}`);
}

/** Source-over composite of fg on an opaque bg; returns an opaque colour. */
export function composite(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (b.a < 1) throw new Error('background must be opaque');
  const mix = (x, y) => x * f.a + y * (1 - f.a);
  return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b), a: 1 };
}

// WCAG 2.2 relative luminance (sRGB, piecewise transfer function).
function relativeLuminance({ r, g, b }) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.2 contrast ratio (1-21). A translucent fg is composited over bg first. */
export function wcagRatio(fg, bg) {
  const b = parseColor(bg);
  const f = composite(fg, b);
  const l1 = relativeLuminance(f);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// APCA 0.0.98G-4g constants (W3C Silver / apca-w3).
const A = {
  trc: 2.4, rCo: 0.2126729, gCo: 0.7151522, bCo: 0.072175,
  normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  blkThrs: 0.022, blkClmp: 1.414, scale: 1.14, offset: 0.027,
  deltaYmin: 0.0005, loClip: 0.1,
};

function apcaY({ r, g, b }) {
  return A.rCo * (r / 255) ** A.trc + A.gCo * (g / 255) ** A.trc + A.bCo * (b / 255) ** A.trc;
}

/** APCA lightness contrast Lc (about -108 to 106); positive is dark text on light. */
export function apcaLc(text, bg) {
  const b = parseColor(bg);
  const t = composite(text, b);
  const clamp = (y) => (y > A.blkThrs ? y : y + (A.blkThrs - y) ** A.blkClmp);
  const yt = clamp(apcaY(t));
  const yb = clamp(apcaY(b));
  if (Math.abs(yb - yt) < A.deltaYmin) return 0;
  let out;
  if (yb > yt) {
    const s = (yb ** A.normBG - yt ** A.normTXT) * A.scale;
    out = s < A.loClip ? 0 : s - A.offset;
  } else {
    const s = (yb ** A.revBG - yt ** A.revTXT) * A.scale;
    out = s > -A.loClip ? 0 : s + A.offset;
  }
  return out * 100;
}

/** Minimums per use. WCAG is the gate; APCA |Lc| is a second, advisory check. */
export const TARGETS = {
  text: { wcag: 4.5, apca: 60 }, // body text and captions (WCAG 1.4.3 AA); APCA wants Lc 75 for body copy
  'large-text': { wcag: 3, apca: 45 }, // >= 24px, or >= 18.66px bold
  ui: { wcag: 3, apca: 30 }, // control borders, focus indicators, icons, chart marks (WCAG 1.4.11)
};

const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Check one pair; returns {ratio, lc, pass, apcaPass}. */
export function checkPair(fg, bg, use = 'text') {
  const target = TARGETS[use];
  if (!target) throw new Error(`unknown use "${use}" (text, large-text, ui)`);
  const ratio = wcagRatio(fg, bg);
  const lc = apcaLc(fg, bg);
  return {
    ratio: Math.floor(ratio * 100) / 100, // floor, so a displayed 4.5 never hides a fail

    lc: Math.round(lc * 10) / 10,
    pass: ratio >= target.wcag,
    apcaPass: Math.abs(lc) >= target.apca,
    target,
  };
}

export { hex as toHex };

// CLI: node color.mjs <fg> <bg> [text|large-text|ui]
/** True when this module is the script Node was started with (robust to spaces and symlinks). */
export function isMain(metaUrl) {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(metaUrl) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  const [fg, bg, use = 'text'] = process.argv.slice(2);
  if (!fg || !bg) {
    console.error('usage: node color.mjs <fg> <bg> [text|large-text|ui]');
    process.exit(2);
  }
  try {
    const r = checkPair(fg, bg, use);
    console.log(
      `${fg} on ${bg} (${use}): WCAG ${r.ratio}:1 ${r.pass ? 'pass' : 'FAIL'} (min ${r.target.wcag}), ` +
        `APCA Lc ${r.lc} ${r.apcaPass ? 'ok' : 'below'} (advisory ${r.target.apca})`,
    );
    process.exit(r.pass ? 0 : 1);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
