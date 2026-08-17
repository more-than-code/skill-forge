#!/usr/bin/env node
// Tier 3 — LLM visual comparison of each parity pair.
//
// Sends the webapp capture and the mobile capture for each manifest entry to a
// local coding-agent CLI (vision-capable) and asks for STRUCTURED findings,
// judged against the parity bar and the known-artifact table. Writes
// parity-out/findings.json.
//
// This is the judgement layer. It is deliberately NOT the thing that fails the
// build — model verdicts vary run to run, and a flaky blocker gets disabled,
// which is worse than no gate. Instead `gate.mjs` ratchets over this output:
// a finding fails the build only when it is NEW relative to the reviewed
// baseline in scripts/parity/accepted-findings.json.
//
// Backends: LOCAL coding-agent CLIs ONLY — grok | claude | codex.
// The remote OpenAI chat/completions path was removed: app LLM cost defaults
// (gpt-5.6-luna) are a poor fit for left/right screenshot judgement, and
// parity review must not share production API keys or depend on paid vision
// APIs. Measured 2026-07-31: gpt-4.1-mini inverted left/right and was
// non-deterministic at temperature 0; keep judgement on agent CLIs with file
// tools instead of embedding images into a chat/completions body.
//
// Usage:
//   node scripts/parity/review.mjs [--only <captureId>] [--concurrency N]
//   PARITY_REVIEW_BACKEND=grok|claude|codex  (default: grok)
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Portable: resolve everything from a parity.config.json in the consuming repo, not from
// this file's location — it lives in the vendored skill directory, which is nowhere near
// the repo being reviewed.
function findConfig() {
  const i = process.argv.indexOf('--config');
  const cands = i >= 0 ? [process.argv[i + 1]] : ['parity.config.json', 'scripts/parity/parity.config.json', '.parity/parity.config.json'];
  for (const c of cands) { const p = path.resolve(process.cwd(), c); if (existsSync(p)) return p; }
  return null;
}
const CONFIG_PATH = findConfig();
const CFG = CONFIG_PATH ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
const ROOT = CONFIG_PATH ? path.resolve(path.dirname(CONFIG_PATH), CFG.root ?? '.') : process.cwd();
const OUT = process.env.PARITY_OUT ?? path.resolve(ROOT, CFG.out ?? 'parity-out');
const MANIFEST = process.env.PARITY_MANIFEST ?? path.resolve(ROOT, CFG.manifest ?? 'scripts/parity/parity-manifest.json');

const ALLOWED_BACKENDS = new Set(['grok', 'claude', 'codex']);

// Reuse the app's .env only for non-secret overrides if present; no API keys required.
function loadEnvFile(p) {
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
// Consumer-declared, never a hardcoded repo path: the previous value pointed at
// ttd-backend/.env, which exists in exactly one workspace. No API keys are required —
// this is for non-secret overrides only.
const env = { ...(CFG.review?.envFile ? loadEnvFile(path.resolve(ROOT, CFG.review.envFile)) : {}), ...process.env };

// Backend: local coding-agent CLIs only. Default grok (Grok Build CLI).
// Never pass --continue to grok (sandbox-profile resume collision). Single-turn
// judgement under read-only / restricted tool policy.
const BACKEND = (env.PARITY_REVIEW_BACKEND || 'grok').toLowerCase();
const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
// Agent CLIs are heavier than a single HTTP call — default concurrency 1.
const CONCURRENCY = Number(
  argv.includes('--concurrency')
    ? argv[argv.indexOf('--concurrency') + 1]
    : env.PARITY_REVIEW_CONCURRENCY || 1
);

// Fixed enum keeps findings comparable across runs — free-text summaries drift,
// so the ratchet keys on (captureId, category), not on wording.
const CATEGORIES = [
  'missing-affordance',
  'extra-affordance',
  'missing-count-or-metadata',
  'copy-mismatch',
  'missing-state',
  'ia-difference',
];

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: CATEGORIES },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['category', 'severity', 'summary', 'evidence'],
      },
    },
  },
  required: ['findings'],
};


/**
 * Product-specific suppression rules, supplied by the REPO via `review.artifacts`.
 *
 * OWNERSHIP. The skill owns what stays true when you point the harness at a different
 * product; the repo owns everything else. Applied to suppressions, the line is:
 *   · caused by the CAPTURE TECHNIQUE (test-runner font stacks, undecoded images) → skill,
 *     inlined below, because they follow from the capture method this skill recommends;
 *   · caused by the PRODUCT's own stubs or features → repo, declared in config.
 *
 * This function exists because the second kind was hardcoded here and cost a P1. The rule
 * read "the sticker catalog shows fewer stickers on the RIGHT" — Tutored product knowledge,
 * living in a skill other repos vendor. The model generalised it to any sticker difference
 * and stayed silent while the source client replaced its composer sticker button with a
 * different control. Nothing failed, because a suppression working as designed and a
 * suppression hiding a real gap are indistinguishable from outside.
 *
 * SHAPE IS ENFORCED, not merely documented. A suppression is a waiver — a broader one than
 * a per-finding waiver, since it silences a whole subject on every capture — so it carries
 * the same metadata this skill already demands of waivers, plus the two fields that make it
 * checkable against reality:
 *   captures      which capture ids it applies to (globs). NEVER "all".
 *   element       the specific thing affected, not the subject area.
 *   direction     what you expect to see. A rule without a direction cannot be falsified.
 *   cause         why the harness does this.
 *   counterClause what is STILL a finding. The model fills gaps by generalising; this is
 *                 the only thing that stops it.
 *   owner         who decided this.
 *   addedOn       when.
 *   removeWhen    the condition that retires it. A date tells you to have an opinion on a
 *                 Tuesday; a condition tells you what to verify.
 *   reviewBy      optional backstop for conditions nobody can mechanically check.
 */
function renderArtifacts(cfg) {
  const declared = cfg.review?.artifacts ?? [];
  const REQUIRED = ['captures', 'element', 'direction', 'cause', 'counterClause', 'owner', 'addedOn', 'removeWhen'];
  const notes = [];

  declared.forEach((a, i) => {
    const missing = REQUIRED.filter((k) => !a[k] || String(a[k]).trim() === '');
    if (missing.length) {
      throw new Error(
        `review.artifacts[${i}] (${a.element ?? a.captures ?? 'unnamed'}) is missing: ${missing.join(', ')}.\n` +
          `A suppression rule without these is a silence switch. "direction" and "counterClause" are ` +
          `not optional: a rule phrased as a subject rather than an observation silences that subject ` +
          `everywhere, on every capture, forever — and a false negative is invisible, so nothing will ` +
          `ever tell you.`,
      );
    }
    if (a.reviewBy && Date.parse(a.reviewBy) < Date.now()) {
      notes.push(
        `review: suppression for "${a.element}" passed its reviewBy (${a.reviewBy}, owner ${a.owner}). ` +
          `Re-audit it: confirm "${a.removeWhen}" is still false, or delete the entry.`,
      );
    }
  });

  if (!declared.length) {
    notes.push(
      'review: no product artifacts declared (review.artifacts) — every stubbed subsystem will read ' +
        'as a real finding. Expected on a new harness; add entries once the board shows you which.',
    );
  }

  const lines = declared.map(
    (a) =>
      `- On ${Array.isArray(a.captures) ? a.captures.join(', ') : a.captures} ONLY: ${a.element} — ` +
      `expect ${a.direction}, because ${a.cause}. This covers that and nothing else. ${a.counterClause}`,
  );
  return { lines, notes };
}

const SYSTEM = `You compare two screenshots of the SAME screen from two clients of one product.

LEFT = webapp. This is the SOURCE OF TRUTH.
RIGHT = Flutter mobile app. This MIRRORS the webapp.

Report only ways the mobile app FAILS TO MIRROR the webapp.

IN SCOPE (report these):
- jobs the user can do on one client but not the other
- primary actions / affordances present on one and missing on the other
- counts, badges, or metadata shown on one and missing on the other
- user-visible copy that differs in meaning or wording
- states handled on one and not the other (empty, error, guest vs signed-in)
- in-page information architecture: what is reachable from this screen

OUT OF SCOPE (never report these — they are explicitly allowed to differ):
- layout, spacing, alignment, ordering, type scale, font size, colour
- pixel-level differences of any kind
- platform-native conventions: back arrow vs hamburger, native pickers,
  a System/Light/Dark theme control that only mobile has
- scroll position: the two captures may show different parts of a long screen.
  If content is merely below the fold, that is NOT a finding.
- different underlying DATA (different chat messages, different list items).
  The captures may be taken moments apart against a live database.

KNOWN RENDERING ARTIFACTS OF THE MOBILE CAPTURE HARNESS — NEVER report these as findings.
Each rule is limited to what it names. Do NOT generalise a rule to other screens, other
controls, or the opposite direction:
- CJK (Japanese/Chinese) text renders as filled black boxes on the RIGHT only.
  The test font lacks CJK glyphs. It renders correctly on real devices.
- Avatar and asset images may render as solid discs or initials on the RIGHT,
  inconsistently within one screen. Images are not decoded in the test runner.
  Judge whether the avatar SLOT exists, never the image content.
- Occasional text rendering as a solid black bar on the RIGHT is a font fallback
  artifact, not missing content.
__PRODUCT_ARTIFACTS__

Be conservative. A false finding is more costly than a missed one, because it
erodes trust in this review. If unsure, do not report it.

Return STRICT JSON only:
{"findings":[{"category":"<one of: ${CATEGORIES.join(' | ')}>","severity":"high|medium|low","summary":"<one sentence>","evidence":"<what you see on each side>"}]}
Return {"findings":[]} when the mirror is faithful.`;

function normalise(findings) {
  return (findings ?? [])
    .filter((f) => CATEGORIES.includes(f.category))
    .map((f) => ({
      category: f.category,
      severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
      summary: String(f.summary ?? '').slice(0, 300),
      evidence: String(f.evidence ?? '').slice(0, 500),
    }));
}

// Composed once at startup so a malformed entry fails before any capture is reviewed,
// rather than after the first nine minutes of model time.
const { lines: ARTIFACT_LINES, notes: ARTIFACT_NOTES } = renderArtifacts(CFG);
const SYSTEM_COMPOSED = SYSTEM.replace(
  '__PRODUCT_ARTIFACTS__',
  ARTIFACT_LINES.length
    ? ARTIFACT_LINES.join('\n')
    : '(no product-specific artifacts declared for this repo)',
);

function inventoryPrompt(webPath, mobPath, userText) {
  return [
    SYSTEM_COMPOSED,
    '',
    userText,
    '',
    'Read these two image files with your image-reading / Read tool:',
    `IMAGE 1 OF 2 — THE WEBAPP (source of truth): ${webPath}`,
    `IMAGE 2 OF 2 — THE MOBILE APP (the mirror being checked): ${mobPath}`,
    '',
    'METHOD — follow it in order, do not skip straight to findings:',
    '  1. Open IMAGE 1. Write out an inventory of EVERY user-visible element:',
    '     header controls, each message/row and its decorations (avatars, bubbles,',
    '     badges, dividers, timestamps), every section heading, every count, and',
    '     every control in any input area or footer.',
    '  2. Open IMAGE 2. Write the same inventory independently.',
    '  3. Walk your IMAGE 1 inventory item by item and mark each one present or',
    '     absent in IMAGE 2. Absences are candidate findings.',
    '  4. Discard candidates that are out of scope or known artifacts (see above),',
    '     or that are merely below the fold.',
    '  5. Report what survives.',
    'A low-recall review is a failure: an inventory item you never listed cannot be',
    'compared. Be exhaustive in steps 1-2 and conservative only in step 4.',
    'If it exists in IMAGE 2 but not IMAGE 1, it is mobile-only — NOT a finding',
    'unless it contradicts the webapp.',
    'Do not read any other file. Do not edit files. Do not run shell commands.',
  ].join('\n');
}

/** Pull a findings object from various CLI JSON envelopes. */
function extractFindingsPayload(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return extractFindingsPayload(JSON.parse(raw));
    } catch {
      // try to find a JSON object in prose
      const m = raw.match(/\{[\s\S]*"findings"[\s\S]*\}/);
      if (m) {
        try {
          return extractFindingsPayload(JSON.parse(m[0]));
        } catch {
          return null;
        }
      }
      return null;
    }
  }
  if (typeof raw !== 'object') return null;
  if (Array.isArray(raw.findings)) return raw;
  if (raw.structuredOutput && Array.isArray(raw.structuredOutput.findings)) return raw.structuredOutput;
  if (raw.structured_output && Array.isArray(raw.structured_output.findings)) return raw.structured_output;
  if (raw.result != null) return extractFindingsPayload(raw.result);
  if (raw.message != null) return extractFindingsPayload(raw.message);
  if (raw.content != null) return extractFindingsPayload(raw.content);
  return null;
}

async function reviewViaGrok(webPath, mobPath, userText) {
  const prompt = inventoryPrompt(webPath, mobPath, userText);
  const args = [
    '-p', prompt,
    '--cwd', ROOT,
    '--sandbox', 'read-only',
    '--permission-mode', 'auto',
    '--disable-web-search',
    '--max-turns', '14',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(FINDINGS_SCHEMA),
  ];
  const { stdout } = await execFileAsync('grok', args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  const envelope = JSON.parse(stdout);
  const out = extractFindingsPayload(envelope);
  if (!out) throw new Error('grok returned no findings payload');
  return out;
}

async function reviewViaClaude(webPath, mobPath, userText) {
  const prompt = inventoryPrompt(webPath, mobPath, userText);
  // Read-only: allow Read only so Claude can open the PNGs; no Bash/Edit/Write.
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(FINDINGS_SCHEMA),
    '--permission-mode', 'auto',
    '--allowedTools', 'Read',
  ];
  const { stdout } = await execFileAsync('claude', args, {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  const envelope = JSON.parse(stdout);
  const out = extractFindingsPayload(envelope);
  if (!out) throw new Error('claude returned no findings payload');
  return out;
}

async function reviewViaCodex(webPath, mobPath, userText) {
  const prompt = inventoryPrompt(webPath, mobPath, userText);
  const tmp = mkdtempSync(path.join(tmpdir(), 'parity-review-'));
  const schemaPath = path.join(tmp, 'findings.schema.json');
  const outPath = path.join(tmp, 'last-message.txt');
  writeFileSync(schemaPath, JSON.stringify(FINDINGS_SCHEMA));
  try {
    // -i attaches images; --sandbox read-only; schema constrains final message.
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--output-schema', schemaPath,
      '-o', outPath,
      '-i', webPath,
      '-i', mobPath,
      prompt,
    ];
    await execFileAsync('codex', args, {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    if (!existsSync(outPath)) throw new Error('codex wrote no last-message file');
    const raw = readFileSync(outPath, 'utf8');
    const out = extractFindingsPayload(raw);
    if (!out) throw new Error('codex returned no findings payload');
    return out;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function reviewOne(capture) {
  const web = path.join(OUT, 'web', `${capture.id}.png`);
  const mob = path.join(OUT, 'mobile', `${capture.id}.png`);
  if (!existsSync(web) || !existsSync(mob)) {
    return { id: capture.id, skipped: 'missing capture', findings: [] };
  }

  const cl = capture.checklist ?? {};
  const userText = [
    `Screen: ${capture.id}`,
    `Webapp route: ${capture.web?.route}   Mobile route: ${capture.mobile?.route}`,
    cl.jobs?.length ? `Jobs this screen must support: ${cl.jobs.join('; ')}` : '',
    cl.actions?.length ? `Primary actions: ${cl.actions.join('; ')}` : '',
    cl.states?.length ? `States captured: ${cl.states.join('; ')}` : '',
    cl.openQuestion ? `Open question to answer: ${cl.openQuestion}` : '',
    '',
    'LEFT image = webapp (source of truth). RIGHT image = mobile mirror.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    let parsed;
    if (BACKEND === 'grok') parsed = await reviewViaGrok(web, mob, userText);
    else if (BACKEND === 'claude') parsed = await reviewViaClaude(web, mob, userText);
    else if (BACKEND === 'codex') parsed = await reviewViaCodex(web, mob, userText);
    else throw new Error(`unsupported backend: ${BACKEND}`);
    return { id: capture.id, findings: normalise(parsed.findings) };
  } catch (err) {
    return {
      id: capture.id,
      error: `${BACKEND}: ${String(err.message ?? err).slice(0, 200)}`,
      findings: [],
    };
  }
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
        process.stderr.write(`[parity-review] ${out[idx].id}: ${out[idx].error ?? out[idx].skipped ?? out[idx].findings.length + ' finding(s)'}\n`);
      }
    })
  );
  return out;
}

function modelLabel(backend) {
  if (backend === 'grok') return 'grok-cli';
  if (backend === 'claude') return 'claude-cli';
  if (backend === 'codex') return 'codex-cli';
  return backend;
}

async function main() {
  if (!ALLOWED_BACKENDS.has(BACKEND)) {
    console.error(
      [
        `PARITY_REVIEW_BACKEND=${BACKEND} is not allowed.`,
        `Allowed values (local coding-agent CLIs only): ${[...ALLOWED_BACKENDS].join(', ')}.`,
        'The remote OpenAI chat/completions path was removed — do not set openai or an API model.',
        'App LLM defaults (gpt-5.6-luna) are for product traffic, not parity vision review.',
      ].join('\n')
    );
    process.exit(2);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const captures = manifest.captures.filter((c) => !only || c.id === only);

  const results = await pool(captures, CONCURRENCY, reviewOne);
  mkdirSync(OUT, { recursive: true });

  // Stamp each result with WHEN and WITH WHAT it was reviewed. A merged file legitimately
  // mixes review times and backends, and the gate grades per capture — a single top-level
  // timestamp cannot describe that.
  const reviewedAt = new Date().toISOString();
  for (const r of results) {
    r.reviewedAt = reviewedAt;
    r.backend = BACKEND;
    r.model = modelLabel(BACKEND);
  }

  // MERGE, never replace. This script is normally invoked on a SUBSET — `--only`, or a
  // subset PARITY_MANIFEST — because the skill mandates working one screen at a time.
  // Overwriting meant a one-capture run discarded every other capture's findings, and the
  // gate's ratchet read the loss as progress. Observed 2026-08-17: three sequential
  // `--only` runs left a findings.json containing one capture, silently dropping 29.
  //
  // Reviewed captures REPLACE their previous entry; untouched ones are carried forward
  // verbatim, keeping their own older `reviewedAt` so the gate can still call them stale.
  const findingsPath = path.join(OUT, 'findings.json');
  const byId = new Map();
  if (existsSync(findingsPath)) {
    try {
      const prev = JSON.parse(readFileSync(findingsPath, 'utf8'));
      for (const r of prev.results ?? []) byId.set(r.id, r);
    } catch {
      console.log('[parity-review] existing findings.json unreadable — starting fresh');
    }
  }
  for (const r of results) byId.set(r.id, r);
  const merged = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const payload = {
    generatedAt: reviewedAt,
    // The review as a whole is only as fresh as its OLDEST entry. Stated explicitly so a
    // merged file cannot read as wholly current just because it was written just now.
    oldestReviewedAt: merged.reduce(
      (min, r) => (r.reviewedAt && r.reviewedAt < min ? r.reviewedAt : min),
      reviewedAt,
    ),
    backend: BACKEND,
    model: modelLabel(BACKEND),
    results: merged,
  };
  writeFileSync(findingsPath, JSON.stringify(payload, null, 2));
  const carried = merged.length - results.length;
  if (carried > 0) {
    console.log(`[parity-review] merged: ${results.length} reviewed now, ${carried} carried forward`);
  }

  const total = results.reduce((n, r) => n + r.findings.length, 0);
  const errored = results.filter((r) => r.error);
  console.log(`[parity-review] backend=${BACKEND} ${results.length} pair(s) reviewed, ${total} finding(s) → parity-out/findings.json`);
  // Printed AFTER the count so it is not scrolled away by per-capture output. An absent or
  // expired suppression list is exactly the state that produces silent false negatives, so
  // it must be visible on every run — the only signal a false negative ever gives you is a
  // human noticing a gap the reviewer missed.
  for (const n of ARTIFACT_NOTES) console.log(`[parity-review] ${n}`);
  if (errored.length) {
    console.log(`[parity-review] ${errored.length} pair(s) errored — findings are INCOMPLETE`);
    process.exit(1);
  }
}

main();
