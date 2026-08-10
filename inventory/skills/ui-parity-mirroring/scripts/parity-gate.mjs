#!/usr/bin/env node
// UI parity quality gate — portable. Ships with the `ui-parity-mirroring` skill.
//
// Config-driven so it works in any repo. Point it at a parity.config.json:
//   node <skill>/scripts/parity-gate.mjs --config parity.config.json
// It searches for ./parity.config.json then ./scripts/parity/parity.config.json.
//
// Checks (all skipped gracefully when not configured):
//   A  coverage ratchet — every source-client route needs a capture or dated waiver
//   B  regeneration     — every mirror i18n key must exist in the generated artifact
//   C  copy drift       — shared i18n keys must match the source client
//   D  design tokens    — clients conform to the canonical design system (both, symmetric)
//   E  a11y ratchet     — interactive controls with no accessible name (may only shrink)
//   F  visual ratchet   — LLM findings not present in the accepted baseline
//   G  capture validity — duplicate captures, stale review, skewed columns.
//                         G exists because F is only as honest as its inputs: a
//                         stale review, or two manifest entries that rendered the
//                         same screen, both make F report a confident PASS.
//
// Exit: 0 pass · 1 fail · 2 misconfigured
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const JSON_OUT = argv.includes('--json');

function findConfig() {
  const explicit = flag('--config');
  const candidates = explicit
    ? [explicit]
    : ['parity.config.json', 'scripts/parity/parity.config.json', '.parity/parity.config.json'];
  for (const c of candidates) {
    const p = path.resolve(process.cwd(), c);
    if (existsSync(p)) return p;
  }
  return null;
}

const configPath = findConfig();
if (!configPath) {
  console.error(
    'No parity config found. Create parity.config.json (see the skill\'s parity.config.example.json), or pass --config <path>.'
  );
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const ROOT = path.resolve(path.dirname(configPath), cfg.root ?? '.');
const abs = (p) => path.resolve(ROOT, p);

const failures = [];
const notes = [];

// ---------------------------------------------------------------------------
// A. Coverage ratchet
// ---------------------------------------------------------------------------
// Route discovery is per-framework. `filename` covers file-router frameworks
// (SvelteKit `+page.svelte`, Next.js `page.tsx`, Nuxt, Remix flat-ish trees).
// `list` is the escape hatch for anything else — declare routes explicitly.
function discoverRoutes(source) {
  const spec = source.routes ?? {};
  if (Array.isArray(spec.list)) return [...spec.list].sort();

  const dir = abs(path.join(source.root ?? '.', spec.dir ?? 'src/routes'));
  const marker = spec.filename ?? '+page.svelte';
  if (!existsSync(dir)) return [];
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === marker) {
        const rel = path.relative(dir, path.dirname(p));
        out.push('/' + rel.split(path.sep).filter(Boolean).join('/'));
      }
    }
  })(dir);
  return out.map((r) => (r === '/' ? '/' : r.replace(/\/$/, ''))).sort();
}

// `/tutors/[id]` and `/users/:id` both match a concrete route; `?query` allowed.
function templateMatcher(template) {
  const re = new RegExp(
    '^' +
      template
        .split('/')
        .map((seg) =>
          (seg.startsWith('[') && seg.endsWith(']')) || seg.startsWith(':')
            ? '[^/]+'
            : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        )
        .join('/') +
      '(\\?.*)?$'
  );
  return (route) => re.test(route);
}

function checkCoverage() {
  if (!cfg.source) {
    notes.push('coverage: no `source` configured, check skipped');
    return;
  }
  const manifestPath = abs(cfg.manifest ?? 'scripts/parity/parity-manifest.json');
  if (!existsSync(manifestPath)) {
    failures.push({ check: 'coverage-ratchet', message: `Manifest not found at ${manifestPath}` });
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const waiversPath = abs(cfg.waivers ?? 'scripts/parity/waivers.json');
  const waivers = existsSync(waiversPath) ? JSON.parse(readFileSync(waiversPath, 'utf8')) : { routes: {} };

  const routes = discoverRoutes(cfg.source);
  if (!routes.length) {
    notes.push('coverage: no routes discovered — check source.routes config');
  }
  const captured = manifest.captures.map((c) => c.source?.route ?? c.web?.route).filter(Boolean);

  const uncovered = routes.filter((t) => !captured.some(templateMatcher(t)));
  const unwaived = [];
  let waived = 0;
  for (const r of uncovered) {
    const w = waivers.routes?.[r];
    if (w?.reason && w?.date) waived++;
    else unwaived.push(r);
  }
  notes.push(`coverage: ${routes.length - uncovered.length}/${routes.length} routes captured, ${waived} waived`);

  if (unwaived.length) {
    failures.push({
      check: 'coverage-ratchet',
      message:
        `${unwaived.length} source route(s) have no parity capture and no waiver. An uncaptured screen ` +
        `reads as silence, and silence is indistinguishable from success — add a manifest entry, or a ` +
        `dated waiver (reason + date + owner) in ${path.relative(ROOT, waiversPath)}.`,
      items: unwaived,
    });
  }

  const matchers = routes.map(templateMatcher);
  const orphaned = captured.filter((r) => !matchers.some((m) => m(r)));
  if (orphaned.length) {
    failures.push({
      check: 'stale-manifest',
      message: 'Manifest captures point at source routes that no longer exist.',
      items: orphaned,
    });
  }
}

// ---------------------------------------------------------------------------
// B + C. i18n
// ---------------------------------------------------------------------------
// Single-line entries only. Wrapped/template values are counted as skipped
// rather than guessed: a regex that silently mismatches multi-line values
// invents "missing key" findings and destroys trust in the gate.
function parseKeyValues(file, format) {
  const src = readFileSync(file, 'utf8');
  if (format === 'json' || format === 'arb') {
    const obj = JSON.parse(src);
    return { values: Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('@'))), skipped: 0 };
  }
  // ts-object / js-object: `key: 'value',`
  const values = {};
  let skipped = 0;
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*'((?:[^'\\]|\\.)*)'\s*,?\s*$/);
    if (m) values[m[1]] = m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    else if (/^\s*[A-Za-z0-9_]+\s*:/.test(line)) skipped++;
  }
  return { values, skipped };
}

function checkI18n() {
  const i = cfg.i18n;
  if (!i?.sourceFile || !i?.mirrorFile) {
    notes.push('i18n: not configured, checks skipped');
    return;
  }
  const sf = abs(i.sourceFile);
  const mf = abs(i.mirrorFile);
  if (!existsSync(sf) || !existsSync(mf)) {
    notes.push('i18n: configured files missing, checks skipped');
    return;
  }
  const src = parseKeyValues(sf, i.sourceFormat ?? 'ts-object');
  const mir = parseKeyValues(mf, i.mirrorFormat ?? 'arb');
  if (src.skipped) notes.push(`i18n: ${src.skipped} source entries not single-line, excluded from drift check`);

  if (i.generatedFile) {
    const gf = abs(i.generatedFile);
    if (existsSync(gf)) {
      const gen = readFileSync(gf, 'utf8');
      const missing = Object.keys(mir.values).filter((k) => !gen.includes(`'${k}'`) && !gen.includes(`"${k}"`));
      if (missing.length) {
        failures.push({
          check: 'i18n-regeneration',
          message:
            `${missing.length} mirror i18n key(s) are absent from the generated artifact. ` +
            `Editing the source-of-record file has no runtime effect until it is regenerated.`,
          items: missing.slice(0, 20),
        });
      }
    }
  }

  const shared = Object.keys(src.values).filter((k) => k in mir.values);
  const drift = shared.filter((k) => src.values[k] !== mir.values[k]);
  notes.push(`i18n: ${shared.length} shared keys compared`);
  if (drift.length) {
    failures.push({
      check: 'i18n-copy-drift',
      message: `${drift.length} shared i18n key(s) differ from the source client (source of truth).`,
      items: drift.slice(0, 20).map((k) => `${k}: source=${JSON.stringify(src.values[k])} mirror=${JSON.stringify(mir.values[k])}`),
    });
  }
}


// ---------------------------------------------------------------------------
// E. Unlabelled-affordance ratchet (deterministic — no model)
// ---------------------------------------------------------------------------
// The mirror harness dumps its accessibility/semantics tree per capture. An
// interactive control with no accessible name is invisible to assistive tech,
// AND invisible to any name-based affordance diff — so a thin tree silently
// weakens every other check that depends on it.
//
// Ratcheted, not absolute: existing debt is recorded per capture and may only
// shrink. New unlabelled controls fail the build the moment they appear.
function checkUnlabelled() {
  const out = abs(cfg.out ?? 'parity-out');
  const dir = path.join(out, 'semantics');
  if (!existsSync(dir)) {
    notes.push('a11y: no semantics dumps — mirror harness does not emit them (check skipped)');
    return;
  }
  const baselinePath = abs(cfg.a11yBaseline ?? 'scripts/parity/a11y-baseline.json');
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).unlabelled ?? {} : {};

  const worse = [];
  let totalUnlabelled = 0;
  let totalTappable = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const tappable = (d.nodes ?? []).filter((n) => n.tappable);
    const unlabelled = tappable.filter((n) => !String(n.label ?? '').trim());
    totalTappable += tappable.length;
    totalUnlabelled += unlabelled.length;
    const allowed = baseline[d.capture];
    if (allowed !== undefined && unlabelled.length > allowed) {
      worse.push(`${d.capture}: ${unlabelled.length} unlabelled (baseline ${allowed})`);
    }
  }
  notes.push(`a11y: ${totalUnlabelled}/${totalTappable} interactive controls have no accessible name`);
  if (worse.length) {
    failures.push({
      check: 'unlabelled-affordances',
      message:
        'New interactive controls without an accessible name. They are invisible to assistive ' +
        'technology and to the affordance diff. Give each one a label, or update the baseline ' +
        'deliberately if the count legitimately grew.',
      items: worse,
    });
  }
}


// ---------------------------------------------------------------------------
// F. Design-token conformance (tier 0 — deterministic, no model)
// ---------------------------------------------------------------------------
// The design system is upstream of BOTH clients, so this check is symmetric:
// the source client is as checkable as the mirror. That matters — a bug in the
// source client would otherwise become a specification the mirror is measured
// against (this happened: the webapp rendered "Log out" to guests, the mirror
// correctly rendered "Log in", and the parity review reported the MIRROR wrong).
//
// Colour VALUES are only compared where both sides express them in the same
// notation. Flutter stores sRGB converted from oklch, so value equality there
// is meaningless; coverage (does the client define every canonical token?) is
// the honest check.
// Parse across the whole file, not line by line. A wrapped declaration —
//   --font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
//     'PingFang SC', sans-serif;
// is completely ordinary CSS, and a line-anchored regex never matches it. The
// old version did exactly that and reported such a token as **missing** rather
// than **drifted**, which reads as "the client never defined it" when in fact it
// defined it differently — the opposite diagnosis. Observed 2026-08-03 on
// `--font-sans`. Comments are stripped first so a commented-out declaration
// cannot shadow the real one.
function parseCssVars(file) {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const m of src.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+);/g)) {
    // Collapse the newlines/indentation a wrapped value carries, so comparison
    // is against the value the browser sees, not the source formatting.
    out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  return out;
}


// A token may be written literally in one place and derived in another
// (`6px` vs `calc(var(--radius) * 0.6)`). Those are the same value, and
// reporting them as drift trains people to ignore the check. Resolve simple
// derivations and unit forms to a comparable number before comparing.
function resolveLength(value, vars, depth = 0) {
  if (depth > 4) return null;
  const v = String(value).trim();
  let m = v.match(/^(-?[\d.]+)px$/);
  if (m) return parseFloat(m[1]);
  m = v.match(/^(-?[\d.]+)rem$/);
  if (m) return parseFloat(m[1]) * 16;
  m = v.match(/^var\((--[A-Za-z0-9-]+)\)$/);
  if (m) return vars[m[1]] !== undefined ? resolveLength(vars[m[1]], vars, depth + 1) : null;
  m = v.match(/^calc\(\s*var\((--[A-Za-z0-9-]+)\)\s*\*\s*(-?[\d.]+)\s*\)$/);
  if (m) {
    const base = vars[m[1]] !== undefined ? resolveLength(vars[m[1]], vars, depth + 1) : null;
    return base === null ? null : base * parseFloat(m[2]);
  }
  return null;
}

/** True when two token values are the same value written differently. */
function tokenValuesEqual(canonVal, implVal, canonVars, implVars) {
  if (canonVal === implVal) return true;
  const a = resolveLength(canonVal, canonVars);
  const b = resolveLength(implVal, implVars);
  return a !== null && b !== null && Math.abs(a - b) < 0.001;
}

function checkDesignTokens() {
  const d = cfg.design;
  if (!d?.dir) {
    notes.push('design tokens: not configured, check skipped');
    return;
  }
  const tokensDir = abs(path.join(d.dir, 'tokens'));
  if (!existsSync(tokensDir)) {
    notes.push(`design tokens: no snapshot at ${d.dir}/tokens (pull it first)`);
    return;
  }
  const canon = {};
  for (const f of readdirSync(tokensDir).filter((f) => f.endsWith('.css'))) {
    Object.assign(canon, parseCssVars(path.join(tokensDir, f)) ?? {});
  }
  const canonNames = Object.keys(canon);
  notes.push(`design tokens: ${canonNames.length} canonical tokens`);

  for (const client of d.clients ?? []) {
    const file = abs(client.tokensFile);
    if (!existsSync(file)) {
      notes.push(`design tokens: ${client.name} tokens file missing (${client.tokensFile})`);
      continue;
    }
    if (client.format === 'css') {
      const impl = parseCssVars(file) ?? {};
      const missing = canonNames.filter((k) => !(k in impl));
      const drift = canonNames.filter((k) => k in impl && !tokenValuesEqual(canon[k], impl[k], canon, impl));
      notes.push(`design tokens: ${client.name} ${canonNames.length - missing.length}/${canonNames.length} defined, ${drift.length} value drift`);
      if (missing.length || drift.length) {
        failures.push({
          check: `design-conformance:${client.name}`,
          message:
            `${client.name} diverges from the canonical design system. The design project is ` +
            `upstream — correct the client, or change the token upstream and re-pull.`,
          items: [
            ...missing.map((k) => `missing: ${k}`),
            ...drift.map((k) => `drift:   ${k} canon=${canon[k]} impl=${impl[k]}`),
          ].slice(0, 25),
        });
      }
    } else {
      // Non-CSS client (e.g. Dart): names only — values are converted, so
      // comparing them would report false drift on every colour.
      const body = readFileSync(file, 'utf8');
      const missing = canonNames.filter((k) => {
        const camel = k.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return !body.includes(camel) && !body.includes(k.replace(/^--/, ''));
      });
      notes.push(`design tokens: ${client.name} ${canonNames.length - missing.length}/${canonNames.length} referenced (names only — values are converted)`);
      if (missing.length) {
        failures.push({
          check: `design-conformance:${client.name}`,
          message:
            `${client.name} has no counterpart for ${missing.length} canonical token(s). Values are ` +
            `not compared for this client (converted notation), so this is a coverage check only.`,
          items: missing.slice(0, 25),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// D. Visual-comparison ratchet
// ---------------------------------------------------------------------------
// The reviewer is a vision model: its raw output varies between runs and cannot
// itself gate a build, because a flaky blocker gets disabled — which is worse
// than no gate. Fail only on a (capture, category) pair absent from the reviewed
// baseline. Accepting one is a decision, never a way to quiet the gate.
function checkVisual() {
  const out = abs(cfg.out ?? 'parity-out');
  const findingsPath = path.join(out, 'findings.json');
  const baselinePath = abs(cfg.acceptedFindings ?? 'scripts/parity/accepted-findings.json');
  if (!existsSync(findingsPath)) {
    notes.push('visual review: findings.json absent — run the reviewer (not blocking)');
    return;
  }
  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  const accepted = (existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}).accepted ?? {};

  // Accepted debt must stay VISIBLE. The ratchet only fails on novel findings, so an
  // accepted gap is silent forever after — the gate goes green and "accepted" quietly
  // reads as "resolved". That is how a parity board can run for weeks, stay green, and
  // leave the mirror exactly as far behind as it started.
  //
  // This is a report line, not a failure: accepting is legitimate. Being unable to see
  // what you accepted is not.
  const acceptedPairs = Object.values(accepted).reduce(
    (n, cats) => n + (Array.isArray(cats) ? cats.length : 0),
    0
  );
  if (acceptedPairs > 0) {
    notes.push(
      `visual review: ${acceptedPairs} accepted finding(s) across ${Object.keys(accepted).length} capture(s) ` +
        `— accepted debt, not resolved. Each should have an owner and a tracker entry.`
    );
  }

  // Duplicate captures manufacture findings. If two manifest entries render the
  // same screen on one side — no seeded session, a redirect, a shared empty state
  // — then every difference on the OTHER side reads as a real gap. Observed
  // 2026-08-03: four practice web captures were byte-identical and produced 22 of
  // 51 findings. Cheap to detect, and impossible to notice by eye on a board.
  for (const dir of ['web', 'mirror', 'mobile']) {
    const d = path.join(out, dir);
    if (!existsSync(d)) continue;
    const byHash = new Map();
    for (const f of readdirSync(d).filter((f) => f.endsWith('.png'))) {
      const h = createHash('md5').update(readFileSync(path.join(d, f))).digest('hex');
      byHash.set(h, [...(byHash.get(h) ?? []), f.replace(/\.png$/, '')]);
    }
    const dupes = [...byHash.values()].filter((g) => g.length > 1);
    if (dupes.length) {
      failures.push({
        check: `duplicate-captures:${dir}`,
        message:
          `Distinct manifest entries produced byte-identical ${dir} captures, so those screens ` +
          `were never really captured. Every finding on the paired side is suspect. Seed the ` +
          `state these routes need, or waive them — do not accept their findings into the baseline.`,
        items: dupes.map((g) => `identical: ${g.join(', ')}`),
      });
    }
  }

  // Freshness. A ratchet over a stale review is worse than no ratchet: it reports
  // "0 not in baseline" and reads exactly like a pass. Observed 2026-08-03 in the
  // tutored workspace — findings were 2 days old, one capture column had been
  // re-run and the other had not, and the gate went green on the day tokens,
  // theme, chat components and i18n all changed.
  const columnMtime = (dir) => {
    const d = path.join(out, dir);
    if (!existsSync(d)) return 0;
    return readdirSync(d)
      .filter((f) => f.endsWith('.png'))
      .reduce((max, f) => Math.max(max, statSync(path.join(d, f)).mtimeMs), 0);
  };
  const webAt = columnMtime('web');
  const mobileAt = columnMtime('mobile');
  const newestCapture = Math.max(webAt, mobileAt);
  const findingsAt = statSync(findingsPath).mtimeMs;
  const mins = (ms) => Math.round(ms / 60000);

  if (newestCapture && findingsAt < newestCapture) {
    failures.push({
      check: 'visual-review-stale',
      message:
        `findings.json is ${mins(newestCapture - findingsAt)} min older than the newest capture. ` +
        `The ratchet below compared a review of images that no longer exist, so its result means ` +
        `nothing. Re-run the reviewer, then the gate.`,
      items: [`findings ${new Date(findingsAt).toISOString()} < capture ${new Date(newestCapture).toISOString()}`]
    });
  }
  // Both columns must come from one pipeline run, or every pair is comparing a
  // screen against a different build of its counterpart.
  const SKEW_LIMIT_MS = 60 * 60 * 1000;
  if (webAt && mobileAt && Math.abs(webAt - mobileAt) > SKEW_LIMIT_MS) {
    failures.push({
      check: 'capture-columns-skewed',
      message:
        `web and mobile captures are ${mins(Math.abs(webAt - mobileAt))} min apart — they are not from ` +
        `the same run, so each pair compares two different builds. Re-run the full pipeline ` +
        `(run.sh without --mobile-only).`,
      items: [`web ${new Date(webAt).toISOString()}`, `mobile ${new Date(mobileAt).toISOString()}`]
    });
  }

  const novel = [];
  let total = 0;
  for (const r of findings.results ?? []) {
    const known = new Set(accepted[r.id] ?? []);
    for (const f of r.findings ?? []) {
      total++;
      if (!known.has(f.category)) novel.push(`${r.id} [${f.severity} ${f.category}] ${f.summary}`);
    }
  }
  notes.push(
    `visual review: ${total} finding(s) from ${findings.backend ?? findings.model ?? 'model'} (${findings.generatedAt ?? '?'}), ${novel.length} not in baseline`
  );
  if (novel.length) {
    failures.push({
      check: 'visual-parity-ratchet',
      message:
        `${novel.length} visual finding(s) are new relative to the accepted baseline. Check each against ` +
        `your artifact table before acting — then fix the gap, or accept it with a reason.`,
      items: novel,
    });
  }
}

// ---------------------------------------------------------------------------
checkCoverage();
checkDesignTokens();
checkI18n();
checkUnlabelled();
checkVisual();

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, config: configPath, notes, failures }, null, 2));
} else {
  console.log(`[parity-gate] UI parity quality gate (${path.relative(process.cwd(), configPath)})`);
  for (const n of notes) console.log('  · ' + n);
  if (!failures.length) console.log('[parity-gate] PASS');
  else {
    console.log('');
    for (const f of failures) {
      console.log(`  ✗ ${f.check}: ${f.message}`);
      for (const it of f.items ?? []) console.log(`      ${it}`);
      console.log('');
    }
    console.log('[parity-gate] FAIL');
  }
}
process.exit(failures.length ? 1 : 0);
