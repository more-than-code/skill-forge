#!/usr/bin/env node
// Check N — every image asset the source client ships has a mirror counterpart.
//
// WHY THIS EXISTS
// ---------------
// Nothing else in the gate looks at images. Routes, strings, API calls and control names
// are all text, and an image usually carries a text alternative — so a logo on the source
// and the same word as plain text on the mirror satisfy every text check at once.
// Observed 2026-11-07 on one project: a brand wordmark shipped on the source; the mirror
// had no brand assets at all and printed the product name as text. Nothing failed.
//
// Asset folders are the cheap, framework-free evidence. A new file in the source's brand
// folder is a new visual the mirror has to carry; this check fails the day it lands, with
// no capture needed.
//
// WHAT IT COMPARES
// ----------------
//   assets.pairs    [{ name, source, mirror, map? }] — a source folder and the mirror folder
//                   that should carry the same images. Files are matched by normalised stem
//                   (lower case, `-`/`_`/spaces folded, extension and @2x/@3x ignored), so
//                   `wordmark.svg` matches `wordmark.png` and `Wordmark@2x.png`. `map` pairs
//                   a source path with a mirror path whose stem differs.
//   assets.waivers  [{ asset: "<pair name>/<source path>", reason, owner, addedOn, removeWhen }]
//                   for a source asset the mirror deliberately does not carry.
//
// Only source-side gaps fail. Mirror-only assets are counted in a note: a native icon set
// is normal.
//
// Usage: node parity-assets.mjs [--config parity.config.json]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, extname, basename } from 'node:path';

const IMAGE_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.avif']);
const WAIVER_FIELDS = ['asset', 'reason', 'owner', 'addedOn', 'removeWhen'];

const stem = (file) =>
  basename(file, extname(file))
    .toLowerCase()
    .replace(/@\d+(\.\d+)?x$/, '')
    .replace(/[-_\s]+/g, '-');

function images(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (IMAGE_EXT.has(extname(entry).toLowerCase())) out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

export function runAssets(cfg, root) {
  const notes = [];
  const failures = [];
  const pairs = cfg.assets?.pairs ?? [];
  if (!pairs.length) {
    notes.push('assets: not configured — image and brand assets are compared by no check. Set assets.pairs.');
    return { notes, failures };
  }

  // A waiver is a decision; without its fields it is a silence switch.
  const waivers = cfg.assets?.waivers ?? [];
  const badWaivers = waivers
    .map((w, i) => ({ i, w, missing: WAIVER_FIELDS.filter((k) => !w?.[k]) }))
    .filter((x) => x.missing.length);
  for (const { i, w, missing } of badWaivers) {
    failures.push({
      id: 'asset-parity:waivers',
      msg: `assets.waivers[${i}] (${w?.asset ?? 'unnamed'}) is missing: ${missing.join(', ')}. A waiver needs a reason, an owner, a date and the condition that removes it.`,
    });
  }
  const waived = new Set(waivers.filter((w) => WAIVER_FIELDS.every((k) => w?.[k])).map((w) => w.asset));

  for (const pair of pairs) {
    const srcDir = resolve(root, pair.source);
    const mirDir = resolve(root, pair.mirror);
    if (!existsSync(srcDir)) {
      notes.push(`assets: ${pair.name} — ${pair.source} does not exist, not checked`);
      continue;
    }
    const source = images(srcDir);
    const mirror = images(mirDir);
    const mirrorStems = new Set(mirror.map(stem));
    const map = pair.map ?? {};
    const missing = source.filter(
      (rel) =>
        !mirrorStems.has(stem(rel)) &&
        !(map[rel] && existsSync(join(mirDir, map[rel]))) &&
        !waived.has(`${pair.name}/${rel}`),
    );
    if (missing.length) {
      failures.push({
        id: `asset-parity:${pair.name}`,
        msg:
          `${missing.length} image asset(s) in ${pair.source} have no counterpart in ${pair.mirror}` +
          (existsSync(mirDir) ? '' : ' (which does not exist)') +
          `. Each is a visual the mirror does not show — and a text check cannot see it, because the ` +
          `mirror can print the same alt text. Add the asset to the mirror, map it, or waive it.`,
        items: missing,
      });
    } else {
      const extra = mirror.length - source.length;
      notes.push(
        `assets: ${pair.name} ok — ${source.length} source asset(s) have a mirror counterpart` +
          (extra > 0 ? ` (${extra} more on the mirror)` : ''),
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
  const { notes, failures } = runAssets(cfg, root);
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) {
    console.log(`\n  ✗ ${f.id}: ${f.msg}`);
    for (const i of f.items ?? []) console.log(`      ${i}`);
  }
  console.log(failures.length ? '\n[parity-assets] FAIL' : '\n[parity-assets] ok');
  process.exit(failures.length ? 1 : 0);
}
