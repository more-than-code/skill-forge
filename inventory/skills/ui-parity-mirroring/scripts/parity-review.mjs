#!/usr/bin/env node
// Tier 3 — LLM visual comparison of each parity pair.
//
// Sends the webapp capture and the mobile capture for each manifest entry to a
// vision model and asks for STRUCTURED findings, judged against the parity bar
// and the known-artifact table. Writes parity-out/findings.json.
//
// This is the judgement layer. It is deliberately NOT the thing that fails the
// build — model verdicts vary run to run, and a flaky blocker gets disabled,
// which is worse than no gate. Instead `gate.mjs` ratchets over this output:
// a finding fails the build only when it is NEW relative to the reviewed
// baseline in scripts/parity/accepted-findings.json.
//
// Provider: the repo's existing OpenAI-compatible config (LLM_API_KEY /
// LLM_BASE_URL / LLM_MODEL_MAIN), so this introduces no new vendor.
//
// Usage:
//   node scripts/parity/review.mjs [--only <captureId>] [--concurrency N]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Portable: resolve everything from a parity.config.json in the consuming repo,
// not from this file's location (it lives in the vendored skill directory).
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

// Reuse the app's own LLM config rather than adding a provider.
function loadEnvFile(p) {
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...(CFG.review?.envFile ? loadEnvFile(path.resolve(ROOT, CFG.review.envFile)) : {}), ...process.env };
const API_KEY = env.PARITY_REVIEW_API_KEY || env.LLM_API_KEY;
const BASE_URL = (env.PARITY_REVIEW_BASE_URL || env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
// Model tier matters more than prompt wording here. Measured 2026-07-31 on the
// settings pair: gpt-4.1-mini inverted left/right, reported the mobile-only theme
// control as "missing from mobile", and returned DIFFERENT findings on two
// identical temperature-0 runs. gpt-4.1 returned no findings on that same
// (at-parity) pair twice, and on a known-gapped pre-fix capture correctly found
// missing avatars, placeholder copy drift, composer differences and missing date
// dividers. Do not drop this tier to save cost — a noisy reviewer is worse than none.
const MODEL = env.PARITY_REVIEW_MODEL || CFG.review?.model || 'gpt-4.1';

// Backend: 'grok' (local Grok Build CLI) or 'openai' (stateless chat/completions).
//
// Grok is the default here because this machine has a SuperGrok subscription, so
// per-pair cost is not a factor, and its vision reading of these captures is
// stronger. The agentic-CLI risks that make Grok a poor fit for build gates do
// NOT apply to this call shape: we never pass --continue (so the sandbox-profile
// resume collision cannot occur), single-turn is exactly what a judgement needs,
// and --sandbox read-only + --disable-web-search keep it from wandering.
const BACKEND = (env.PARITY_REVIEW_BACKEND || CFG.review?.backend || 'grok').toLowerCase();
const execFileAsync = promisify(execFile);


const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const CONCURRENCY = Number(argv.includes('--concurrency') ? argv[argv.indexOf('--concurrency') + 1] : 3);

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

KNOWN RENDERING ARTIFACTS OF THE MOBILE CAPTURE HARNESS — NEVER report these as findings:
- CJK (Japanese/Chinese) text renders as filled black boxes on the RIGHT only.
  The test font lacks CJK glyphs. It renders correctly on real devices.
- Avatar and asset images may render as solid discs or initials on the RIGHT,
  inconsistently within one screen. Images are not decoded in the test runner.
  Judge whether the avatar SLOT exists, never the image content.
- The sticker catalog shows fewer stickers on the RIGHT because sticker sync is
  stubbed offline in the harness.
- Occasional text rendering as a solid black bar on the RIGHT is a font fallback
  artifact, not missing content.

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

function dataUrl(p) {
  return 'data:image/png;base64,' + readFileSync(p).toString('base64');
}


async function reviewViaGrok(capture, webPath, mobPath, userText) {
  const prompt = [
    SYSTEM,
    '',
    userText,
    '',
    'Read these two image files with your image-reading tool:',
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
    'Do not read any other file.',
  ].join('\n');

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
  const out = envelope.structuredOutput;
  if (!out) throw new Error('grok returned no structuredOutput');
  return out;
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

  const body = {
    model: MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        // Each image is labelled immediately before it. Without this the model
        // cannot reliably tell the two apart and inverts the direction of a
        // finding — observed on the first run, where it reported mobile's
        // theme toggle as "missing from mobile".
        content: [
          { type: 'text', text: userText },
          { type: 'text', text: 'IMAGE 1 OF 2 — THE WEBAPP (source of truth). Everything in this image is what the mobile app must mirror:' },
          { type: 'image_url', image_url: { url: dataUrl(web) } },
          { type: 'text', text: 'IMAGE 2 OF 2 — THE MOBILE APP (the mirror being checked). Report only things present in IMAGE 1 and absent or different here:' },
          { type: 'image_url', image_url: { url: dataUrl(mob) } },
          { type: 'text', text: 'Before reporting a finding, state to yourself which image the feature is in. If it exists in IMAGE 2 but not IMAGE 1, it is mobile-only — that is NOT a finding unless it contradicts the webapp.' },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };

  if (BACKEND === 'grok') {
    let parsedGrok;
    try {
      parsedGrok = await reviewViaGrok(capture, web, mob, userText);
    } catch (err) {
      return { id: capture.id, error: `grok: ${String(err.message ?? err).slice(0, 200)}`, findings: [] };
    }
    return { id: capture.id, findings: normalise(parsedGrok.findings) };
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { id: capture.id, error: `${res.status} ${(await res.text()).slice(0, 200)}`, findings: [] };
  }
  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content ?? '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { id: capture.id, error: 'model returned non-JSON', findings: [] };
  }
  return { id: capture.id, findings: normalise(parsed.findings) };
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

async function main() {
  if (BACKEND !== 'grok' && !API_KEY) {
    console.error('No API key. Set PARITY_REVIEW_API_KEY, or LLM_API_KEY in ttd-backend/.env.');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const captures = manifest.captures.filter((c) => !only || c.id === only);

  const results = await pool(captures, CONCURRENCY, reviewOne);
  mkdirSync(OUT, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    backend: BACKEND,
    model: BACKEND === 'grok' ? 'grok-cli' : MODEL,
    results,
  };
  writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(payload, null, 2));

  const total = results.reduce((n, r) => n + r.findings.length, 0);
  const errored = results.filter((r) => r.error);
  console.log(`[parity-review] ${results.length} pair(s) reviewed, ${total} finding(s) → parity-out/findings.json`);
  if (errored.length) {
    console.log(`[parity-review] ${errored.length} pair(s) errored — findings are INCOMPLETE`);
    process.exit(1);
  }
}

main();
