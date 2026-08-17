#!/usr/bin/env node
// Check H — alignment invariants, measured on the captured PNGs.
//
// WHY THIS EXISTS
// ---------------
// Token conformance compares declared values. The vision reviewer compares pictures and
// is noisy. Neither can see an *implicit framework default with no counterpart in the
// source client* — and that is a whole class of mirroring defect.
//
// Measured 2026-08-10 in `tutored`: Flutter's IconButton silently enforces a 48x48
// minimum tap target (MaterialTapTargetSize.padded). The web button is content-sized at
// ~36px. Both rows bottom-align, so the taller sibling set the row height and pushed the
// composer placeholder 6.7pt below the icon row — on every screen, for weeks. No token
// was wrong, no string differed, no capability was missing. Five reasoned fixes missed
// it; the sixth landed only after measuring. The reviewer never mentioned it once.
//
// WHAT IT CHECKS
// --------------
// An *invariant* is a set of named regions that should share a vertical centre — e.g.
// the composer's icons and its placeholder. The invariant is measured on BOTH clients
// and the two spreads are compared.
//
// Cross-client is deliberate. Asserting an absolute "correct" offset would make this
// script the arbiter of good design; comparing the two keeps the source client the
// source of truth, which is the premise of the whole harness.
//
// SCOPE DISCIPLINE — READ BEFORE ADDING ENTRIES
// --------------------------------------------
// Shared chrome ONLY: composer, page header, canvas header, list row. Chrome appears on
// every screen (so a defect there is systemic) and changes slowly (so declarations do
// not rot). Per-screen invariants are NOT worth it: region coordinates drift with every
// redesign, and a check that cries wolf gets switched off — you have already seen that
// happen to a reviewer. Keep this under ~5 entries. A check with 90 entries is a check
// that lies.
//
// Usage: node parity-geometry.mjs [--config parity.config.json] [--json]
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import zlib from 'node:zlib';

// --- minimal PNG reader (no dependencies) -----------------------------------
// Deliberately dependency-free: the harness must run in a bare checkout and on CI
// without a Python/PIL toolchain. Handles 8-bit truecolour(+alpha), which is what
// Playwright and the Flutter golden harness emit.
function readPng(path) {
  const f = readFileSync(path);
  if (f.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a PNG: ${path}`);
  let pos = 8;
  let w, h, bitDepth, colorType;
  const idat = [];
  while (pos < f.length) {
    const len = f.readUInt32BE(pos);
    const type = f.toString('ascii', pos + 4, pos + 8);
    const data = f.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} in ${path}`);
  const nch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!nch) throw new Error(`unsupported colour type ${colorType} in ${path}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * nch;
  const out = Buffer.alloc(w * h * nch);
  let prev = Buffer.alloc(stride);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[i++];
    const line = Buffer.from(raw.subarray(i, i + stride));
    i += stride;
    if (ft === 1) for (let x = nch; x < stride; x++) line[x] = (line[x] + line[x - nch]) & 255;
    else if (ft === 2) for (let x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 255;
    else if (ft === 3)
      for (let x = 0; x < stride; x++) {
        const a = x >= nch ? line[x - nch] : 0;
        line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255;
      }
    else if (ft === 4)
      for (let x = 0; x < stride; x++) {
        const a = x >= nch ? line[x - nch] : 0;
        const b = prev[x];
        const c = x >= nch ? prev[x - nch] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, nch, data: out };
}

const lum = (img, x, y) => {
  const o = (y * img.w + x) * img.nch;
  return (img.data[o] * 299 + img.data[o + 1] * 587 + img.data[o + 2] * 114) / 1000;
};

/**
 * Vertical centre of the "ink" (pixels darker than `threshold`) inside a fractional
 * box. Fractions, not pixels: web and mobile captures differ in scale and device
 * pixel ratio, so absolute coordinates would compare nothing.
 */
function inkCentre(img, box, threshold) {
  const x1 = Math.max(0, Math.floor(img.w * box.x1));
  const x2 = Math.min(img.w, Math.ceil(img.w * box.x2));
  const y1 = Math.max(0, Math.floor(img.h * box.y1));
  const y2 = Math.min(img.h, Math.ceil(img.h * box.y2));
  let top = null, bottom = null;
  for (let y = y1; y < y2; y++) {
    let hit = false;
    for (let x = x1; x < x2; x++) {
      if (lum(img, x, y) < threshold) { hit = true; break; }
    }
    if (hit) { if (top === null) top = y; bottom = y; }
  }
  if (top === null) return null;
  // Normalised to image height so the two clients are comparable.
  return ((top + bottom) / 2) / img.h;
}

export function runGeometry(cfg, root) {
  const invariants = cfg.geometry?.invariants ?? [];
  const notes = [];
  const failures = [];
  if (!invariants.length) return { notes, failures };

  const outDir = resolve(root, cfg.out ?? 'parity-out');
  const threshold = cfg.geometry?.inkThreshold ?? 170;
  // Tolerance in fractions of image height. Default ≈ 1pt on a 844pt-tall capture.
  const tol = cfg.geometry?.toleranceFraction ?? 0.0015;
  const waived = new Set(cfg.geometry?.waivers?.map((w) => w.invariant) ?? []);

  for (const inv of invariants) {
    if (waived.has(inv.name)) {
      notes.push(`geometry: ${inv.name} WAIVED — ${cfg.geometry.waivers.find((w) => w.invariant === inv.name).reason}`);
      continue;
    }
    const spreads = {};
    let missing = false;
    for (const side of ['web', 'mobile']) {
      const png = join(outDir, side, `${inv.capture}.png`);
      if (!existsSync(png)) {
        notes.push(`geometry: ${inv.name} skipped — no ${side} capture (${inv.capture})`);
        missing = true;
        break;
      }
      const img = readPng(png);
      const centres = [];
      for (const [rname, box] of Object.entries(inv.regions)) {
        const c = inkCentre(img, box, threshold);
        if (c === null) {
          notes.push(`geometry: ${inv.name}/${side}: region "${rname}" has no ink — region box is probably stale`);
          missing = true;
          break;
        }
        centres.push({ rname, c });
      }
      if (missing) break;
      const vals = centres.map((x) => x.c);
      spreads[side] = { spread: Math.max(...vals) - Math.min(...vals), centres };
    }
    if (missing) continue;

    const delta = Math.abs(spreads.web.spread - spreads.mobile.spread);
    const fmt = (s) => s.centres.map((x) => `${x.rname}=${(x.c * 100).toFixed(2)}%`).join(' ');
    if (delta > tol) {
      failures.push({
        id: `geometry:${inv.name}`,
        msg:
          `Alignment invariant "${inv.name}" differs between clients on ${inv.capture}. ` +
          `The regions that share a vertical centre on one client do not on the other — ` +
          `the class of defect no token check and no screenshot reviewer can see.\n` +
          `      web    spread ${(spreads.web.spread * 100).toFixed(3)}%  ${fmt(spreads.web)}\n` +
          `      mobile spread ${(spreads.mobile.spread * 100).toFixed(3)}%  ${fmt(spreads.mobile)}\n` +
          `      delta ${(delta * 100).toFixed(3)}% (tolerance ${(tol * 100).toFixed(3)}%)`,
      });
    } else {
      notes.push(
        `geometry: ${inv.name} ok — spread web ${(spreads.web.spread * 100).toFixed(3)}% / ` +
          `mobile ${(spreads.mobile.spread * 100).toFixed(3)}%`
      );
    }
  }
  return { notes, failures };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = process.argv.indexOf('--config');
  const cfgPath = resolve(ci > 0 ? process.argv[ci + 1] : 'parity.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const root = resolve(dirname(cfgPath), cfg.root ?? '.');
  const { notes, failures } = runGeometry(cfg, root);
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) console.log(`\n  ✗ ${f.id}: ${f.msg}`);
  console.log(failures.length ? '\n[parity-geometry] FAIL' : '\n[parity-geometry] ok');
  process.exit(failures.length ? 1 : 0);
}
