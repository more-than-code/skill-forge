#!/usr/bin/env node
// Check M — the captures are newer than the source UI they claim to show.
//
// WHY THIS EXISTS
// ---------------
// Every other validity check compares artifacts with EACH OTHER: the review with its
// captures, one column with the other. None compares the captures with the product. A
// board captured once and never re-run stays internally consistent forever, and the gate
// stays green while the source client moves on underneath it.
//
// Observed 2026-11-07 on one project: the source client added a logo to its header, login
// and standalone pages; the mirror kept plain text. The last full capture run was nearly
// three months old, so no capture contained the logo, and every check passed — two of them
// because the mirror's text matched the logo's alt text.
//
// WHAT IT CHECKS
// --------------
//   freshness.paths      source-client folders whose commits change what a capture shows
//                        (routes, components, brand and design assets). Any commit to them
//                        newer than the captures fails `captures-stale`, listing the commits.
//   freshness.optOut     a reason this project does not need the check. With neither paths
//                        nor optOut the check FAILS (`freshness-not-configured`); a path that
//                        does not exist fails `freshness-unresolved`.
//   capture.sourceFiles  optional, per manifest entry: the same check for one screen, so a
//                        change to that screen's files flags that screen by name.
//
// Commits only: uncommitted edits do not count. The capture time is the OLDER column's
// newest PNG — a pair is only as fresh as its staler half.
//
// Usage: node parity-freshness.mjs [--config parity.config.json]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { columns } from './parity-columns.mjs';

const gitEnv = () => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return env;
};

// Commits touching `abs`, newest first: { at (ms), hash, date, subject }. null when not in git.
function commitsTouching(abs) {
  const cwd = statSync(abs).isDirectory() ? abs : dirname(abs);
  try {
    const out = execFileSync('git', ['log', '-n', '200', '--format=%ct%x09%h%x09%cs%x09%s', '--', abs], {
      cwd,
      env: gitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ct, hash, date, ...subject] = line.split('\t');
        return { at: Number(ct) * 1000, hash, date, subject: subject.join('\t') };
      });
  } catch {
    return null;
  }
}

function newestPng(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .reduce((max, f) => Math.max(max, statSync(join(dir, f)).mtimeMs), 0);
}

function since(paths, root, capturedAt, notes) {
  const seen = new Map();
  for (const p of paths) {
    const abs = resolve(root, p);
    if (!existsSync(abs)) {
      notes.push(`freshness: ${p} does not exist — not checked`);
      continue;
    }
    const commits = commitsTouching(abs);
    if (!commits) {
      notes.push(`freshness: ${p} is not in a git repository — not checked`);
      continue;
    }
    for (const c of commits) if (c.at > capturedAt) seen.set(c.hash, c);
  }
  return [...seen.values()].sort((a, b) => b.at - a.at);
}

export function runFreshness(cfg, root) {
  const notes = [];
  const failures = [];
  const paths = cfg.freshness?.paths ?? [];
  // Unconfigured is a failure, not a note: an info line reads as green, and this check is the
  // only one that knows a capture is older than the UI it claims to show. Observed 2026-11-07:
  // captures 3 months old, "freshness: NOT configured" printed, gate green.
  const optOut = typeof cfg.freshness?.optOut === 'string' ? cfg.freshness.optOut.trim() : '';
  if (!paths.length) {
    if (optOut) notes.push(`freshness: opted out — ${optOut}`);
    else
      failures.push({
        id: 'freshness-not-configured',
        msg:
          'freshness is not configured, so captures older than the source UI they show go undetected. ' +
          'Set freshness.paths to the source client\'s UI folders (routes, components, brand assets), ' +
          'or set freshness.optOut to the reason this project does not need it.',
      });
    return { notes, failures };
  }
  // A configured path that resolves to nothing disables the check as surely as no config.
  const unresolved = paths.filter((p) => !existsSync(resolve(root, p)));
  if (unresolved.length) {
    failures.push({
      id: 'freshness-unresolved',
      msg: `${unresolved.length} freshness.paths entr(ies) do not exist, so commits to them are never seen. Fix the path or remove it.`,
      items: unresolved,
    });
  }
  const out = resolve(root, process.env.PARITY_OUT ?? cfg.out ?? 'parity-out');
  const { source, mirror } = columns(cfg);
  const stamps = [newestPng(join(out, source.id)), newestPng(join(out, mirror.id))].filter(Boolean);
  if (!stamps.length) {
    notes.push('freshness: no captures yet — nothing to compare');
    return { notes, failures };
  }
  const capturedAt = Math.min(...stamps);
  const fmt = (c) => `${c.hash} ${c.date} ${c.subject}`;

  const commits = since(paths, root, capturedAt, notes);
  if (commits.length) {
    failures.push({
      id: 'captures-stale',
      msg:
        `The captures are older than ${commits.length} source commit(s) touching ${paths.join(', ')} — ` +
        `the board shows a UI that no longer exists, so every check that reads it is grading the past. ` +
        `Re-run the full capture pipeline (both columns), then the reviewer.`,
      items: commits.slice(0, 10).map(fmt),
    });
  } else {
    notes.push(`freshness: captures are newer than the last commit to ${paths.join(', ')}`);
  }

  // Per screen, where the manifest names a screen's own files.
  const manifestPath = resolve(root, cfg.manifest ?? 'scripts/parity/parity-manifest.json');
  const captures = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).captures ?? [] : [];
  const stale = [];
  for (const c of captures.filter((x) => x.sourceFiles?.length)) {
    const own = [join(out, source.id, `${c.id}.png`), join(out, mirror.id, `${c.id}.png`)]
      .filter(existsSync)
      .map((p) => statSync(p).mtimeMs);
    if (own.length < 2) continue; // an uncaptured screen is check A's business, not this one's
    const newer = since(c.sourceFiles, root, Math.min(...own), notes);
    if (newer.length) stale.push(`${c.id}: ${newer.length} commit(s) since its capture — latest ${fmt(newer[0])}`);
  }
  if (stale.length) {
    failures.push({
      id: 'captures-stale-screens',
      msg: `${stale.length} screen(s) changed in the source after they were captured. Re-capture them.`,
      items: stale,
    });
  }
  return { notes, failures };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = process.argv.indexOf('--config');
  const cfgPath = resolve(ci > 0 ? process.argv[ci + 1] : 'parity.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const root = resolve(dirname(cfgPath), cfg.root ?? '.');
  const { notes, failures } = runFreshness(cfg, root);
  for (const n of notes) console.log(`  · ${n}`);
  for (const f of failures) {
    console.log(`\n  ✗ ${f.id}: ${f.msg}`);
    for (const i of f.items ?? []) console.log(`      ${i}`);
  }
  console.log(failures.length ? '\n[parity-freshness] FAIL' : '\n[parity-freshness] ok');
  process.exit(failures.length ? 1 : 0);
}
