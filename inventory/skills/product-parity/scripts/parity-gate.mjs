#!/usr/bin/env node
// Product parity quality gate — portable. Ships with the `product-parity` skill.
//
// Config-driven so it works in any repo. Point it at a parity.config.json:
//   node <skill>/scripts/parity-gate.mjs --config parity.config.json
// It searches for ./parity.config.json then ./scripts/parity/parity.config.json.
//
// Checks (skipped gracefully when not configured — except M and N, which FAIL unconfigured
// unless `freshness.optOut` / `assets.optOut` gives a reason):
//   A  coverage ratchet — every source-client route needs a capture or a waiver with reason,
//                         date, owner, removeWhen (and an open item behind any tracker)
//   B  regeneration     — every mirror i18n key must exist in the generated artifact
//   C  copy drift       — shared i18n keys must match the source client; every value must
//                         parse, every mirror locale must carry every base-locale key, and
//                         every source key needs a mirror key (or an i18n.sourceOnly reason)
//   D  design tokens    — clients conform to the canonical design system (both, symmetric)
//   E  a11y ratchet     — interactive controls with no accessible name (may only shrink)
//   F  visual ratchet   — LLM findings not present in the accepted baseline; acceptances are
//                         pinned to the source capture's sha256 and lapse when it changes
//   G  capture validity — duplicate captures, stale review, skewed columns.
//                         G exists because F is only as honest as its inputs: a
//                         stale review, or two manifest entries that rendered the
//                         same screen, both make F report a confident PASS.
//   H  geometry         — shared-chrome alignment invariants measured on captured
//                         PNGs, compared across clients. Catches implicit framework
//                         defaults (e.g. Flutter IconButton 48×48 tap target) that
//                         no token check and no vision reviewer can see.
//   I  interactive       — declared affordances resolve to real, activatable controls in
//                         the captured accessibility tree. The only check that sees
//                         BEHAVIOUR: a dead icon and a live button are pixel-identical,
//                         and an affordance broken on both clients passes parity by
//                         definition. Reads the mirror's dump only.
//   J  api parity       — both clients requested the DECLARED endpoints for the screen.
//                         A screen can be pixel-perfect and built from different data.
//   K  control names     — the SET of activatable control names agrees across clients,
//                         within a declared region of shared chrome. The only check that
//                         sees an icon-only affordance swap, which the vision reviewer
//                         reports only intermittently because iconography is out of its
//                         declared scope. Regions are mandatory: unscoped, the diff is
//                         dominated by content the two clients legitimately differ on.
//   L  run attribution  — every artifact was written by the run that claims it (.run.json).
//                         The only check that sees a CONCURRENT writer.
//   M  freshness        — the captures are newer than the last source commit to the UI they
//                         show. G and L compare artifacts with each other; M compares them
//                         with the product, so a board nobody re-ran cannot stay green.
//   N  asset parity     — every image in a declared source asset folder has a mirror
//                         counterpart. The only check that sees images: a logo and the same
//                         word as text satisfy every text check.
//   O  inventory        — every API call (or streamed tool handler, or any declared set)
//                         in the source client's CODE has a mirror counterpart. The only check
//                         that needs no capture: it sees features nobody thought to capture.
//                         FAILS unconfigured unless `inventory.optOut` gives a reason.
//   P  required states  — each declared interaction state (an empty search, a panel a tool
//                         result opens) has a capture. A populated-only route hides them.
//
// Columns: `source.column` / `source.name` and `mirror.column` / `mirror.name` in the config
// (see parity-columns.mjs). Defaults: web / webapp and mobile / Flutter mobile app.
//
// Exit: 0 pass · 1 fail · 2 misconfigured
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runGeometry } from './parity-geometry.mjs';
import { runInteractive } from './parity-interactive.mjs';
import { runNames } from './parity-names.mjs';
import { runSession } from './parity-session.mjs';
import { runApi } from './parity-api.mjs';
import { runFreshness } from './parity-freshness.mjs';
import { runAssets } from './parity-assets.mjs';
import { runInventory } from './parity-inventory.mjs';
import { columns } from './parity-columns.mjs';
import { readTable, readLocaleMap } from './parity-strings.mjs';

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
const COLS = columns(cfg);

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

// One gap per waiver, and a waiver is only as alive as its tracker. Observed 2026-11-07: a
// shell waiver's prose also covered a Settings restructure; its tracker's mobile item was on
// hold for an unrelated reason, so the Settings gap went on hold with it, invisibly.
// Returns Map<route, problem> for waivers that must not count; text naming another route or
// capture is only a warning note, because prose matching is fuzzy.
const WAIVER_FIELDS = ['reason', 'date', 'owner', 'removeWhen'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const text = (x) => (typeof x === 'string' ? x.trim() : '');

// `path#Heading`, split at the FIRST `#` so a heading may contain `#` ("Issue #12").
// Headings and checkboxes inside fenced code blocks are ignored: todo files carry fenced
// shell snippets whose `# comment` lines would otherwise end the section early.
function trackerProblem(tracker) {
  const at = String(tracker).indexOf('#');
  const file = at < 0 ? String(tracker) : String(tracker).slice(0, at);
  const heading = at < 0 ? '' : String(tracker).slice(at + 1).trim();
  const p = abs(file);
  if (!heading || !existsSync(p) || !statSync(p).isFile()) return `tracker ${tracker} does not resolve (use "path#Heading")`;
  let fenced = false;
  const lines = readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : l;
    });
  const level = (l) => (/^#{1,6}\s/.test(l) ? l.match(/^#+/)[0].length : 0);
  const title = (l) => l.replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '').trim();
  const start = lines.findIndex((l) => level(l) && title(l) === heading);
  if (start < 0) return `tracker ${tracker}: ${file} has no heading "${heading}" (matched literally)`;
  const end = lines.findIndex((l, n) => n > start && level(l) && level(l) <= level(lines[start]));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  return section.some((l) => /^\s*([-*+]|\d+\.) \[ \]/.test(l)) ? null : `tracker ${tracker} has no unchecked "- [ ]" item`;
}

// Only waivers that are in force — routes still uncaptured — are graded. Warnings name
// another route only by its full path ("/settings"), or a capture by its id: matching bare
// words like "login" or "new" in prose would fire on every honest waiver.
function waiverProblems(byRoute, routes, captureIds) {
  const problems = new Map();
  for (const [route, w] of Object.entries(byRoute)) {
    const missing = WAIVER_FIELDS.filter((k) => !text(w?.[k]));
    if (missing.length) {
      problems.set(route, `${route}: missing ${missing.join(', ')}`);
      continue;
    }
    const t = w.tracker ? trackerProblem(w.tracker) : null;
    if (t) {
      problems.set(route, `${route}: ${t}`);
      continue;
    }
    const prose = `${w.reason} ${w.removeWhen}`;
    const related = (o) => o === route || route.startsWith(o.replace(/\/?$/, '/')) || o.startsWith(route.replace(/\/?$/, '/'));
    const named = [
      ...routes.filter((o) => o !== '/' && !related(o) && new RegExp(`(^|[^\\w/-])${escapeRe(o)}([^\\w/-]|$)`).test(prose)),
      ...captureIds.filter((id) => id && new RegExp(`(^|[^\\w-])${escapeRe(id)}([^\\w-]|$)`).test(prose)),
    ];
    if (named.length) {
      notes.push(
        `waiver warning: ${route} — its text names ${named.join(', ')}. One gap per waiver: give that ` +
          `gap its own waiver or capture, so it does not inherit this waiver's tracker and removal.`,
      );
    }
  }
  return problems;
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
  const waivers = (existsSync(waiversPath) ? JSON.parse(readFileSync(waiversPath, 'utf8')) : null) ?? { routes: {} };

  const routes = discoverRoutes(cfg.source);
  if (!routes.length) {
    notes.push('coverage: no routes discovered — check source.routes config');
  }
  const captured = manifest.captures.map((c) => c.source?.route ?? c[COLS.source.id]?.route).filter(Boolean);

  const uncovered = routes.filter((t) => !captured.some(templateMatcher(t)));
  const routeWaivers = waivers?.routes && typeof waivers.routes === 'object' ? waivers.routes : {};
  const stale = Object.keys(routeWaivers).filter((r) => !uncovered.includes(r));
  if (stale.length) {
    notes.push(`coverage: ${stale.length} waiver(s) for routes that are captured or gone — remove them: ${stale.join(', ')}`);
  }
  const inForce = Object.fromEntries(Object.entries(routeWaivers).filter(([r]) => uncovered.includes(r)));
  const badWaivers = waiverProblems(inForce, routes, manifest.captures.map((c) => c.id));
  if (badWaivers.size) {
    failures.push({
      check: 'coverage-waivers',
      message:
        `${badWaivers.size} route waiver(s) are not decisions yet, so they waive nothing. A waiver needs ` +
        `a reason, date, owner and removeWhen; a tracker, when given, must point at a heading that ` +
        `still has an unchecked "- [ ]" item — a waiver whose tracker is closed hides the gap with it.`,
      items: [...badWaivers.values()],
    });
  }

  const unwaived = [];
  let waived = 0;
  for (const r of uncovered) {
    if (inForce[r] && !badWaivers.has(r)) waived++;
    else unwaived.push(r);
  }
  notes.push(`coverage: ${routes.length - uncovered.length}/${routes.length} routes captured, ${waived} waived`);

  if (unwaived.length) {
    failures.push({
      check: 'coverage-ratchet',
      message:
        `${unwaived.length} source route(s) have no parity capture and no waiver. An uncaptured screen ` +
        `reads as silence, and silence is indistinguishable from success — add a manifest entry, or a ` +
        `waiver (reason, date, owner, removeWhen) in ${path.relative(ROOT, waiversPath)}.`,
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
// B + C. i18n, and locale coverage
// ---------------------------------------------------------------------------
// Values are read by a literal parser (parity-strings.mjs), not a line regex: wrapped,
// double-quoted and concatenated values are compared like any other. A value that is still
// not a plain string FAILS by key — an exclusion count printed as a note reads as green.
//
// Locale coverage is independent of the source client. A key the mirror has in its base
// locale but not in another locale falls back to the base language for those users, whether
// or not the source has the key — and a shared-key comparison can never see it. Observed on
// one project (2026-11-06): 70 such keys, found only after users of three locales had been
// reading English for weeks.
//
// Point the mirror side at what the app actually SHIPS. Where a generated map is the runtime
// table and the ARB files are partial, use `mirrorFormat: "dart-map"` on the generated file.
function readMirrorLocales(i, mf, baseLocale) {
  const format = i.mirrorFormat ?? 'arb';
  if (format === 'dart-map') {
    const { locales } = readLocaleMap(mf, i.mirrorVariable);
    return Object.fromEntries(Object.entries(locales).map(([l, t]) => [l, { ...t, label: `${i.mirrorFile}[${l}]` }]));
  }
  const locales = { [baseLocale]: { ...readTable(mf, format), label: i.mirrorFile } };
  if (!i.mirrorLocaleFiles) return locales;
  // `l10n/app_{locale}.arb` → every file in l10n/ matching app_<locale>.arb
  const dir = abs(path.dirname(i.mirrorLocaleFiles));
  const [before, after] = path.basename(i.mirrorLocaleFiles).split('{locale}');
  if (after === undefined) throw new Error('i18n.mirrorLocaleFiles must contain {locale}');
  for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (!f.startsWith(before) || !f.endsWith(after)) continue;
    const locale = f.slice(before.length, f.length - after.length);
    if (!locale || locale === baseLocale) continue;
    const file = path.join(dir, f);
    locales[locale] = { ...readTable(file, format), label: path.relative(ROOT, file) };
  }
  return locales;
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
  const baseLocale = i.baseLocale ?? 'en';
  const src = readTable(sf, i.sourceFormat ?? 'ts-object');
  const locales = readMirrorLocales(i, mf, baseLocale);
  const mir = locales[baseLocale];
  if (!mir) {
    failures.push({
      check: 'i18n-config',
      message: `The mirror table has no "${baseLocale}" locale. Set i18n.baseLocale to the mirror's base locale.`,
      items: Object.keys(locales),
    });
    return;
  }

  const unparsed = [
    ...src.unparsed.map((k) => `${i.sourceFile}: ${k}`),
    ...Object.values(locales).flatMap((t) => t.unparsed.map((k) => `${t.label}: ${k}`)),
  ];
  if (unparsed.length) {
    failures.push({
      check: 'i18n-unparsed',
      message:
        `${unparsed.length} string-table value(s) are not plain string literals (interpolated templates, ` +
        `calls, identifiers), so no i18n check can compare them. Make each a literal, or move it out of ` +
        `the string table.`,
      items: unparsed.slice(0, 20),
    });
  }

  // B — only where an editable source (ARB/JSON) feeds a generated artifact. A dart-map
  // mirror IS the generated artifact.
  if (i.generatedFile && (i.mirrorFormat ?? 'arb') !== 'dart-map') {
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

  // C
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

  // A source key the mirror lacks is the cheapest evidence of a source UI the mirror never
  // built. Comparing shared keys alone cannot see it. Observed 2026-11-07: a web Settings
  // restructure added 8 keys; the gate printed "637 shared keys compared" and stayed green
  // for 2 days. A listed key needs a reason, or the list is a silence switch.
  const so = i.sourceOnly ?? {};
  if (typeof so !== 'object' || Array.isArray(so)) {
    failures.push({ check: 'i18n-config', message: 'i18n.sourceOnly must be an object: { "<key or prefix*>": "<reason>" }.' });
  }
  const listed = Object.entries(typeof so === 'object' && !Array.isArray(so) ? so : {}).filter(
    ([p, reason]) => p !== '*' && text(reason),
  );
  const isListed = (k) => listed.some(([p]) => (p.endsWith('*') ? k.startsWith(p.slice(0, -1)) : k === p));
  const sourceOnly = Object.keys(src.values).filter((k) => !(k in mir.values) && !mir.unparsed.includes(k));
  const unlisted = sourceOnly.filter((k) => !isListed(k)).sort();
  if (sourceOnly.length > unlisted.length) {
    notes.push(`i18n: ${sourceOnly.length - unlisted.length} source-only key(s) listed in i18n.sourceOnly`);
  }
  if (unlisted.length) {
    failures.push({
      check: 'i18n-source-only',
      message:
        `${unlisted.length} source i18n key(s) have no mirror counterpart — usually a source UI the mirror ` +
        `does not show yet. Port the string with the UI, or list the key (or a "prefix*") in ` +
        `i18n.sourceOnly with a reason.`,
      items: unlisted.slice(0, 40),
    });
  }

  // Locale coverage — ratcheted like the a11y check: recorded debt may only shrink.
  const others = Object.keys(locales).filter((l) => l !== baseLocale).sort();
  if (!others.length) {
    notes.push(
      'i18n: locale coverage NOT checked — only the base locale was read. Set i18n.mirrorLocaleFiles, ' +
        'or point the mirror at the shipped multi-locale map (mirrorFormat "dart-map").',
    );
    return;
  }
  const baselinePath = i.coverageBaseline ? abs(i.coverageBaseline) : null;
  const baseline = baselinePath && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).missing ?? {} : {};
  const worse = [];
  for (const l of others) {
    const table = locales[l].values;
    const missing = Object.keys(mir.values).filter((k) => !(k in table) || table[k] === '');
    const allowed = baseline[l] ?? 0;
    if (missing.length > allowed) {
      const shown = missing.slice(0, 15).join(', ') + (missing.length > 15 ? `, … ${missing.length - 15} more` : '');
      worse.push(`${l}: ${missing.length} missing — ${shown}`);
    } else if (allowed) {
      notes.push(
        `i18n: ${l} ${missing.length} missing (baseline ${allowed})` +
          (missing.length < allowed ? ' — lower the baseline to lock in the improvement' : ''),
      );
    }
  }
  notes.push(`i18n: locale coverage checked for ${others.join(', ')} against ${baseLocale}`);
  if (worse.length) {
    failures.push({
      check: 'i18n-locale-coverage',
      message:
        `Keys present in the mirror's ${baseLocale} table are missing from other locales, so those users ` +
        `silently see ${baseLocale}. Translate them, or record existing debt in i18n.coverageBaseline ` +
        `({ "missing": { "<locale>": <count> } }), which may only shrink.`,
      items: worse,
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
  const out = abs(process.env.PARITY_OUT ?? cfg.out ?? 'parity-out');
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
  // The mirror's dumps only. A source dump (`<capture>.<source column>.json`, written for
  // checks I and K) names nodes `name`, not `label`, so counting it here would report every
  // source control as unlabelled.
  const sourceSuffix = `.${COLS.source.id}.json`;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith(sourceSuffix))) {
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
// D. Design-token conformance (tier 0 — deterministic, no model)
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
// F. Visual-comparison ratchet
// ---------------------------------------------------------------------------
// The reviewer is a vision model: its raw output varies between runs and cannot
// itself gate a build, because a flaky blocker gets disabled — which is worse
// than no gate. Fail only on a (capture, category) pair absent from the reviewed
// baseline. Accepting one is a decision, never a way to quiet the gate.
function checkVisual() {
  const out = abs(process.env.PARITY_OUT ?? cfg.out ?? 'parity-out');
  const findingsPath = path.join(out, 'findings.json');
  const baselinePath = abs(cfg.acceptedFindings ?? 'scripts/parity/accepted-findings.json');
  if (!existsSync(findingsPath)) {
    notes.push('visual review: findings.json absent — run the reviewer (not blocking)');
    return;
  }
  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  const accepted = ((existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null) ?? {}).accepted ?? {};

  // Accepted debt must stay VISIBLE. The ratchet only fails on novel findings, so an
  // accepted gap is silent forever after — the gate goes green and "accepted" quietly
  // reads as "resolved". That is how a parity board can run for weeks, stay green, and
  // leave the mirror exactly as far behind as it started.
  //
  // This is a report line, not a failure: accepting is legitimate. Being unable to see
  // what you accepted is not.
  // An acceptance is pinned to the SOURCE capture it was reviewed against. Keyed on
  // (capture, category) alone, it accepted every future finding of that category on that
  // screen: observed 2026-11-07, a copy-mismatch accepted in August silently covered a full
  // Settings restructure in November. Pinning to the source PNG's sha256 makes it lapse the
  // moment the source screen changes; the finding text is not hashed, because the vision
  // model words the same finding differently on every run.
  const sourceSha = (id) => {
    const p = path.join(out, COLS.source.id, `${id}.png`);
    return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null;
  };
  const unpinned = [];
  const lapsed = [];
  const honoured = {};
  for (const [id, entry] of Object.entries(accepted)) {
    const now = sourceSha(id);
    if (Array.isArray(entry)) {
      unpinned.push(`${id}: sourceSha256 ${now ?? '(no source capture)'}`);
      honoured[id] = entry;
    } else if (entry?.sourceSha256 && entry.sourceSha256 === now) {
      honoured[id] = Array.isArray(entry.categories) ? entry.categories : [];
    } else {
      lapsed.push(`${id}: source capture is now ${now ?? 'missing'}`);
    }
  }
  if (unpinned.length) {
    failures.push({
      check: 'accepted-findings-unpinned',
      message:
        `${unpinned.length} accepted-findings entr(ies) are not pinned to a source capture, so they ` +
        `accept every future finding of their category on that screen. Re-review each capture, then ` +
        `write it as { "categories": [...], "sourceSha256": "<hash below>" } in ${path.relative(ROOT, baselinePath)}.`,
      items: unpinned,
    });
  }
  if (lapsed.length) {
    failures.push({
      check: 'accepted-findings-lapsed',
      message:
        `${lapsed.length} acceptance(s) lapsed: the source capture's bytes changed since they were ` +
        `reviewed, so their findings are back in the ratchet below. Usually the screen changed; if it ` +
        `did not, the capture is not deterministic (clock, animation, fonts, live data) — capture twice ` +
        `and compare hashes before trusting either. Re-review; re-accept with the new sourceSha256 only ` +
        `what is still a deliberate gap.`,
      items: lapsed,
    });
  }

  const acceptedPairs = Object.values(honoured).reduce((n, cats) => n + cats.length, 0);
  if (acceptedPairs > 0) {
    notes.push(
      `visual review: ${acceptedPairs} accepted finding(s) across ${Object.keys(honoured).length} capture(s) ` +
        `— accepted debt, not resolved. Each should have an owner and a tracker entry.`
    );
  }

  // Duplicate captures manufacture findings. If two manifest entries render the
  // same screen on one side — no seeded session, a redirect, a shared empty state
  // — then every difference on the OTHER side reads as a real gap. Observed
  // 2026-08-03: four practice web captures were byte-identical and produced 22 of
  // 51 findings. Cheap to detect, and impossible to notice by eye on a board.
  for (const dir of [COLS.source.id, COLS.mirror.id]) {
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
  // "0 not in baseline" and reads exactly like a pass. Observed 2026-08-03 on one
  // project — findings were 2 days old, one capture column had been
  // re-run and the other had not, and the gate went green on the day tokens,
  // theme, chat components and i18n all changed.
  const columnMtime = (dir) => {
    const d = path.join(out, dir);
    if (!existsSync(d)) return 0;
    return readdirSync(d)
      .filter((f) => f.endsWith('.png'))
      .reduce((max, f) => Math.max(max, statSync(path.join(d, f)).mtimeMs), 0);
  };
  const sourceAt = columnMtime(COLS.source.id);
  const mirrorAt = columnMtime(COLS.mirror.id);
  const newestCapture = Math.max(sourceAt, mirrorAt);
  const findingsAt = statSync(findingsPath).mtimeMs;
  const mins = (ms) => Math.round(ms / 60000);

  // PER-CAPTURE freshness. The whole-file mtime is not usable once the reviewer merges
  // subset runs (it must, or one-screen work destroys the other results) — every entry
  // would look as fresh as the last write, which silently disables this guard. So each
  // result is graded against ITS OWN capture PNGs.
  //
  // Falls back to the whole-file comparison for findings.json written before results
  // carried `reviewedAt`; an old file must not silently skip the check.
  const allResults = findings.results ?? [];
  const stamped = allResults.filter((r) => r.reviewedAt);
  if (stamped.length) {
    const stale = [];
    // A result with no `reviewedAt` came from a reviewer that did not record when it ran.
    // Once the file is merged its mtime is meaningless for these, so freshness CANNOT be
    // established — and an unverifiable entry must never pass silently. Treat it as stale:
    // one re-review stamps it and the check becomes exact from then on.
    for (const r of allResults) {
      if (!r.reviewedAt) stale.push(`${r.id}: no reviewedAt — freshness unverifiable, re-review it`);
    }
    for (const r of stamped) {
      const at = Date.parse(r.reviewedAt);
      if (Number.isNaN(at)) continue;
      const pngAt = (col) => {
        const p = path.join(out, col, `${r.id}.png`);
        return existsSync(p) ? statSync(p).mtimeMs : 0;
      };
      const capAt = Math.max(pngAt(COLS.source.id), pngAt(COLS.mirror.id));
      if (capAt && at < capAt) stale.push(`${r.id}: reviewed ${mins(capAt - at)} min before its newest capture`);
    }
    if (stale.length) {
      failures.push({
        check: 'visual-review-stale',
        message:
          `${stale.length} of ${allResults.length} reviewed capture(s) cannot be trusted: their findings ` +
          `describe screenshots that have since been replaced, or were recorded without a review ` +
          `timestamp so freshness cannot be established. Re-review just those captures ` +
          `(--only <id>, or a subset PARITY_MANIFEST — the reviewer merges, so the rest are kept).`,
        items: stale,
      });
    }
  } else if (newestCapture && findingsAt < newestCapture) {
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
  if (sourceAt && mirrorAt && Math.abs(sourceAt - mirrorAt) > SKEW_LIMIT_MS) {
    failures.push({
      check: 'capture-columns-skewed',
      message:
        `${COLS.source.label} and ${COLS.mirror.label} captures are ${mins(Math.abs(sourceAt - mirrorAt))} min ` +
        `apart — they are not from the same run, so each pair compares two different builds. Re-run ` +
        `the full pipeline so both columns come from one run.`,
      items: [
        `${COLS.source.id} ${new Date(sourceAt).toISOString()}`,
        `${COLS.mirror.id} ${new Date(mirrorAt).toISOString()}`,
      ]
    });
  }

  const novel = [];
  let total = 0;
  for (const r of findings.results ?? []) {
    const known = new Set(honoured[r.id] ?? []);
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
// H. Geometry / alignment invariants (deterministic — no model)
// ---------------------------------------------------------------------------
// Shared-chrome regions that must share a vertical centre are measured on both
// clients' capture PNGs; the *spread* between those centres is compared across
// clients. This catches the class of defect token conformance and the vision
// reviewer both miss: an implicit framework default with no counterpart in the
// source client (observed 2026-08-10 — Flutter IconButton's 48×48 padded tap
// target pushed the composer placeholder ~6.7pt low on every screen for weeks).
//
// No-op when `cfg.geometry` is absent or has no invariants — other repos vendor
// this skill without declaring any. Missing capture PNGs degrade to notes (via
// runGeometry), not failures. Failure shape is reconciled at this boundary:
// geometry uses `{ id, msg }`; the gate uses `{ check, message }`.
// ---------------------------------------------------------------------------
// I. Interactive affordances (deterministic — no model)
// ---------------------------------------------------------------------------
// No-op when cfg.interactive is absent. Mirror-only, and every note says so: a check
// that overstates its coverage is worse than no check.
// ---------------------------------------------------------------------------
// J. API parity (deterministic — no model)
// ---------------------------------------------------------------------------
// Two clients can render identical pixels from different data. Nothing else here sees it.
function checkApi() {
  const { notes: aNotes, failures: aFailures } = runApi(cfg, ROOT);
  for (const n of aNotes) notes.push(n);
  for (const f of aFailures) failures.push({ check: f.id, message: f.msg, items: f.items });
}

function checkInteractive() {
  const { notes: iNotes, failures: iFailures } = runInteractive(cfg, ROOT);
  for (const n of iNotes) notes.push(n);
  for (const f of iFailures) failures.push({ check: f.id, message: f.msg });
}

function checkGeometry() {
  const { notes: gNotes, failures: gFailures } = runGeometry(cfg, ROOT);
  for (const n of gNotes) notes.push(n);
  for (const f of gFailures) {
    failures.push({ check: f.id, message: f.msg });
  }
}

function checkSession() {
  const { notes: sNotes, failures: sFailures } = runSession(cfg, ROOT);
  for (const n of sNotes) notes.push(n);
  for (const f of sFailures) failures.push({ check: f.id, message: f.msg, items: f.items });
}

function checkFreshness() {
  const { notes: fNotes, failures: fFailures } = runFreshness(cfg, ROOT);
  for (const n of fNotes) notes.push(n);
  for (const f of fFailures) failures.push({ check: f.id, message: f.msg, items: f.items });
}

function checkInventory() {
  const { notes: iNotes, failures: iFailures } = runInventory(cfg, ROOT);
  for (const n of iNotes) notes.push(n);
  for (const f of iFailures) failures.push({ check: f.id, message: f.msg, items: f.items });
}

// P. A state behind a user action — an empty search with its fallback, a panel a streamed tool
// result opens — appears in no capture unless someone produces it with a `prep` step. Observed
// 2026-11-07: two whole features lived only in such states and the gate passed both. The
// route had captures, so coverage (A) was satisfied; the states had none.
function checkStates() {
  const required = cfg.states?.required;
  if (required === undefined) return;
  if (!Array.isArray(required)) {
    failures.push({ check: 'state-coverage', message: 'states.required must be a list of { route, state, reason }.' });
    return;
  }
  if (!required.length) return;
  const manifestPath = abs(cfg.manifest ?? 'scripts/parity/parity-manifest.json');
  const listed = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).captures : [];
  const captures = Array.isArray(listed) ? listed : [];
  const missing = [];
  const unprepped = [];
  for (const r of required) {
    if (!r?.route || !r?.state || typeof r.reason !== 'string' || !r.reason.trim()) {
      missing.push(`${r?.route ?? '?'} — ${r?.state ?? '?'}: needs route, state and a reason`);
      continue;
    }
    const matches = templateMatcher(r.route);
    const found = captures.filter(
      (c) => c?.state === r.state && matches(String(c.source?.route ?? c[COLS.source.id]?.route ?? '').replace(/(.)\/$/, '$1')),
    );
    if (!found.length) missing.push(`${r.route} — ${r.state}`);
    else if (!found.some((c) => Array.isArray(c.prep) && c.prep.length)) unprepped.push(`${r.route} — ${r.state}`);
  }
  notes.push(`states: ${required.length - missing.length}/${required.length} required interaction state(s) captured`);
  if (unprepped.length) {
    notes.push(
      `states: ${unprepped.join(', ')} — labelled, but no capture has a prep step. Unless fixture data produces ` +
        `the state, the capture shows the default screen under the state's name.`,
    );
  }
  if (missing.length) {
    failures.push({
      check: 'state-coverage',
      message:
        `${missing.length} required interaction state(s) have no capture, so no check has ever seen them. ` +
        `Add a manifest entry with that "state" and a prep step that produces it (DYNAMIC-STATES.md).`,
      items: missing,
    });
  }
}

function checkAssets() {
  const { notes: aNotes, failures: aFailures } = runAssets(cfg, ROOT);
  for (const n of aNotes) notes.push(n);
  for (const f of aFailures) failures.push({ check: f.id, message: f.msg, items: f.items });
}

function checkNames() {
  const { notes: nNotes, failures: nFailures } = runNames(cfg, ROOT);
  for (const n of nNotes) notes.push(n);
  for (const f of nFailures) failures.push({ check: f.id, message: f.msg });
}

// ---------------------------------------------------------------------------
checkSession();
checkCoverage();
checkDesignTokens();
checkI18n();
checkUnlabelled();
checkVisual();
checkGeometry();
checkInteractive();
checkNames();
checkApi();
checkFreshness();
checkAssets();
checkInventory();
checkStates();

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, config: configPath, notes, failures }, null, 2));
} else {
  console.log(`[parity-gate] Product parity quality gate (${path.relative(process.cwd(), configPath)})`);
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
