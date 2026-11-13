#!/usr/bin/env node
// Check O — inventory parity. Does the mirror's CODE carry everything the source's code does?
//
// WHY THIS EXISTS
// ---------------
// Every other check reads captures, and a capture shows only a state someone thought to
// produce. A feature nobody captured is invisible to all of them. Observed 2026-11-07 on one
// project: two whole Dictionary features were missing on the mirror — a chat panel opened by a
// streamed tool result, and an AI lookup offered when a search finds nothing. Neither state
// was in any capture, so the gate passed both. Both would have shown up here in a second: the
// mirror never called `POST /api/dictionary` or `GET /api/dictionary/lookup` anywhere, and had
// no handler for the `lookup_dictionary` tool.
//
// WHAT IT COMPARES
// ----------------
//   inventory.sets  [{ name, normalize?, source, mirror, waivers? }]
//     source / mirror  { dirs: [...], extensions: [".ts"], patterns: ["<regex>", ...],
//                        exclude?: ["<regex on the relative path>"], skipDirs?: [...] }
//                      Each pattern is a JavaScript regex. Named groups decide the item:
//                      `method` + `path` → "METHOD /path" (method defaults to GET, and the
//                      note counts how often), or `item` → that text, or else the first
//                      group, or else the whole match. Every pattern must match at least
//                      once: a dead pattern silently shrinks the set it feeds.
//     normalize        "endpoint" folds path parameters — ${x}, $x, {x}, a whole-segment :x,
//                      digit segments, and a trailing "/" left by concatenation ('/api/x/' + id)
//                      all become :param — and drops the query string. Default: none.
//     waivers          [{ item, reason, owner, addedOn, removeWhen }] for a source item the
//                      mirror deliberately lacks. Stale waivers are listed in a note.
//   inventory.optOut   the reason this project needs no inventory check. Without sets or an
//                      optOut the check FAILS: a check nobody configured reads as green.
//
// Only source-side gaps fail; mirror-only items are listed in a note. A scan is text, not a
// parse: whole-line comments are skipped, nothing else is. Write the patterns for your client's
// API layer and check the note's counts against what you expect.
//
// Usage: node parity-inventory.mjs [--config parity.config.json]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname, relative } from 'node:path';

const WAIVER_FIELDS = ['item', 'reason', 'owner', 'addedOn', 'removeWhen'];
const SKIP_DIRS = ['node_modules', '.git', '.dart_tool', '.svelte-kit', '.next'];
const NORMALIZERS = new Set([undefined, 'none', 'endpoint']);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function normalizeEndpoint(method, rawPath) {
  const p = String(rawPath)
    .replace(/\$\{[^}]*\}/g, ':param') // ${expr}  (TS template, Dart)
    .replace(/\$\{[^}]*$/, ':param') // an expression the capture cut off (quotes inside it)
    .replace(/\$[A-Za-z_]\w*/g, ':param') // $name    (Dart)
    .replace(/\{[^}]*\}/g, ':param') // {id}     (OpenAPI style)
    .split('?')[0] // only now: a ? inside ${…} is not a query
    .replace(/([A-Za-z0-9_]):param$/, '$1') // `/search${qs}`: a query built by interpolation
    .replace(/\/$/, '/:param') // '/api/x/' + id: the id was concatenated on
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^:[A-Za-z_]\w*$/.test(seg) ? ':param' : seg))
    .join('/');
  return `${String(method || 'GET').toUpperCase()} ${p || '/'}`;
}

// Files under `dirs`, without following symlinks (no loops, no leaving the tree).
export function listFiles(root, side) {
  const out = [];
  const exts = new Set((side.extensions ?? []).map((e) => e.toLowerCase()));
  const skip = new Set(side.skipDirs ?? SKIP_DIRS);
  const exclude = (side.exclude ?? []).map((e) => new RegExp(e));
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(p);
      } else if (entry.isFile() && (!exts.size || exts.has(extname(entry.name).toLowerCase()))) {
        if (!exclude.some((re) => re.test(relative(root, p)))) out.push(p);
      }
    }
  };
  for (const d of side.dirs) walk(resolve(root, d));
  return out;
}

export const dropLineComments = (text) =>
  text
    .split('\n')
    .map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l))
    .join('\n');

// One side of a set → { items, files, defaulted } or { problem }.
function scan(root, side, normalize) {
  if (!side || !isStringArray(side.dirs) || !side.dirs.length) return { problem: 'dirs must be a non-empty list' };
  if (!isStringArray(side.patterns) || !side.patterns.length) return { problem: 'patterns must be a non-empty list' };
  const missing = side.dirs.filter((d) => !existsSync(resolve(root, d)) || !statSync(resolve(root, d)).isDirectory());
  if (missing.length) return { problem: `not a folder: ${missing.join(', ')}` };
  let regexes;
  try {
    regexes = side.patterns.map((p) => new RegExp(p, 'g'));
  } catch (err) {
    return { problem: `bad pattern: ${err.message}` };
  }
  const items = new Set();
  const hits = regexes.map(() => 0);
  let defaulted = 0;
  const files = listFiles(root, side);
  for (const f of files) {
    const text = dropLineComments(readFileSync(f, 'utf8'));
    regexes.forEach((re, i) => {
      for (const m of text.matchAll(re)) {
        if (!m[0]) continue;
        hits[i]++;
        const g = m.groups ?? {};
        if (g.path !== undefined) {
          if (!g.method) defaulted++;
          items.add(normalize === 'endpoint' ? normalizeEndpoint(g.method, g.path) : `${(g.method || 'GET').toUpperCase()} ${g.path}`);
        } else items.add(g.item ?? m[1] ?? m[0]);
      }
    });
  }
  const dead = side.patterns.filter((_, i) => !hits[i]);
  if (dead.length) return { problem: `pattern(s) matched nothing in ${files.length} file(s): ${dead.join('  |  ')}` };
  return { items, files: files.length, defaulted };
}

function runSet(root, set) {
  const name = set.name ?? 'unnamed';
  if (!NORMALIZERS.has(set.normalize)) {
    return { failures: [{ id: `inventory-unresolved:${name}`, msg: `normalize must be "endpoint" or omitted, not ${JSON.stringify(set.normalize)}.` }] };
  }
  const src = scan(root, set.source, set.normalize);
  const mir = scan(root, set.mirror, set.normalize);
  const unresolved = [src.problem && `source: ${src.problem}`, mir.problem && `mirror: ${mir.problem}`].filter(Boolean);
  if (unresolved.length) {
    return {
      failures: [
        {
          id: `inventory-unresolved:${name}`,
          msg: `The ${name} inventory cannot be trusted: a set that misses part of the code would pass any mirror. Fix the folders or patterns.`,
          items: unresolved,
        },
      ],
    };
  }

  const failures = [];
  const waivers = Array.isArray(set.waivers) ? set.waivers : [];
  if (set.waivers !== undefined && !Array.isArray(set.waivers)) {
    failures.push({ id: `inventory:${name}:waivers`, msg: 'waivers must be a list.' });
  }
  const bad = waivers.filter((w) => WAIVER_FIELDS.some((k) => typeof w?.[k] !== 'string' || !w[k].trim()));
  if (bad.length) {
    failures.push({
      id: `inventory:${name}:waivers`,
      msg: `${bad.length} waiver(s) lack one of ${WAIVER_FIELDS.join(', ')}, so they waive nothing.`,
      items: bad.map((w) => String(w?.item ?? 'unnamed')),
    });
  }
  const norm = (item) => {
    const m = set.normalize === 'endpoint' && String(item).match(/^([A-Za-z]+)\s+(\S+)$/);
    return m ? normalizeEndpoint(m[1], m[2]) : item;
  };
  const waived = new Set(waivers.filter((w) => !bad.includes(w)).map((w) => norm(w.item)));

  const gaps = [...src.items].filter((i) => !mir.items.has(i));
  const missing = gaps.filter((i) => !waived.has(i)).sort();
  const stale = [...waived].filter((w) => !gaps.includes(w));
  const mirrorOnly = [...mir.items].filter((i) => !src.items.has(i)).sort();
  const notes = [
    `inventory: ${name} — ${src.items.size} source item(s) in ${src.files} file(s), ${mir.items.size} mirror item(s) in ${mir.files} file(s); ` +
      `${missing.length} missing on the mirror, ${waived.size - stale.length} waived` +
      (mirrorOnly.length ? `, ${mirrorOnly.length} mirror-only (${mirrorOnly.slice(0, 5).join(', ')}${mirrorOnly.length > 5 ? ', …' : ''})` : '') +
      (src.defaulted + mir.defaulted ? `; ${src.defaulted + mir.defaulted} call(s) had no method group and count as GET — check the patterns` : ''),
  ];
  if (stale.length) notes.push(`inventory: ${name} — ${stale.length} waiver(s) no longer needed (the mirror has it, or the source dropped it) — remove: ${stale.join(', ')}`);
  if (missing.length) {
    failures.push({
      id: `inventory:${name}`,
      msg:
        `${missing.length} ${name} item(s) exist in the source client's code and nowhere in the mirror's — ` +
        `usually a feature no capture shows. Build it on the mirror, or waive it with a reason.`,
      items: missing,
    });
  }
  return { notes, failures };
}

export function runInventory(cfg, root) {
  const notes = [];
  const failures = [];
  const sets = Array.isArray(cfg.inventory?.sets) ? cfg.inventory.sets : [];
  const optOut = typeof cfg.inventory?.optOut === 'string' ? cfg.inventory.optOut.trim() : '';
  if (cfg.inventory?.sets !== undefined && !Array.isArray(cfg.inventory.sets)) {
    failures.push({ id: 'inventory-not-configured', msg: 'inventory.sets must be a list.' });
    return { notes, failures };
  }
  if (!sets.length) {
    if (optOut) notes.push(`inventory: opted out — ${optOut}`);
    else
      failures.push({
        id: 'inventory-not-configured',
        msg:
          'inventory is not configured, so a source feature that no capture shows is checked by nothing. ' +
          'Declare inventory.sets (API endpoints at least), or set inventory.optOut to the reason this project does not need it.',
      });
    return { notes, failures };
  }
  for (const set of sets) {
    try {
      const r = runSet(root, set ?? {});
      notes.push(...(r.notes ?? []));
      failures.push(...r.failures);
    } catch (err) {
      // One broken set must not take the whole gate's report down with it.
      failures.push({ id: `inventory-unresolved:${set?.name ?? 'unnamed'}`, msg: `scan failed: ${err.message}` });
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
  const { notes, failures } = runInventory(cfg, root);
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) {
    console.log(`\n  ✗ ${f.id}: ${f.msg}`);
    for (const i of f.items ?? []) console.log(`      ${i}`);
  }
  console.log(failures.length ? '\n[parity-inventory] FAIL' : '\n[parity-inventory] ok');
  process.exit(failures.length ? 1 : 0);
}
