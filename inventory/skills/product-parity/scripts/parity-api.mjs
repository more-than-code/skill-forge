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
//   web       — keys in parity-out/api/<id>.json, recorded by the web capture
//   mobile    — `consumed` in parity-out/api/<id>.mobile.json, recorded by the mirror
//
// HONEST LIMIT — READ BEFORE TRUSTING THIS
// ----------------------------------------
// The mobile record is what the client ASKED THE FIXTURE BAG FOR, not proof that a network
// call happened: the mirror harness is fed a bag rather than hitting a server. That still
// makes the comparable claim — "this screen wanted GET /api/chats" — but it is weaker than
// the web side, and this check says so in its own output rather than letting the reader
// assume symmetry. If the mirror ever makes live calls, record those instead and delete
// this paragraph.
//
// Query strings are ignored on both sides: `GET /api/chats?limit=20` and `GET /api/chats`
// are the same endpoint for parity purposes, and treating them as different would fail on
// pagination defaults that are not a parity concern.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const stripQuery = (k) => String(k).split('?')[0].trim();
const setOf = (arr) => new Set(arr.map(stripQuery).filter(Boolean));

export function runApi(cfg, root) {
  const notes = [];
  const failures = [];
  const outDir = resolve(root, process.env.PARITY_OUT ?? cfg.out ?? 'parity-out');
  const manifestPath = resolve(root, cfg.manifest ?? 'scripts/parity/parity-manifest.json');
  if (!existsSync(manifestPath)) return { notes, failures };

  const captures = JSON.parse(readFileSync(manifestPath, 'utf8')).captures ?? [];
  const waived = new Set(cfg.api?.waivers?.map((w) => w.capture) ?? []);

  let compared = 0;
  let mirrorMissing = 0;

  for (const c of captures) {
    const declared = setOf(c.api ?? []);
    if (!declared.size || waived.has(c.id)) continue;

    const webPath = join(outDir, 'api', `${c.id}.json`);
    const mobPath = join(outDir, 'api', `${c.id}.mobile.json`);
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

    if (mobMissing.length && !webMissing.length) {
      failures.push({
        id: `api-parity:${c.id}`,
        msg:
          `Mobile did not request ${JSON.stringify(mobMissing)} on "${c.id}" while web did. ` +
          `The two clients built this screen from different data — invisible to every ` +
          `pixel, semantics and geometry check. Either the mirror is missing a fetch, or ` +
          `the manifest over-declares and should be corrected.`,
      });
    } else if (webMissing.length && !mobMissing.length) {
      failures.push({
        id: `api-parity:${c.id}`,
        msg:
          `Web did not request ${JSON.stringify(webMissing)} on "${c.id}" while mobile did. ` +
          `The source of truth is the one skipping a declared endpoint — check the manifest ` +
          `before assuming the client is wrong.`,
      });
    } else if (webMissing.length && mobMissing.length) {
      // Both missing means the DECLARATION is wrong, not the clients. Saying "both clients
      // are broken" here would send someone hunting a bug that does not exist.
      notes.push(
        `api: ${c.id} — declared ${JSON.stringify(webMissing)} requested by NEITHER client; ` +
          `the manifest entry is stale, not the clients`
      );
    }
  }

  if (compared) {
    notes.push(
      `api: ${compared} capture(s) compared` +
        (mirrorMissing ? `, ${mirrorMissing} with no mirror record` : '') +
        ` — mobile side records what the client ASKED THE FIXTURE BAG for, not a live call`
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
  for (const f of failures) console.log(`\n  ✗ ${f.id}: ${f.msg}`);
  console.log(failures.length ? '\n[parity-api] FAIL' : '\n[parity-api] ok');
  process.exit(failures.length ? 1 : 0);
}
