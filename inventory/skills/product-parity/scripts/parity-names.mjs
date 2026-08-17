#!/usr/bin/env node
// Check K — the set of ACTIVATABLE CONTROL NAMES agrees across clients, within a region.
//
// WHY THIS EXISTS
// ---------------
// The vision review cannot see an icon-only affordance change, and no prompt wording fixes
// that: iconography is out of its declared scope, and it is comparing two unlabelled glyphs.
// Measured 2026-08-17 on one confirmed gap — the source client swapped its composer sticker
// button for a reasoning-effort control, the mirror kept the sticker:
//
//   vision review   1 detection in 11 runs   (prompt rewritten twice in between; no effect)
//   this check      every run                (milliseconds, deterministic)
//
// Names are the evidence that survives when pixels do not. The source exposes
// "Reasoning effort: Auto", the mirror exposes "Stickers". Comparing those needs nothing
// recognised from an image.
//
// WHY REGIONS ARE MANDATORY
// -------------------------
// A whole-screen diff drowns. Same capture, measured: 91 interactive nodes on the source
// against 17 on the mirror, because a full-page capture includes the entire scrollback
// while the mirror captures a viewport. 25 raw differences, ~3 real. Filtering by role
// (91 → 19) or by name length does not help, because the survivors are CONTENT — the two
// clients legitimately show different messages.
//
// Scoped to the composer strip, the same data gives 4 differences and all 4 are real.
// So: declare regions of SHARED CHROME, keep the set small, and accept that this check
// says nothing about the rest of the screen. A check that reports 25 findings for 3 real
// ones gets switched off, and then it reports nothing at all.
//
// BOTH SIDES MUST EMIT PAINTED COORDINATES
// ----------------------------------------
// Fractions must be of the PAINTED viewport. A semantics transform that stays in content
// space puts pinned chrome outside the region (the mirror's composer reported y=2376 in an
// 844pt viewport) and the region then matches nothing — a check that is silently vacuous,
// which is worse than one that fails.
//
// Usage: node parity-names.mjs [--config parity.config.json] [--json]
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const norm = (s) =>
  String(s ?? '')
    .split('\n')[0] // mirror labels concatenate a whole subtree; the first line is the name
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const INTERACTIVE = new Set(['button', 'textbox', 'link', 'menuitem', 'tab', 'switch', 'checkbox']);
const roleOf = (r) => (r === 'textarea' || r === 'input' ? 'textbox' : r);

function namesInRegion(nodes, region, pick) {
  const out = new Set();
  for (const n of nodes) {
    const { name, role, fy } = pick(n);
    if (fy == null) continue; // unplaceable node — never guessed at
    if (!(INTERACTIVE.has(roleOf(role)) || n.tappable)) continue;
    if (fy < region.y1 || fy > region.y2) continue;
    const v = norm(name);
    if (v) out.add(v);
  }
  return out;
}

export function runNames(cfg, root) {
  const regions = cfg.names?.regions ?? [];
  const notes = [];
  const failures = [];
  if (!regions.length) return { notes, failures };

  const outDir = resolve(root, process.env.PARITY_OUT ?? cfg.out ?? 'parity-out');
  const semDir = join(outDir, 'semantics');
  const accepted = cfg.names?.accepted ?? {};
  const waived = new Set((cfg.names?.waivers ?? []).map((w) => w.region));

  for (const region of regions) {
    if (waived.has(region.name)) {
      const w = cfg.names.waivers.find((x) => x.region === region.name);
      notes.push(`names: ${region.name} WAIVED — ${w.reason}`);
      continue;
    }
    const webFile = join(semDir, `${region.capture}.web.json`);
    const mobFile = join(semDir, `${region.capture}.json`);

    // Degrade to a NOTE, never a failure. Repos vendor this skill without a source-side
    // accessibility dump; a red gate for a check they never opted into is how a check
    // gets deleted rather than adopted.
    if (!existsSync(webFile) || !existsSync(mobFile)) {
      notes.push(
        `names: ${region.name} skipped — missing ${!existsSync(webFile) ? 'source' : 'mirror'} ` +
          `semantics for "${region.capture}". This region is NOT covered; do not read the gate as checking it.`,
      );
      continue;
    }

    const web = JSON.parse(readFileSync(webFile, 'utf8')).nodes ?? [];
    const mob = JSON.parse(readFileSync(mobFile, 'utf8')).nodes ?? [];

    // Coordinates must be PAINTED fractions. A dump that records layout or document
    // positions puts most nodes outside [0,1], the region then selects a near-random
    // subset, and the diff looks plausible while comparing nothing. Measured 2026-08-17:
    // the source emitter used document space and 72 of 91 nodes fell outside the viewport,
    // including a control ~58,000px above it sitting in a closed panel.
    //
    // Refuse to grade that. A wrong region silently produces a confident answer, which is
    // the failure this harness exists to prevent.
    // Threshold distinguishes WRONG COORDINATE SPACE from ordinary scroll. A control
    // straddling the top edge legitimately has a negative centre (-0.055 measured on a
    // partly-scrolled message row); a control in document space is a whole viewport away
    // or more (-69.571 measured). Anything beyond one viewport in either direction cannot
    // be explained by scroll and means the emitter is wrong.
    const strays = (nodes, get) => nodes.filter((n) => get(n) != null && (get(n) < -1 || get(n) > 2)).length;
    const badWeb = strays(web, (n) => n.y);
    const badMob = strays(mob, (n) => n.fy);
    if (badWeb || badMob) {
      failures.push({
        id: `names:${region.name}`,
        msg:
          `Coordinates are not painted viewport fractions: ` +
          `${badWeb} source node(s) and ${badMob} mirror node(s) fall outside [0,1] on ${region.capture}. ` +
          `The emitter is recording layout or document position, or is including controls the capture ` +
          `never painted. Fix the dump before trusting any region — a region over bad coordinates ` +
          `selects an arbitrary subset and reports a confident, meaningless diff.`,
      });
      continue;
    }
    const W = namesInRegion(web, region, (n) => ({ name: n.name, role: n.role, fy: n.y }));
    const M = namesInRegion(mob, region, (n) => ({ name: n.label, role: n.role, fy: n.fy }));

    // Accepted differences carry provenance, like every other waiver in this harness.
    // A bare list of names is a silence switch: nobody can tell later whether an entry was
    // a considered platform delta or something muted to get a green run.
    const entries = accepted[region.name] ?? [];
    for (const [i, e] of entries.entries()) {
      const missing = ['name', 'reason', 'owner', 'addedOn'].filter((k) => !e?.[k]);
      if (missing.length) {
        throw new Error(
          `names.accepted["${region.name}"][${i}] is missing: ${missing.join(', ')}. ` +
            `An accepted difference is a decision and needs a name on it.`,
        );
      }
    }
    const ok = new Set(entries.map((e) => norm(e.name)));
    const webOnly = [...W].filter((x) => !M.has(x) && !ok.has(x));
    const mobOnly = [...M].filter((x) => !W.has(x) && !ok.has(x));

    if (!W.size && !M.size) {
      // Both empty means the region matched nothing on either side — almost always a bad
      // region, not two clean clients. Reported, because a vacuous check that prints "ok"
      // is the failure mode this whole harness exists to prevent.
      notes.push(
        `names: ${region.name} matched NO controls on either client — the region is probably wrong ` +
          `(y ${region.y1}–${region.y2} on "${region.capture}"). It is verifying nothing.`,
      );
      continue;
    }

    if (webOnly.length || mobOnly.length) {
      failures.push({
        id: `names:${region.name}`,
        msg:
          `Control names differ in "${region.name}" on ${region.capture}.\n` +
          (webOnly.length ? `      source-only (mirror may be missing): ${webOnly.join(' · ')}\n` : '') +
          (mobOnly.length ? `      mirror-only (extra on mirror):       ${mobOnly.join(' · ')}\n` : '') +
          `      matched: ${[...W].filter((x) => M.has(x)).length}. ` +
          `Adjudicate each: a real gap, a copy divergence, or a legitimate platform delta to accept.`,
      });
      continue;
    }
    notes.push(`names: ${region.name} ok — ${W.size} control(s) agree on ${region.capture}`);
  }
  return { notes, failures };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = process.argv.indexOf('--config');
  const cfgPath = resolve(ci > 0 ? process.argv[ci + 1] : 'parity.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const root = resolve(dirname(cfgPath), cfg.root ?? '.');
  const { notes, failures } = runNames(cfg, root);
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) console.log(`\n  ✗ ${f.id}: ${f.msg}`);
  console.log(failures.length ? '\n[parity-names] FAIL' : '\n[parity-names] ok');
  process.exit(failures.length ? 1 : 0);
}
