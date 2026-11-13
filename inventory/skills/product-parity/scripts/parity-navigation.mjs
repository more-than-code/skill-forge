#!/usr/bin/env node
// Check R — navigation scan. Does the mirror replace the stack where it should push?
//
// WHY THIS EXISTS
// ---------------
// A mirror with stack navigation (Flutter, native iOS/Android) has behaviour the source client
// has no counterpart for: the back gesture, the pop animation, the system back button. All
// three follow from one fact — whether the screen was PUSHED onto the stack or REPLACED it. A
// replace to a drill-down leaves nothing beneath it: Back falls back to a fixed path (or to
// nothing), the edge swipe is dead and leaving animates forwards. Observed 2026-11-13 on one
// project: four of nine back-navigation defects traced to `context.go('/records/…')`-style
// replaces, 67 of them against 8 pushes.
//
// This is a text scan of the mirror's code — no capture needed — so it is Tier 1. Journeys
// (check Q) see the same defects at run time for the paths someone wrote a journey for; this
// sees every call site, including those nobody walked.
//
// WHAT IT CHECKS
// --------------
//   navigation.roots    route templates that may be replaced to (top-level screens)
//   navigation.replace  { dirs, extensions, patterns, exclude?, skipDirs?, waivers? }
//     patterns  JavaScript regexes for a replace call. Named group `path` captures a literal
//               target; a match with no `path` (e.g. an `expr` alternative) is a DYNAMIC
//               target — counted in a note, never failed: a scan is text, not a parse. So is a
//               literal ending in "/" (an id concatenated on) or one that is only an interpolation.
//     waivers   [{ item: <target route>, reason, owner, addedOn, removeWhen }]
//
// Each literal target, normalised (interpolations and digit segments → :param, query
// dropped), that matches no root fails, grouped by target with file:line. Every pattern must
// match at least once. Whole-line comments are skipped; symlinks are not followed.
//
// Optional: with no `navigation.replace` this is a note only. Journeys (Q) are the required check.
//
// Usage: node parity-navigation.mjs [--config parity.config.json]
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { listFiles, dropLineComments } from './parity-inventory.mjs';

const WAIVER_FIELDS = ['item', 'reason', 'owner', 'addedOn', 'removeWhen'];
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
// A route target, normalised: interpolations, `{x}`, `[x]`, `:x` and digit segments become
// :param and the query is dropped. Unlike an API endpoint, a trailing "/" is NOT a concatenated
// id — `/` is the home route — so it is trimmed rather than turned into a parameter.
const normTarget = (raw) => {
  const p = String(raw)
    .replace(/\$\{[^}]*\}/g, ':param')
    .replace(/\$[A-Za-z_]\w*/g, ':param')
    .split('?')[0]
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^:[A-Za-z_]\w*$/.test(seg) || /^\{[^}]*\}$/.test(seg) || /^\[[^\]]*\]$/.test(seg) ? ':param' : seg))
    .join('/');
  return p.length > 1 ? p.replace(/\/$/, '') : p || '/';
};
const rootMatcher = (t) =>
  new RegExp('^' + normTarget(t).split('/').map((s) => (s === ':param' ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');

export function runNavigation(cfg, root) {
  const notes = [];
  const failures = [];
  const nav = cfg.navigation ?? {};
  const side = nav.replace;
  if (!side) {
    notes.push('navigation: replace scan not configured — replace-navigation to drill-down screens is unchecked (optional; JOURNEYS.md)');
    return { notes, failures };
  }
  const unresolved = (msg) => {
    failures.push({ id: 'navigation-unresolved', msg: `the navigation scan cannot be trusted: ${msg}` });
    return { notes, failures };
  };
  if (!isStringArray(nav.roots) || !nav.roots.length) return unresolved('navigation.roots must list the top-level routes.');
  if (!isStringArray(side.dirs) || !side.dirs.length) return unresolved('replace.dirs must be a non-empty list.');
  if (!isStringArray(side.patterns) || !side.patterns.length) return unresolved('replace.patterns must be a non-empty list.');
  const missingDirs = side.dirs.filter((d) => !existsSync(resolve(root, d)) || !statSync(resolve(root, d)).isDirectory());
  if (missingDirs.length) return unresolved(`not a folder: ${missingDirs.join(', ')}`);
  for (const k of ['extensions', 'exclude', 'skipDirs']) {
    if (side[k] !== undefined && !isStringArray(side[k])) return unresolved(`replace.${k} must be a list of strings.`);
  }
  let regexes;
  try {
    regexes = side.patterns.map((p) => new RegExp(p, 'g'));
    (side.exclude ?? []).forEach((e) => new RegExp(e));
  } catch (err) {
    return unresolved(`bad pattern: ${err.message}`);
  }

  const roots = nav.roots.map(rootMatcher);
  const isRoot = (t) => roots.some((re) => re.test(t));
  const hits = regexes.map(() => 0);
  const byTarget = new Map();
  let dynamic = 0;
  let files;
  try {
    files = listFiles(root, side);
  } catch (err) {
    return unresolved(`cannot list files: ${err.message}`);
  }
  for (const f of files) {
    let text;
    try {
      text = dropLineComments(readFileSync(f, 'utf8'));
    } catch (err) {
      return unresolved(`cannot read ${relative(root, f)}: ${err.message}`);
    }
    const lineAt = (idx) => text.slice(0, idx).split('\n').length;
    regexes.forEach((re, i) => {
      for (const m of text.matchAll(re)) {
        if (!m[0]) continue;
        hits[i]++;
        const p = m.groups?.path;
        // No literal, a literal ending in "/" (an id concatenated on: '/records/' + id) or a
        // literal that is only an interpolation ('$path'): the target is decided at run time.
        const target = p === undefined || /\/$/.test(p.split('?')[0]) && p.split('?')[0] !== '/' ? null : normTarget(p);
        if (target === null || target === ':param' || target === '/:param') {
          dynamic++;
          continue;
        }
        if (isRoot(target)) continue;
        if (!byTarget.has(target)) byTarget.set(target, []);
        byTarget.get(target).push(`${relative(root, f)}:${lineAt(m.index)}`);
      }
    });
  }
  const dead = side.patterns.filter((_, i) => !hits[i]);
  if (dead.length) return unresolved(`pattern(s) matched nothing in ${files.length} file(s): ${dead.join('  |  ')}`);

  const waivers = Array.isArray(side.waivers) ? side.waivers : [];
  const bad = waivers.filter((w) => WAIVER_FIELDS.some((k) => typeof w?.[k] !== 'string' || !w[k].trim()));
  if (bad.length) {
    failures.push({
      id: 'navigation:waivers',
      msg: `${bad.length} waiver(s) lack one of ${WAIVER_FIELDS.join(', ')}, so they waive nothing.`,
      items: bad.map((w) => String(w?.item ?? 'unnamed')),
    });
  }
  const waived = new Set(waivers.filter((w) => !bad.includes(w)).map((w) => normTarget(w.item)));
  const stale = [...waived].filter((t) => !byTarget.has(t));
  const flagged = [...byTarget.keys()].filter((t) => !waived.has(t)).sort();

  notes.push(
    `navigation: ${files.length} file(s) scanned; ${byTarget.size} non-root replace target(s), ${waived.size - stale.length} waived; ` +
      `${dynamic} dynamic target(s) not resolved — read those call sites by hand`,
  );
  if (stale.length) notes.push(`navigation: ${stale.length} waiver(s) no longer needed — remove: ${stale.join(', ')}`);
  if (flagged.length) {
    failures.push({
      id: 'navigation:replace',
      msg:
        `${flagged.length} drill-down target(s) are reached by replacing the navigation stack, so Back has nothing to ` +
        'return to, the back gesture is dead and leaving animates forwards. Push them, or waive with a reason.',
      items: flagged.map((t) => `${t} — ${byTarget.get(t).join(', ')}`),
    });
  }
  return { notes, failures };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = process.argv.indexOf('--config');
  const cfgPath = resolve(ci > 0 ? process.argv[ci + 1] : 'parity.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const { notes, failures } = runNavigation(cfg, resolve(dirname(cfgPath), cfg.root ?? '.'));
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) {
    console.log(`\n  ✗ ${f.id}: ${f.msg}`);
    for (const i of f.items ?? []) console.log(`      ${i}`);
  }
  console.log(failures.length ? '\n[parity-navigation] FAIL' : '\n[parity-navigation] ok');
  process.exit(failures.length ? 1 : 0);
}
