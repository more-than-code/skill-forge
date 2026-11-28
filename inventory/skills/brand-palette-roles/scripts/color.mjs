// Colour maths for brand-palette-roles. Dependency-free; Node 18+.
//
// - WCAG 2.2 contrast ratio (relative luminance, sRGB transfer with the 0.04045 knee).
// - APCA Lc (APCA-W3 0.0.98G-4g constants), reported as a second opinion.
// - OKLab / OKLCH conversion, gamut clamp by chroma reduction, mixing in OKLab.
// - Colour-vision-deficiency simulation (Machado et al. 2009, severity 1.0).
//
// Colours enter and leave as "#RRGGBB" strings.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True when the module at metaUrl is the script Node was started with, also through a symlink. */
export function isMain(metaUrl) {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(metaUrl) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

export function parseHex(input) {
  const m = HEX.exec(String(input).trim());
  if (!m) throw new Error(`not a hex colour: ${JSON.stringify(input)}`);
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function normHex(input) {
  return toHex(parseHex(input));
}

export function toHex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (l) => 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const linToHex = (lin) => toHex(lin.map((v) => fromLinear(clamp01(v))));

// WCAG 2.2 relative luminance and contrast ratio.
export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// APCA Lc for text on background. Positive: dark text on light; negative: light on dark.
export function apcaLc(text, background) {
  const y = (hex) => {
    const [r, g, b] = parseHex(hex).map((c) => (c / 255) ** 2.4);
    const v = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    return v > 0.022 ? v : v + (0.022 - v) ** 1.414;
  };
  const yt = y(text);
  const yb = y(background);
  if (Math.abs(yb - yt) < 0.0005) return 0;
  let out;
  if (yb > yt) {
    const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
    out = s < 0.1 ? 0 : s - 0.027;
  } else {
    const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
    out = s > -0.1 ? 0 : s + 0.027;
  }
  return out * 100;
}

// OKLab (Ottosson 2020).
function linToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLin([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const oklab = (hex) => linToOklab(parseHex(hex).map(toLinear));

export function oklch(hex) {
  const [L, a, b] = oklab(hex);
  const C = Math.hypot(a, b);
  const h = C < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return [L, C, h];
}

const inGamut = (lin) => lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

// OKLCH to hex; out-of-gamut colours keep L and h and lose chroma until they fit.
export function fromOklch(L, C, h) {
  const Lc = clamp01(L);
  const rad = (h * Math.PI) / 180;
  const lin = (c) => oklabToLin([Lc, c * Math.cos(rad), c * Math.sin(rad)]);
  let c = Math.max(0, C);
  if (!inGamut(lin(c))) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(lin(mid))) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  return linToHex(lin(c));
}

// Mix a toward b by t (0 = a, 1 = b) in OKLab.
export function mix(a, b, t) {
  const A = oklab(a);
  const B = oklab(b);
  const lin = oklabToLin(A.map((v, i) => v + (B[i] - v) * t));
  return linToHex(lin);
}

// Euclidean distance in OKLab (about 0.02 is a just-noticeable difference).
export function deltaE(a, b) {
  const A = oklab(a);
  const B = oklab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

// Machado, Oliveira & Fernandes 2009, severity 1.0, applied to linear sRGB.
const CVD = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
export const CVD_TYPES = Object.keys(CVD);

export function simulateCvd(hex, type) {
  const M = CVD[type];
  if (!M) throw new Error(`unknown colour-vision deficiency: ${type}`);
  const lin = parseHex(hex).map(toLinear);
  const out = M.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  return linToHex(out);
}

// Smallest OKLab distance between a and b under normal vision and each simulated deficiency.
export function cvdMinDelta(a, b) {
  let min = { vision: 'normal', delta: deltaE(a, b) };
  for (const type of CVD_TYPES) {
    const d = deltaE(simulateCvd(a, type), simulateCvd(b, type));
    if (d < min.delta) min = { vision: type, delta: d };
  }
  return min;
}
