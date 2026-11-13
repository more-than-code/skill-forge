#!/usr/bin/env node
// Check Q — journeys. Can the user get back, and does an action land where the source's does?
//
// WHY THIS EXISTS
// ---------------
// Every other check reads one screen at a time, and every capture opens its route directly. A
// screen reached by replacing the navigation stack and one reached by pushing onto it produce
// the same capture, so nothing in the harness could see how the user MOVES. Observed
// 2026-11-13 on one project: an End User pass on the mirror found nine back-navigation
// defects the gate had passed — Back that did nothing, an edge swipe that did nothing, Back
// that skipped the list a record was opened from, and an action that opened a new chat
// where the source reopens the existing one.
//
// WHAT IT COMPARES
// ----------------
//   manifest.journeys  [{ id, start: <capture id>, steps: [{ do: <step name>, expect: <capture id> }] }]
//   <out>/journeys/<id>.<column>.json   { journey, steps: [{ do, route, popped?, canPop? }] }
//                                       written by EACH harness, one per column
//
// For every step, each client's landing `route` must match the `expect` capture's route FOR
// THAT CLIENT'S COLUMN (the two clients may spell routes differently). Path segments written
// `[x]` or `:x` match any one segment; query keys on the capture's route must be present on
// the landing with the same value (`?chat=c1` is how "reopen the existing chat" is told apart
// from "open a new one").
//
//   journeys:landing         a client landed somewhere other than `expect`
//   journeys:dead-end        `back` / `tap-back` popped nothing, or stayed where it was
//   journeys:cannot-pop      the mirror landed on a non-root that cannot pop (no back gesture,
//                            no pop animation — the structural cause of both)
//   journeys:missing         no artifact for a column, or its steps differ from the manifest
//   journeys:unknown-capture `start` / `expect` names no capture, or `start` is not a root
//   journeys:stale           an artifact older than the run stamp (.run.json startedAt)
//
// `start` must be a navigation root: a mirror harness reaches its start route by replacing the
// stack, so a deep start has nothing beneath it and `back` would test nothing. Drill-downs are
// reached by steps.
//
// Required: with no journeys and no `journeys.optOut` reason the check FAILS, because a check
// nobody configured reads as green. See JOURNEYS.md.
//
// Usage: node parity-journeys.mjs [--config parity.config.json]
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { columns } from './parity-columns.mjs';

const GRACE_MS = 5000;
const BACK_STEPS = new Set(['back', 'tap-back']);

function pathMatcher(template) {
  const re = new RegExp(
    '^' +
      template
        .split('/')
        .map((seg) =>
          (seg.startsWith('[') && seg.endsWith(']')) || seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/') +
      '$',
  );
  return (p) => re.test(p);
}

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/$/, '') : p);
const splitRoute = (r) => {
  const [p, q = ''] = String(r).split('#')[0].split('?');
  return { path: trimSlash(p || '/'), query: new URLSearchParams(q) };
};

// Does `route` (a real location) satisfy `template` (a manifest route)?
export function routeMatches(template, route) {
  const t = splitRoute(template);
  const r = splitRoute(route);
  if (!pathMatcher(t.path)(r.path)) return false;
  for (const [key, value] of t.query) {
    const wild = value.startsWith(':') || (value.startsWith('[') && value.endsWith(']'));
    if (!r.query.has(key) || (!wild && r.query.get(key) !== value)) return false;
  }
  return true;
}

// Roots are compared on the path only; a query on a root (`/?tab=x`) is ignored, as in check R.
const isRoot = (roots, route) => roots.some((t) => pathMatcher(splitRoute(t).path)(splitRoute(route).path));
const SAFE_ID = /^[\w.-]+$/;

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function runJourneys(cfg, root) {
  const notes = [];
  const failures = [];
  const COLS = columns(cfg);
  const manifest = readJson(resolve(root, cfg.manifest ?? 'scripts/parity/parity-manifest.json')) ?? {};
  const journeys = Array.isArray(manifest.journeys) ? manifest.journeys : [];
  const optOut = typeof cfg.journeys?.optOut === 'string' ? cfg.journeys.optOut.trim() : '';

  if (!journeys.length) {
    if (optOut) notes.push(`journeys: opted out — ${optOut}`);
    else
      failures.push({
        id: 'journeys-not-configured',
        msg:
          'no journeys are declared, so nothing checks that the user can get back or that an action lands where the ' +
          "source's does. Add manifest.journeys (JOURNEYS.md), or set journeys.optOut to the reason this mirror needs none.",
      });
    return { notes, failures };
  }

  const roots = Array.isArray(cfg.navigation?.roots) ? cfg.navigation.roots.filter((r) => typeof r === 'string') : [];
  const captures = new Map(
    (Array.isArray(manifest.captures) ? manifest.captures : []).filter((c) => typeof c?.id === 'string').map((c) => [c.id, c]),
  );
  const out = resolve(root, process.env.PARITY_OUT ?? cfg.out ?? 'parity-out');
  const stamp = readJson(join(out, '.run.json'));
  const startedAt = Date.parse(stamp?.startedAt ?? '');

  const sides = [
    { col: COLS.source.id, mirror: false },
    { col: COLS.mirror.id, mirror: true },
  ];
  // A capture's route for one column. The source column may also be spelled `source`; a capture
  // with no mirror route is taken to use the source route (most mirrors share the scheme).
  const routeOf = (capture, side) => {
    const own = capture?.[side.col]?.route ?? (side.mirror ? capture?.mirror?.route : capture?.source?.route);
    const r = own ?? (side.mirror ? capture?.[COLS.source.id]?.route ?? capture?.source?.route : undefined);
    return typeof r === 'string' && r ? r : null;
  };

  const found = { landing: [], 'dead-end': [], 'cannot-pop': [], missing: [], 'unknown-capture': [], stale: [] };
  let unrecordedPop = 0;
  const seen = new Set();

  for (const j of journeys) {
    const id = typeof j?.id === 'string' ? j.id : String(j?.id ?? 'unnamed');
    const steps = Array.isArray(j?.steps) ? j.steps : [];
    const bad = [];
    // The id names the artifact file, so it must not be able to leave <out>/journeys.
    if (!SAFE_ID.test(id)) bad.push(`${id}: id must be letters, digits, "-", "_" or "."`);
    else if (seen.has(id)) bad.push(`${id}: declared twice — both would share one artifact file`);
    seen.add(id);
    const start = captures.get(j?.start);
    const mirrorSide = sides[1];
    if (!start) bad.push(`${id}: start ${j?.start ?? '(none)'} is not a capture id`);
    else if (!isRoot(roots, routeOf(start, mirrorSide) ?? '')) {
      // The mirror harness reaches `start` by replacing the stack, so it is the MIRROR's route
      // that must be a root; `navigation.roots` is spelled in the mirror's route scheme.
      bad.push(
        `${id}: start ${j.start} (${routeOf(start, mirrorSide) ?? 'no route'} on ${mirrorSide.col}) is not in navigation.roots` +
          (roots.length ? '' : ' — navigation.roots is not set'),
      );
    }
    if (!steps.length) bad.push(`${id}: has no steps`);
    steps.forEach((s, i) => {
      if (typeof s?.do !== 'string' || !s.do.trim()) bad.push(`${id} step ${i + 1}: needs a "do" step name`);
      const target = captures.get(s?.expect);
      if (!target) bad.push(`${id} step ${i + 1}: expect ${s?.expect ?? '(none)'} is not a capture id`);
      else for (const side of sides) if (!routeOf(target, side)) bad.push(`${id} step ${i + 1}: capture ${s.expect} has no route for ${side.col}`);
    });
    if (bad.length) {
      found['unknown-capture'].push(...bad);
      continue;
    }

    for (const side of sides) {
      const file = join(out, 'journeys', `${id}.${side.col}.json`);
      const art = existsSync(file) ? readJson(file) : null;
      if (!art || !Array.isArray(art.steps)) {
        found.missing.push(`${id} on ${side.col}: no readable ${file.slice(out.length + 1)}`);
        continue;
      }
      const names = art.steps.map((s) => s?.do);
      if (names.length !== steps.length || steps.some((s, i) => s.do !== names[i])) {
        found.missing.push(`${id} on ${side.col}: recorded [${names.join(', ')}], manifest says [${steps.map((s) => s.do).join(', ')}]`);
        continue;
      }
      if (Number.isFinite(startedAt) && statSync(file).mtimeMs < startedAt - GRACE_MS) {
        found.stale.push(`${id} on ${side.col}: written before this run started`);
        continue;
      }
      let prev = routeOf(start, side);
      steps.forEach((s, i) => {
        const rec = art.steps[i];
        const at = `${id} step ${i + 1} (${s.do}) on ${side.col}`;
        const route = typeof rec?.route === 'string' ? rec.route : null;
        const want = routeOf(captures.get(s.expect), side);
        if (route === null) {
          found.missing.push(`${at}: no route recorded`);
          prev = null;
          return;
        }
        const ok = routeMatches(want, route);
        // A back that pops nothing, or leaves the user where they were, is a dead end whatever
        // the manifest expected. `prev` is a template only before the first step.
        const stayed = prev !== null && (i === 0 ? routeMatches(prev, route) : prev === route);
        if (BACK_STEPS.has(s.do) && rec.popped === false) found['dead-end'].push(`${at}: nothing to go back to (still on ${route})`);
        else if (BACK_STEPS.has(s.do) && stayed) found['dead-end'].push(`${at}: stayed on ${route}, expected ${s.expect} (${want})`);
        else if (!ok) found.landing.push(`${at}: landed on ${route}, expected ${s.expect} (${want})`);
        if (side.mirror) {
          if (rec.canPop === false && !isRoot(roots, route)) found['cannot-pop'].push(`${at}: ${route} is not a root but cannot pop`);
          else if (rec.canPop === undefined) unrecordedPop++;
        }
        prev = route;
      });
    }
  }

  const MSG = {
    landing: "a client landed somewhere other than the step's expected screen — on the mirror, usually a replace where the source pushes.",
    'dead-end': 'Back led nowhere: the user is stuck on this screen.',
    'cannot-pop': 'the mirror reached a non-root screen it cannot pop, so the back gesture does nothing and leaving it animates the wrong way. Push it instead of replacing the stack.',
    missing: 'a journey has no matching record from a harness, so nothing about it was checked.',
    'unknown-capture': 'a journey is malformed: an unknown capture, a capture with no route, no steps, a bad id, or a start that is not a root.',
    stale: 'a journey record predates this run, so it describes an older build.',
  };
  for (const [key, items] of Object.entries(found)) {
    if (items.length) failures.push({ id: `journeys:${key}`, msg: `${items.length} — ${MSG[key]}`, items });
  }
  notes.push(`journeys: ${journeys.length} journey(s), ${journeys.reduce((n, j) => n + (j?.steps?.length ?? 0), 0)} step(s) per client`);
  if (!Number.isFinite(startedAt)) notes.push('journeys: no .run.json startedAt — stale journey records cannot be detected');
  if (unrecordedPop) notes.push(`journeys: ${unrecordedPop} mirror step(s) recorded no canPop — can-pop is unchecked there`);
  return { notes, failures };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = process.argv.indexOf('--config');
  const cfgPath = resolve(ci > 0 ? process.argv[ci + 1] : 'parity.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const { notes, failures } = runJourneys(cfg, resolve(dirname(cfgPath), cfg.root ?? '.'));
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) {
    console.log(`\n  ✗ ${f.id}: ${f.msg}`);
    for (const i of f.items ?? []) console.log(`      ${i}`);
  }
  console.log(failures.length ? '\n[parity-journeys] FAIL' : '\n[parity-journeys] ok');
  process.exit(failures.length ? 1 : 0);
}
