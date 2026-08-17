#!/usr/bin/env node
// Check L — every artifact belongs to the run that claims to have produced it.
//
// WHY THIS EXISTS
// ---------------
// The output directory is a single untracked tree with no locking: captures, semantics
// dumps, api bags, findings.json and the filing ledger all live there. Nothing stops a
// second agent — or a stray test run — writing into it while a run is in progress.
//
// Every other validity check in this harness was built for STALE inputs. `visual-review-
// stale` compares a review against its captures; `capture-columns-skewed` compares the two
// columns' timestamps. Neither can see CONCURRENT writes, because a concurrent write looks
// fresh and looks consistent. The board then compares two agents rather than two clients,
// and reports it with total confidence.
//
// Observed 2026-08-17 in `tutored`: a second session re-ran the reviewer mid-analysis. Its
// findings replaced the first session's between two reads of the same file. The changing
// results were attributed to model non-determinism and written up as a measured property
// of the reviewer — a conclusion drawn from contaminated state, by a harness whose entire
// purpose is refusing to draw conclusions from contaminated state.
//
// WHAT IT CHECKS
// --------------
// run.sh writes `<out>/.run.json` before capturing and closes it with `finishedAt` after.
// An artifact whose mtime falls outside that window was not produced by this run:
//   · older than startedAt  → a leftover the run did not refresh (partial/subset run)
//   · newer than finishedAt → something wrote after the run ended (another session)
//
// Missing stamp is a NOTE, not a failure: repos vendor this skill without run.sh, and a
// red gate for a check nobody opted into gets the check deleted rather than adopted.
//
// Usage: node parity-session.mjs [--config parity.config.json]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const GRACE_MS = 5000; // filesystem timestamp granularity and the gap between stages

export function runSession(cfg, root) {
  const notes = [];
  const failures = [];
  const out = resolve(root, process.env.PARITY_OUT ?? cfg.out ?? 'parity-out');
  const stampPath = join(out, '.run.json');

  if (!existsSync(stampPath)) {
    notes.push(
      'session: no .run.json — cannot tell which run produced these artifacts. ' +
        'Concurrent or stray writes are undetectable; produce captures via the pipeline script.',
    );
    return { notes, failures };
  }

  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  } catch {
    failures.push({ id: 'session:stamp', msg: `${stampPath} is unreadable — cannot attribute any artifact to a run.` });
    return { notes, failures };
  }

  const started = Date.parse(stamp.startedAt ?? '');
  const finished = Date.parse(stamp.finishedAt ?? '');
  if (Number.isNaN(started)) {
    failures.push({ id: 'session:stamp', msg: '.run.json has no usable startedAt.' });
    return { notes, failures };
  }
  if (Number.isNaN(finished)) {
    // An unclosed stamp means the run died or is still going. Either way its outputs are
    // not a complete set, and grading them reports on a half-written board.
    failures.push({
      id: 'session:incomplete',
      msg:
        `Run "${stamp.runId}" started ${stamp.startedAt} and never recorded finishedAt. It ` +
        `crashed or is still running, so these artifacts are a partial set. Re-run the pipeline.`,
    });
    return { notes, failures };
  }

  const strays = [];
  for (const col of ['web', 'mobile']) {
    const dir = join(out, col);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) {
      const m = statSync(join(dir, f)).mtimeMs;
      if (m < started - GRACE_MS) strays.push(`${col}/${f}: predates the run (leftover, not refreshed)`);
      else if (m > finished + GRACE_MS) strays.push(`${col}/${f}: written AFTER the run finished (concurrent writer)`);
    }
  }

  if (strays.length) {
    failures.push({
      id: 'session:foreign-artifacts',
      msg:
        `${strays.length} artifact(s) were not produced by run "${stamp.runId}" ` +
        `(${stamp.startedAt} → ${stamp.finishedAt}). The board is comparing files from different ` +
        `runs, and possibly from different agents — every finding below is suspect. ` +
        `Isolate the run with PARITY_SESSION, then re-run the full pipeline.`,
      items: strays.slice(0, 20),
    });
    return { notes, failures };
  }

  notes.push(`session: all artifacts belong to run "${stamp.runId}" (${stamp.mode ?? 'full'})`);
  return { notes, failures };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = process.argv.indexOf('--config');
  const cfgPath = resolve(ci > 0 ? process.argv[ci + 1] : 'parity.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const root = resolve(dirname(cfgPath), cfg.root ?? '.');
  const { notes, failures } = runSession(cfg, root);
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) {
    console.log(`\n  ✗ ${f.id}: ${f.msg}`);
    for (const i of f.items ?? []) console.log(`      ${i}`);
  }
  console.log(failures.length ? '\n[parity-session] FAIL' : '\n[parity-session] ok');
  process.exit(failures.length ? 1 : 0);
}
