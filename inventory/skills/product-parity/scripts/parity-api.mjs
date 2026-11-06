#!/usr/bin/env node
// Check J — API parity. Did both clients ask for the same data on the same screen?
//
// WHY THIS EXISTS
// ---------------
// Two clients can render the same pixels from different data, or one can silently skip a
// call the other makes — a missing enrichment fetch, a dropped count, a list rendered from
// a stale cache. Nothing else in this harness sees it: screenshots compare appearance,
// semantics compare controls, geometry compares alignment. A screen can be pixel-perfect
// and wrong underneath.
//
// WHAT IT COMPARES
// ----------------
//   declared  — the manifest's `api` array for the capture (what the screen is SUPPOSED
//               to need)
//   source    — keys in <out>/api/<id>.json, recorded by the source capture
//   mirror    — `consumed` in <out>/api/<id>.<mirror column>.json (default `mobile`),
//               recorded by the mirror
//
// HONEST LIMIT — READ BEFORE TRUSTING THIS
// ----------------------------------------
// The mirror record is what the client ASKED THE FIXTURE BAG FOR, not proof that a network
// call happened: the mirror harness is fed a bag rather than hitting a server. That still
// makes the comparable claim — "this screen wanted GET /api/chats" — but it is weaker than
// the source side, and this check says so in its own output rather than letting the reader
// assume symmetry. If the mirror ever makes live calls, record those instead and delete
// this paragraph.
//
// Query strings are ignored on both sides: `GET /api/chats?limit=20` and `GET /api/chats`
// are the same endpoint for parity purposes, and treating them as different would fail on
// pagination defaults that are not a parity concern.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { columns } from './parity-columns.mjs';

const stripQuery = (k) => String(k).split('?')[0].trim();

// THE BAG CONTRACT. A source bag, <out>/api/<id>.json, maps "METHOD /path" to the parsed
// response body — or, when there is no body to record, to exactly one marker:
//   { "_parity": { "kind": "error" | "non-json" | "stub", "status": <int>, "reason": "…" } }
// A marker never replaces a body already recorded for the same key, and a mirror harness
// treats a marker as "no data", never as a response.
//
// Observed 2026-11-07: a capture invented three marker shapes; a failed read of a repeat
// call overwrote good recordings (status 200 every time), and the mirror harness decoded
// the markers as data and crashed 19 of 31 captures. Nothing checked the values, only keys.
const MARKER_KINDS = new Set(['error', 'non-json', 'stub']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const markerish = (v) => isObject(v) && Object.keys(v).some((k) => k.startsWith('_parity') || k.startsWith('__'));
const validMarker = (v) =>
  isObject(v) &&
  Object.keys(v).length === 1 &&
  isObject(v._parity) &&
  MARKER_KINDS.has(v._parity.kind) &&
  Number.isInteger(v._parity.status);

function checkBags(apiDir, mirrorId, notes, failures) {
  if (!existsSync(apiDir)) return;
  const badShape = [];
  const readFailures = [];
  let markers = 0;
  const withMarkers = new Set();
  const files = readdirSync(apiDir).filter((f) => f.endsWith('.json') && !f.endsWith(`.${mirrorId}.json`)).sort();
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    let bag;
    try {
      bag = JSON.parse(readFileSync(join(apiDir, f), 'utf8'));
    } catch {
      badShape.push(`${id}: not valid JSON`);
      continue;
    }
    if (!isObject(bag)) {
      badShape.push(`${id}: not an object of "METHOD /path" keys`);
      continue;
    }
    for (const [key, value] of Object.entries(bag)) {
      if (!markerish(value)) continue;
      if (!validMarker(value)) {
        badShape.push(`${id}: ${key}`);
        continue;
      }
      markers++;
      withMarkers.add(id);
      const { kind, status } = value._parity;
      if (kind === 'error' && status >= 200 && status < 300) readFailures.push(`${id}: ${key} (status ${status})`);
    }
  }
  if (markers) notes.push(`api bags: ${markers} marker(s) across ${withMarkers.size} capture(s) — recorded as no data, not as responses`);
  if (badShape.length) {
    failures.push({
      id: 'api-bag',
      msg:
        `${badShape.length} bag entr(ies) carry a marker that is not the documented one, so a mirror harness ` +
        `may decode it as data. Write exactly { "_parity": { "kind", "status", "reason" } } (see REFERENCE.md, check J).`,
      items: badShape,
    });
  }
  if (readFailures.length) {
    failures.push({
      id: 'api-bag:2xx-error',
      msg:
        `${readFailures.length} bag entr(ies) record an error for a request the server answered with 2xx — the ` +
        `capture failed to read the body, not the server. Fix the capture; never let a marker replace a ` +
        `body already recorded for the same key.`,
      items: readFailures,
    });
  }
}
const setOf = (arr) => new Set(arr.map(stripQuery).filter(Boolean));

export function runApi(cfg, root) {
  const notes = [];
  const failures = [];
  const outDir = resolve(root, process.env.PARITY_OUT ?? cfg.out ?? 'parity-out');
  const manifestPath = resolve(root, cfg.manifest ?? 'scripts/parity/parity-manifest.json');
  if (!existsSync(manifestPath)) return { notes, failures };

  const captures = JSON.parse(readFileSync(manifestPath, 'utf8')).captures ?? [];
  const waived = new Set(cfg.api?.waivers?.map((w) => w.capture) ?? []);
  const { source, mirror } = columns(cfg);
  checkBags(join(outDir, 'api'), mirror.id, notes, failures);

  let compared = 0;
  let mirrorMissing = 0;

  for (const c of captures) {
    const declared = setOf(c.api ?? []);
    if (!declared.size || waived.has(c.id)) continue;

    const webPath = join(outDir, 'api', `${c.id}.json`);
    const mobPath = join(outDir, 'api', `${c.id}.${mirror.id}.json`);
    if (!existsSync(webPath)) continue;

    if (!existsSync(mobPath)) {
      // Not a failure: the mirror may not have been captured in this run. Counted and
      // reported, because silence about missing coverage is how a check becomes decoration.
      mirrorMissing++;
      continue;
    }

    const web = setOf(Object.keys(JSON.parse(readFileSync(webPath, 'utf8'))));
    const mobile = setOf(JSON.parse(readFileSync(mobPath, 'utf8')).consumed ?? []);
    compared++;

    // Only DECLARED endpoints are asserted. Comparing full key sets would fail constantly
    // on passive client-side traffic the manifest never claimed either screen needs.
    const webMissing = [...declared].filter((d) => !web.has(d));
    const mobMissing = [...declared].filter((d) => !mobile.has(d));

    // Bucket by who skipped what: only the intersection is a stale declaration, and a
    // one-sided gap must not hide behind it.
    const neither = webMissing.filter((d) => mobMissing.includes(d));
    const onlyMob = mobMissing.filter((d) => !neither.includes(d));
    const onlyWeb = webMissing.filter((d) => !neither.includes(d));

    if (onlyMob.length) {
      failures.push({
        id: `api-parity:${c.id}`,
        msg:
          `The ${mirror.label} did not request ${JSON.stringify(onlyMob)} on "${c.id}" while the ${source.label} did. ` +
          `The two clients built this screen from different data — invisible to every ` +
          `pixel, semantics and geometry check. Either the mirror is missing a fetch, or ` +
          `the manifest over-declares and should be corrected.`,
      });
    }
    if (onlyWeb.length) {
      failures.push({
        id: `api-parity:${c.id}`,
        msg:
          `The ${source.label} did not request ${JSON.stringify(onlyWeb)} on "${c.id}" while the ${mirror.label} did. ` +
          `The source of truth is the one skipping a declared endpoint — check the manifest ` +
          `before assuming the client is wrong.`,
      });
    }
    if (neither.length) {
      // Both missing means the DECLARATION is wrong, not the clients. Saying "both clients
      // are broken" here would send someone hunting a bug that does not exist. It still
      // fails: a stale entry means the capture no longer exercises what it claims to.
      failures.push({
        id: `api-parity:${c.id}`,
        msg:
          `declared ${JSON.stringify(neither)} requested by NEITHER client on "${c.id}". The ` +
          `manifest entry is stale, not the clients — the capture no longer shows the screen state ` +
          `it claims to. Re-seed that state, or correct the manifest's api list.`,
      });
    }
  }

  if (compared) {
    notes.push(
      `api: ${compared} capture(s) compared` +
        (mirrorMissing ? `, ${mirrorMissing} with no mirror record` : '') +
        ` — the mirror side records what the client ASKED THE FIXTURE BAG for, not a live call`
    );
  }
  return { notes, failures };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = process.argv.indexOf('--config');
  const cfgPath = resolve(ci > 0 ? process.argv[ci + 1] : 'parity.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const root = resolve(dirname(cfgPath), cfg.root ?? '.');
  const { notes, failures } = runApi(cfg, root);
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) {
    console.log(`\n  ✗ ${f.id}: ${f.msg}`);
    for (const i of f.items ?? []) console.log(`      ${i}`);
  }
  console.log(failures.length ? '\n[parity-api] FAIL' : '\n[parity-api] ok');
  process.exit(failures.length ? 1 : 0);
}
