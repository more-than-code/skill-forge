#!/usr/bin/env node
// Check I — declared affordances are real, activatable controls.
//
// WHY THIS EXISTS
// ---------------
// Every other check in this harness sees appearance. None of them can see whether a
// control DOES anything:
//   · the vision review compares two PNGs — a live button and a dead icon are identical;
//   · token conformance compares declared values;
//   · geometry (check H) measures alignment;
//   · and parity only asks "does mobile match web", never "is either one right", so an
//     affordance broken on BOTH clients passes by definition.
//
// Observed 2026-08-16 in `tutored`: a pronunciation play control rendered perfectly and
// did nothing. Every gate was green. Appearance was specified, so appearance was gated;
// behaviour was not specified, so nothing gated it.
//
// WHAT IT CHECKS
// --------------
// The capture harness dumps an accessibility tree per capture. An affordance declared
// here must resolve to a node that is actually exposed as a control — `role: button`
// (or explicitly tappable). That is the one machine-checkable half of an interaction
// spec, and it is the half that catches a decorative icon standing in for a button.
//
// SCOPE — MOBILE ONLY, AND SAID OUT LOUD
// --------------------------------------
// Only the Flutter harness writes semantics today; the web capture writes none. So this
// is a WITHIN-CLIENT assertion, not a parity comparison, and it reports that in every
// note it emits. Do not let it read as cross-client coverage — a check that overstates
// what it verified is worse than no check. When the web capture grows an equivalent
// accessibility dump, compare the two sides here and update this comment.
//
// SCOPE DISCIPLINE
// ----------------
// Declare affordances whose behaviour is NOT obvious from appearance: anything with a
// busy state, a failure mode, or a destructive effect — and anything a design guideline
// says must be a real control. Do not declare every button on every screen; labels drift
// with copy, and a check that cries wolf gets switched off.
//
// Usage: node parity-interactive.mjs [--config parity.config.json] [--json]
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

/**
 * Nodes whose label matches. Matching is on `labelContains` (substring) rather than
 * equality: semantics labels concatenate a control's whole subtree — a chat row arrives
 * as "View Pip's profile\nP\n我已为 UI parity" — so equality would be unmaintainable and
 * would fail on every copy change.
 */
function findNodes(nodes, needle) {
  // Case-INSENSITIVE. Labels come from product copy, and copy capitalisation is not a
  // contract: `l10n.send` is lowercase "send" while the obvious declaration reads "Send".
  // A case-sensitive miss reports "affordance gone" for a control that is present and
  // correct — a false failure, which is the fastest way to get a check switched off.
  const want = needle.toLowerCase();
  return nodes.filter(
    (n) => typeof n.label === 'string' && n.label.toLowerCase().includes(want)
  );
}

export function runInteractive(cfg, root) {
  const declared = cfg.interactive?.affordances ?? [];
  const notes = [];
  const failures = [];
  if (!declared.length) return { notes, failures };

  const outDir = resolve(root, cfg.out ?? 'parity-out');
  const semDir = join(outDir, 'semantics');
  const waived = new Set(cfg.interactive?.waivers?.map((w) => w.affordance) ?? []);

  if (!existsSync(semDir)) {
    notes.push('interactive: no semantics/ dump — check skipped (run the mobile capture first)');
    return { notes, failures };
  }

  for (const a of declared) {
    if (waived.has(a.name)) {
      const w = cfg.interactive.waivers.find((x) => x.affordance === a.name);
      notes.push(`interactive: ${a.name} WAIVED — ${w.reason}`);
      continue;
    }
    const file = join(semDir, `${a.capture}.json`);
    if (!existsSync(file)) {
      notes.push(`interactive: ${a.name} skipped — no semantics for capture "${a.capture}"`);
      continue;
    }
    const nodes = JSON.parse(readFileSync(file, 'utf8')).nodes ?? [];
    const hits = findNodes(nodes, a.labelContains);

    if (!hits.length) {
      // A vanished label is NOT a pass. It usually means the copy changed or the control
      // left the screen — either way the declaration is no longer verifying anything, and
      // silently succeeding is how a check rots into decoration.
      failures.push({
        id: `interactive:${a.name}`,
        msg:
          `No node labelled "${a.labelContains}" in ${a.capture} (mobile). The affordance is ` +
          `either gone, renamed, or off-screen — the declaration verifies nothing as written. ` +
          `Fix the label, fix the capture, or remove the declaration.`,
      });
      continue;
    }

    const activatable = hits.filter((n) => n.role === 'button' || n.tappable === true);
    if (!activatable.length) {
      failures.push({
        id: `interactive:${a.name}`,
        msg:
          `"${a.labelContains}" exists on ${a.capture} (mobile) but is NOT exposed as a control ` +
          `— role=${JSON.stringify(hits.map((n) => n.role))}, tappable=${JSON.stringify(hits.map((n) => n.tappable))}. ` +
          `It renders and cannot be activated: exactly the defect no screenshot comparison can see. ` +
          (a.spec ? `Spec: ${a.spec}` : ''),
      });
      continue;
    }
    notes.push(
      `interactive: ${a.name} ok — ${activatable.length}/${hits.length} matching node(s) ` +
        `activatable on ${a.capture} (MOBILE ONLY; web writes no semantics)`
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
  const { notes, failures } = runInteractive(cfg, root);
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) console.log(`\n  ✗ ${f.id}: ${f.msg}`);
  console.log(failures.length ? '\n[parity-interactive] FAIL' : '\n[parity-interactive] ok');
  process.exit(failures.length ? 1 : 0);
}
