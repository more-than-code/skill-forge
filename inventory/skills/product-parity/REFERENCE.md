# REFERENCE — the bundled gate, its checks and their config

The *why* lives in `SKILL.md`; this file is the *what and how*: every script, every check,
the config block that turns it on, and the files it reads. Load it when configuring the
harness or tracing a gate failure.

## Running it

The scripts are companion files of this skill, not per-project code: every repo gets them
via `skf sync`. They are dependency-free Node and config-driven. Drop a
`parity.config.json` at the repo root (start from `scripts/parity.config.example.json`) and
run:

```bash
SKILL_DIR=<the directory this skill was loaded from>
node "$SKILL_DIR/scripts/parity-gate.mjs"      # all checks; exit 0 pass · 1 fail · 2 misconfigured
node "$SKILL_DIR/scripts/parity-review.mjs"    # the vision review → <out>/findings.json
```

The gate also finds `scripts/parity/parity.config.json` and `.parity/parity.config.json`,
or takes `--config <path>`; `--json` prints a machine-readable result.

**Resolve `SKILL_DIR` from where the skill actually landed** — do not hardcode it.
`skf sync` vendors this skill into whichever profile declared it — a repo, an umbrella, or
`$HOME` — and the path differs in each case. Writing any one of them into a runbook breaks
the harness the day the skill moves between profiles.

## Scripts

| File | Role |
|---|---|
| `scripts/parity-gate.mjs` | The gate. Runs checks A–R below, plus i18n locale coverage; no browser, no simulator, ~1s. |
| `scripts/parity-review.mjs` | The LLM vision review — structured findings to `<out>/findings.json`. Feeds check F. |
| `scripts/parity-geometry.mjs` | Check H. Also runnable standalone. |
| `scripts/parity-interactive.mjs` | Check I. Also runnable standalone. |
| `scripts/parity-api.mjs` | Check J. |
| `scripts/parity-names.mjs` | Check K. Also runnable standalone. |
| `scripts/parity-session.mjs` | Check L. Also runnable standalone. |
| `scripts/parity-freshness.mjs` | Check M. Also runnable standalone. |
| `scripts/parity-assets.mjs` | Check N. Also runnable standalone. |
| `scripts/parity-inventory.mjs` | Check O. Also runnable standalone. |
| `scripts/parity-journeys.mjs` | Check Q. Also runnable standalone. |
| `scripts/parity-navigation.mjs` | Check R. Also runnable standalone. |
| `scripts/parity-columns.mjs` | Which client is the source and which the mirror; shared by all of the above. |
| `scripts/parity-strings.mjs` | Reads string tables (TS/JS objects, JSON/ARB, Dart locale maps) for checks B, C and locale coverage. |
| `scripts/parity.config.example.json` | Config template. |

## The two columns

Nothing assumes a particular pair of clients. The config's `source` and `mirror` blocks
name them:

```jsonc
"source": { "name": "webapp",             "column": "web",    "root": "web",    "routes": { ... } },
"mirror": { "name": "Flutter mobile app", "column": "mobile", "root": "mobile" }
```

- `name` is what people and the reviewer read. The reviewer prompt is built from it, so a
  mobile-to-web port says so instead of being told the source is a webapp.
- `column` is the output directory and the manifest key. Defaults are `web` and `mobile`, so
  a config written before these fields existed behaves as it did.

File layout under `<out>` (default `parity-out`, overridden by `PARITY_OUT`):

| Path | Written by | Read by |
|---|---|---|
| `<source column>/<capture>.png`, `<mirror column>/<capture>.png` | the two capture harnesses | F, G, H, L, review |
| `semantics/<capture>.json` | mirror harness (accessibility dump) | E, I, K |
| `semantics/<capture>.<source column>.json` | source harness, if it emits one | I (diagnosis), K |
| `api/<capture>.json` | source capture (active fetch, SKILL.md §5) | J |
| `api/<capture>.<mirror column>.json` | mirror harness (`consumed` list) | J |
| `findings.json` | `parity-review.mjs` | F, G |
| `.run.json` | the pipeline script (`startedAt`, `finishedAt`, `runId`) | L |

A manifest entry carries each client's route under its column key:
`{ "id": "...", "web": { "route": "/x" }, "mobile": { "route": "/x" }, "api": [...], "checklist": {...} }`.

## The checks

Every check skips with a note when its config is absent — other repos vendor this skill
without declaring any of them. **Read the notes:** a skipped check is a hole in coverage,
not a pass.

| Check | Question | Turned on by | Scope |
|---|---|---|---|
| A coverage ratchet | does every source route have a capture or a complete waiver? | `source.routes`, `manifest`, `waivers` | project |
| B regeneration | does every mirror i18n key exist in the generated artifact? | `i18n` | project |
| C copy drift | do shared i18n keys match, and does every source key exist on the mirror? | `i18n` | project |
| — locale coverage | does every mirror locale carry every base-locale key? | `i18n` with `mirrorLocaleFiles` or `dart-map` | project |
| D design tokens | do both clients declare the canonical tokens? | `design` | project |
| E a11y ratchet | do new interactive controls lack an accessible name? | mirror semantics dumps | per capture |
| F visual ratchet | is any vision-review finding new relative to the baseline? | `findings.json`, `acceptedFindings` | per capture |
| G capture validity | are the inputs to F trustworthy? (duplicates, stale review, skewed columns) | always, with F | per run |
| H geometry | do shared-chrome regions share a vertical centre on both clients? | `geometry` | per capture |
| I interactive | do declared affordances resolve to activatable controls? | `interactive` | per capture, mirror only |
| J API parity | did both clients request the endpoints the manifest declares? | manifest `api` arrays | per capture |
| K control names | does the set of control names agree within a region? | `names` | per region |
| L run attribution | was every artifact written by the run that claims it? | `.run.json` | per run |
| M freshness | are the captures newer than the last source commit to the UI they show? | **always**: `freshness.paths`, or `freshness.optOut` with a reason; manifest `sourceFiles` | per run / per capture |
| N asset parity | does every image in a source asset folder have a mirror counterpart? | **always**: `assets.pairs`, or `assets.optOut` with a reason | project |
| O inventory | does every API call (or tool handler, or other declared set) in the source's code exist in the mirror's? | **always**: `inventory.sets`, or `inventory.optOut` with a reason | project |
| P required states | does each declared interaction state have a capture? | `states.required` | per route |
| Q journeys | does each step land on the same screen on both clients, does Back never dead-end, can the mirror pop every non-root it reaches? | **always**: manifest `journeys` + `navigation.roots`, or `journeys.optOut` with a reason | per journey |
| R navigation scan | does the mirror's code replace the stack to reach a drill-down? | `navigation.replace` (optional) | project, mirror only |

### A — coverage ratchet

Route discovery covers file-router frameworks via `source.routes` `{dir, filename}` —
SvelteKit `+page.svelte`, Next.js `app` + `page.tsx`, and similar — with
`"list": [...]` as the escape hatch for anything else. Every discovered route needs a
manifest entry or a waiver; a new source route with neither fails the build.

```jsonc
// waivers.json — one gap per waiver, keyed by the route it waives
{ "routes": {
  "/billing": { "reason": "web-only checkout", "date": "YYYY-MM-DD", "owner": "…",
                "removeWhen": "mobile ships in-app purchase",
                "tracker": "tasks/todo.md#Mobile billing" }      // optional
} }
```

Waivers for routes still uncaptured are graded; one for a route now captured or gone is
listed in a note to remove. A graded waiver missing `reason`, `date`, `owner` or
`removeWhen` fails `coverage-waivers` and waives nothing. A `tracker` is `path#Heading`
(split at the first `#`, heading matched literally, not as a GitHub slug) and that
heading's section must hold at least one unchecked `- [ ]` item outside code fences. The
gate cannot tell an unchecked item that is on hold from one in progress: keep the item for
*this* gap under its own heading, so a hold on another task does not hold it too. A
waiver whose `reason` or `removeWhen` names another route by its full path (`/settings`)
or a capture by its id prints a `waiver warning:` note — give that gap its own waiver.

### B, C — i18n, and locale coverage

```jsonc
"i18n": {
  "sourceFile": "web/src/lib/i18n/en.ts",   "sourceFormat": "ts-object",   // or js-object, json
  // The table the mirror app SHIPS. Either an editable source plus its locale files…
  "mirrorFile": "mobile/lib/l10n/app_en.arb", "mirrorFormat": "arb",       // or json
  "mirrorLocaleFiles": "mobile/lib/l10n/app_{locale}.arb",
  "generatedFile": "mobile/lib/l10n/generated/app_localizations.dart",      // check B
  // …or the generated runtime map itself:
  //   "mirrorFile": "mobile/lib/l10n/generated/app_localizations.dart",
  //   "mirrorFormat": "dart-map", "mirrorVariable": "_localizedValues",
  "baseLocale": "en",
  "coverageBaseline": "scripts/parity/i18n-coverage-baseline.json",          // optional ratchet
  "sourceOnly": { "auth_web_*": "web-only SSO screens" }                     // key or "prefix*" → reason
}
```

- **Every source key needs a mirror key** (`i18n-source-only`), unless `sourceOnly` lists
  it — exact key or `"prefix*"` — with a reason. A source-only key is usually a source UI
  the mirror has not built.
- **Values are parsed, not regex-matched**: keys and values on separate lines, single,
  double and triple quotes, `+` and adjacent-literal concatenation. A value that is still
  not a plain string literal (an interpolated template, a call) fails `i18n-unparsed` by
  key — it is never silently excluded.
- **B** (`i18n-regeneration`) runs only when an editable mirror file feeds a separate
  `generatedFile`. A `dart-map` mirror is the generated artifact.
- **C** (`i18n-copy-drift`) compares the values of keys both clients have.
- **Locale coverage** (`i18n-locale-coverage`) compares each mirror locale against the
  mirror's own base locale: a base key missing or empty in locale L fails, whether or not
  the source client has it. Existing debt can be recorded as
  `{ "missing": { "<locale>": <count> } }` in `coverageBaseline` and may only shrink. With
  one locale read (no `mirrorLocaleFiles`, not a `dart-map`), the gate prints that coverage
  was **not** checked.

### D — design tokens

```jsonc
"design": {
  "dir": "path/to/design",          // committed snapshot pulled FROM the design tool
  "clients": [
    { "name": "webapp", "tokensFile": "src/app.css",                "format": "css"  },
    { "name": "mobile", "tokensFile": "lib/core/theme/tokens.dart", "format": "dart" }
  ]
}
```

- `dir/tokens/*.css` is the canon. Treat it as **read-only in the repo** — edit it in the
  design tool and re-pull, or the next pull silently reverts you.
- **One snapshot, one path.** A per-client copy drifts and no check would catch it.
- `format: "css"` compares names **and values**. `format: "dart"` compares **names only** —
  values are converted (oklch → sRGB, rem → logical px), so value equality is meaningless
  there and asserting it would produce pure noise.
- The CSS parser handles wrapped multi-line declarations. It did not always: a
  line-anchored regex once reported a wrapped `--font-sans` as **missing** rather than
  **drifted** — the opposite diagnosis, on the one token a human was arguing about.

### E — a11y ratchet

Reads the mirror's `semantics/<capture>.json`. Existing unlabelled controls are recorded
per capture and may only shrink; a new one fails the build.

### F, G — visual ratchet and capture validity

F fails only on a `(capture, category)` pair absent from `acceptedFindings`. Accepted
pairs are reported on every run as accepted debt, not resolved.

```jsonc
// accepted-findings.json
{ "accepted": {
  "settings-root": { "categories": ["copy-mismatch"], "sourceSha256": "<sha256 of web/settings-root.png>" }
} }
```

Each acceptance is pinned to the sha256 of the **source** capture it was reviewed against.
When the source screen changes, the acceptance lapses (`accepted-findings-lapsed`) and its
findings return to the ratchet — a restructured screen is never covered by an acceptance of
the old one. The finding text is not hashed: the vision model words the same finding
differently on every run. The legacy form `"<capture>": ["<category>", …]` fails
`accepted-findings-unpinned`, which prints the current hash to pin after a re-review; until
then its categories are still honoured, so the ratchet does not fire twice.

**Source captures must be byte-stable** for this to work: frozen clock, no animation or
caret, fixed viewport and fonts, seeded data, one capture host. Capture one screen twice and
compare hashes; if they differ, fix the capture before pinning anything to it.

G refuses to grade a run it cannot trust:

- `duplicate-captures:<column>` — distinct manifest entries produced byte-identical images.
- `visual-review-stale` — a result was reviewed before its newest capture, or carries no
  `reviewedAt`. Re-review just those captures with `--only <id>`; the reviewer merges.
- `capture-columns-skewed` — the two columns are more than an hour apart, so each pair
  compares two different builds.

### H — geometry

Regions are **fractions** of image width/height so differing scales and DPRs still compare.

```jsonc
"geometry": {
  // SHARED CHROME ONLY — composer / page header / canvas header / list row.
  // Keep under ~5 entries. Do NOT add per-screen invariants.
  "inkThreshold": 170,           // optional; pixels darker than this count as ink
  "toleranceFraction": 0.0015,   // optional; ≈ 1pt on an 844pt-tall capture
  "waivers": [],                 // optional: [{ "invariant": "name", "reason": "..." }]
  "invariants": [
    {
      "name": "chat-composer-row",
      "capture": "chat-conversation",
      // Regions that must share a vertical centre on BOTH clients.
      "regions": {
        "leading-icon":  { "x1": 0.05, "x2": 0.14, "y1": 0.93, "y2": 1.0 },
        "placeholder":   { "x1": 0.16, "x2": 0.42, "y1": 0.93, "y2": 1.0 },
        "trailing-icon": { "x1": 0.84, "x2": 0.94, "y1": 0.93, "y2": 1.0 }
      }
    }
    // Add further shared-chrome entries only when you have measured both columns and the
    // regions are stable. Do not invent coordinates.
  ]
}
```

Missing capture PNGs degrade to a note. Standalone:
`node "$SKILL_DIR/scripts/parity-geometry.mjs" --config parity.config.json`.

### I — interactive affordances

```jsonc
"interactive": {
  "affordances": [
    { "name": "send", "capture": "chat-conversation", "labelContains": "Send", "spec": "optional: what it must do" }
  ],
  "waivers": []                  // [{ "affordance": "send", "reason": "..." }]
}
```

Each declared affordance must resolve, in the mirror's dump, to a node with `role: button`
or `tappable: true`. When the source dump exists it is used to tell "the mirror lacks this
control" from "this capture never renders it". Declare only affordances whose behaviour is
not obvious from appearance — busy states, failure modes, destructive effects.

### J — API parity

Declare each capture's endpoints in the manifest (`"api": ["GET /api/chats"]`). Only
declared endpoints are asserted; query strings are ignored. Waive a capture with
`api.waivers: [{ "capture": "<id>" }]`. The mirror side records what the client asked its
**fixture bag** for, not a live call — weaker than the source side, and the output says so.
A declared endpoint that **neither** client requested fails too: the manifest entry is
stale, so the capture no longer shows the state it claims to.

**The bag contract.** The skill ships the checkers; each project writes its own capture code.
The source bag, `<out>/api/<id>.json`, is the file between them, so its shape is fixed here:

```jsonc
{
  "GET /api/me": { "name": "Ana" },                                   // the parsed response body
  "GET /api/tips": { "_parity": { "kind": "stub", "status": 0, "reason": "not served offline" } },
  "GET /api/export": { "_parity": { "kind": "non-json", "status": 200, "reason": "text/csv" } }
}
```

- **Key:** `"METHOD /path"`; a query string is ignored.
- **Value:** the parsed body, or exactly one marker `{ "_parity": { kind, status, reason } }`,
  `kind` one of `error`, `non-json`, `stub`, `status` an integer.
- **A marker never replaces a body already recorded for the same key.** A repeat call whose
  body could not be read keeps the earlier recording.
- **A mirror harness treats a marker as "no data"** — a stub — never as a response.

The gate fails `api-bag` on any entry with a `_parity…` or `__…` key that is not exactly
that marker, and `api-bag:2xx-error` on an `error` marker whose status is 2xx: the server
answered, the capture failed to read it. Marker counts are reported as a note. The mirror's
own record, `<id>.<mirror column>.json` with `consumed`, is not a bag and is not checked here.

### K — control names

```jsonc
"names": {
  "regions": [
    { "name": "composer", "capture": "chat-conversation", "y1": 0.90, "y2": 1.0 }
  ],
  "accepted": {
    "composer": [ { "name": "Voice input", "reason": "native-only", "owner": "...", "addedOn": "YYYY-MM-DD" } ]
  },
  "waivers": []                  // [{ "region": "composer", "reason": "..." }]
}
```

Compares the set of activatable control names on both clients within a vertical band of
shared chrome — and the set of **image** labels: a source node with role `img`/`image`
must match a mirror node with role `image` or `isImage: true` and the same label. A mirror
node carrying that label as text fails as "image on the source, text on the mirror". Needs both semantics dumps, with **painted, viewport-relative** coordinates:
the check refuses to grade a dump whose nodes fall outside `[0,1]`. Regions are mandatory
— see "Icon-only affordances" in `SKILL.md` for why an unscoped diff gets switched off.

### L — run attribution

The pipeline script writes `<out>/.run.json` with `runId` and `startedAt` before capturing
and adds `finishedAt` after. Any PNG older than the start (a leftover) or newer than the
finish (a concurrent writer) fails the check. With no stamp the check is a note, and
concurrent writes are undetectable.

### M — freshness

```jsonc
"freshness": {
  // Source-client folders whose commits change what a capture shows.
  "paths": ["web/src/routes", "web/src/lib/components", "web/brand"]
}
// optional, per manifest entry: { "id": "login", "sourceFiles": ["web/src/routes/login"], … }
```

The capture time is the **older** column's newest PNG. Any commit to `paths` newer than it
fails `captures-stale`, listing up to 10 commits; a manifest entry's `sourceFiles` does the
same for that screen alone (`captures-stale-screens`). Commits only — uncommitted edits do
not count. A path that does not exist fails `freshness-unresolved`. Unconfigured, it fails `freshness-not-configured`; a project that really does
not need it sets `"optOut": "<reason>"`, which the gate prints on every run.

### N — asset parity

```jsonc
"assets": {
  "pairs": [
    { "name": "brand", "source": "web/brand/svg", "mirror": "mobile/assets/brand",
      "map": { "lockup.svg": "brand_lockup_full.png" } }      // optional, for differing stems
  ],
  "waivers": [
    { "asset": "brand/favicon.svg", "reason": "browser-only", "owner": "…",
      "addedOn": "YYYY-MM-DD", "removeWhen": "never: no mobile equivalent" }
  ]
}
```

Images (`svg png jpg jpeg webp gif ico avif`, recursively) are matched by normalised stem:
lower case, `-`/`_`/spaces folded, extension and `@2x`/`@3x` ignored — `wordmark.svg`
matches `wordmark.png`. A source image with no counterpart fails `asset-parity:<name>`
unless waived; a waiver missing any field fails `asset-parity:waivers`. Mirror-only assets
are counted in a note, not failed. A pair whose source folder does not exist fails
`assets-unresolved:<name>`. Unconfigured, it fails `assets-not-configured` unless
`assets.optOut` gives a reason.

### O — inventory parity

```jsonc
"inventory": {
  "sets": [
    { "name": "endpoints", "normalize": "endpoint",
      "source": { "dirs": ["web/src"], "extensions": [".ts", ".svelte"],
                  "patterns": ["fetch\\(\\s*[`'\"](?<path>/api/[^`'\"]+)[`'\"](?:\\s*,\\s*\\{(?:[^{}]|\\{[^{}]*\\})*?method:\\s*['\"](?<method>[A-Za-z]+)['\"])?"] },
      "mirror": { "dirs": ["mobile/lib"], "extensions": [".dart"],
                  "patterns": ["_dio\\.(?<method>get|post|put|patch|delete)(?:<[^>]*>)?\\(\\s*['\"](?<path>/api/[^'\"]+)['\"]"] },
      "waivers": [ { "item": "POST /api/billing/portal", "reason": "web-only checkout", "owner": "…",
                     "addedOn": "YYYY-MM-DD", "removeWhen": "mobile ships in-app purchase" } ] },
    { "name": "stream-tools",
      "source": { "dirs": ["web/src"], "extensions": [".svelte"], "patterns": ["case\\s+'tool-(?<item>[a-z_]+)'"] },
      "mirror": { "dirs": ["mobile/lib"], "extensions": [".dart"], "patterns": ["'(?<item>[a-z_]+)'\\s*=>"] } },
    { "name": "control-names",
      "source": { "dirs": ["web/src"], "extensions": [".svelte"],
                  "patterns": ["(?:aria-label|title)=\\{t\\('(?<item>[a-z0-9_]+)'"] },
      "mirror": { "dirs": ["mobile/lib"], "extensions": [".dart"], "exclude": ["/generated/"],
                  "patterns": ["l10n\\.(?<item>[a-z0-9_]+)\\b"] } }
  ]
}
```

A static scan of both clients' code, with no capture involved — so it sees features that
no capture shows. Each pattern is a JavaScript regex; named groups `method` + `path` make an
item `"METHOD /path"`, `item` makes the item itself. `normalize: "endpoint"` folds path
parameters (`${x}`, `$x`, `{x}`, a whole-segment `:x`, digit segments, and the trailing `/`
that `'/api/x/' + id` leaves → `:param`) and drops the query, including one built by
interpolation (`/search${qs}`), so `/api/courses/${course.id}` and `/api/courses/$courseId`
are the same endpoint. Waiver items are normalised the same way.

- **Every pattern must match at least once**, on either side: a dead pattern silently
  shrinks the set it feeds, so it fails `inventory-unresolved:<set>`.
- **A call whose pattern found no method counts as GET**, and the note says how many did —
  a POST hidden behind a pattern that missed its method would otherwise pass as a GET.
- **Whole-line comments are skipped**; nothing else is. Use `exclude` (regexes on the path
  relative to the config root, e.g. `"\\.test\\.ts$"`) for tests, mocks and generated code.
  `node_modules`, `.git`, `.dart_tool`, `.svelte-kit` and `.next` are skipped unless
  `skipDirs` replaces the list. Symlinks are not followed.
- The note lists files scanned per side, mirror-only items, and waivers no longer needed.

A source item with no mirror counterpart fails `inventory:<set>` unless waived with
`item`, `reason`, `owner`, `addedOn` and `removeWhen`; mirror-only items are listed in a
note. A missing folder, a bad pattern, or source patterns that match nothing fail
`inventory-unresolved:<set>` — a set that compares nothing would pass any mirror.
Unconfigured, it fails `inventory-not-configured` unless `inventory.optOut` gives a reason.
A scan is text, not a parse: write the patterns for your API layer, and check the note's
counts against what you expect.

**Declare a `control-names` set, not only endpoints.** An icon control's accessible name
(`aria-label` / `title` key on the source, the same key used anywhere on the mirror) is
the cheapest inventory of affordances, and it sees controls that only render in a state no
capture reaches. Observed 2026-11-13 on one project: the source chat's "scroll to bottom"
button shows only once the reader scrolls up, every capture was taken at the bottom, and
the mirror shipped without it — the key was one of 718 in a long-red `i18n-source-only`
list, so nobody saw it. As its own set it was one line of 44. The match works when both
clients share string keys; with different key schemes, compare English values instead.

### P — required interaction states

```jsonc
"states": { "required": [
  { "route": "/dictionary", "state": "empty-search", "reason": "\"Ask AI\" fallback shows only on no match" }
] }
// manifest: { "id": "dictionary-empty", "web": { "route": "/dictionary" }, "state": "empty-search",
//             "prep": ["type-text:zzzz"], … }
```

Each entry needs a manifest capture whose source route matches and whose `state` equals it,
or the gate fails `state-coverage`. A matching capture with no `prep` step is noted: unless
fixture data produces the state, it shows the default screen under the state's name. Coverage (A) is satisfied by any capture of the route;
this is the check that a state behind a user action was captured too. Produce it with a
`prep` step (`DYNAMIC-STATES.md`).

### Q — journeys

```jsonc
// manifest
"journeys": [{
  "id": "record-back-to-completed",
  "start": "practice-hub",                       // a capture whose route is in navigation.roots
  "steps": [
    { "do": "tap:Completed",    "expect": "practice-completed" },
    { "do": "tap:first-record", "expect": "record-detail" },
    { "do": "back",             "expect": "practice-completed" }
  ]
}]
// config
"navigation": { "roots": ["/", "/practice", "/library", "/settings"] }
```

Each harness performs the steps and writes `<out>/journeys/<id>.<column>.json`:

```json
{ "journey": "record-back-to-completed",
  "steps": [ { "do": "back", "route": "/practice/completed", "popped": true, "canPop": true } ] }
```

- `route` is the location after the step, path plus query.
- `popped` is recorded for `back` and `tap-back`: whether anything was popped.
- `canPop` is recorded by the mirror only: whether the screen it landed on can pop.

**How a landing is matched.** Each client's `route` is matched against the `expect` capture's route for **that client's column**, so the two clients may spell routes differently. A capture with no mirror route is taken to use its source route.
- A path segment written `[x]` or `:x` matches any one segment.
- Query keys on the capture's route must be present on the landing with the same value; a value written `:x` matches any.
- A `#fragment` and a trailing `/` are ignored.

**Roots.** `navigation.roots` is spelled in the **mirror's** route scheme and compared on the path only. A journey's `start` must be a root in the mirror column, because the mirror harness reaches it by replacing the stack.

| Failure | Meaning |
|---|---|
| `journeys-not-configured` | no journeys and no `journeys.optOut` reason |
| `journeys:landing` | a client landed somewhere other than `expect` |
| `journeys:dead-end` | `back`/`tap-back` recorded `popped:false`, or stayed on the route it left — whatever `expect` says |
| `journeys:cannot-pop` | mirror `canPop:false` on a route that is not a root |
| `journeys:missing` | no artifact for a column, its step names or count differ from the manifest, or a step has no `route` |
| `journeys:unknown-capture` | the journey is malformed: `start`/`expect` names no capture or a capture with no route, no steps, a step with no `do`, an id that is not `[A-Za-z0-9._-]`, a duplicate id, or a `start` that is not a mirror root |
| `journeys:stale` | an artifact older than `.run.json` `startedAt` (5 s grace). With no stamp, a note says staleness is unchecked |

A mirror step without `canPop` is counted in a note, never passed silently. The step rules, the vocabulary and the harness recipes are in `JOURNEYS.md`.

### R — navigation scan

```jsonc
"navigation": {
  "roots": ["/", "/practice"],
  "replace": {
    "dirs": ["mobile/lib"], "extensions": [".dart"],
    "patterns": ["context\\.go\\(\\s*(?:'(?<path>[^']+)'|(?<expr>[A-Za-z_][\\w.]*))"],
    "waivers": [{ "item": "/practice/new", "reason": "…", "owner": "…", "addedOn": "2026-11-13", "removeWhen": "…" }]
  }
}
```

How the scan reads a match:
- **Named group `path`:** a literal target. It is normalised (interpolations, `{x}`, `[x]`, `:x` and digit segments become `:param`; the query is dropped) and compared with the roots.
- **No `path`, a literal ending in `/` (`'/records/' + id`), or a literal that is only an interpolation (`'$path'`):** a dynamic target. It is counted in a note, never failed. Read those call sites by hand.

`exclude` (regexes on the relative path) and `skipDirs` work as in check O. Whole-line comments are skipped, and symlinks under `dirs` are not followed.

Failures and notes:

| Id | Meaning |
|---|---|
| `navigation:replace` | a non-root target, listed with `file:line` |
| `navigation:waivers` | a waiver missing a field |
| `navigation-unresolved` | missing roots, bad folders, a bad regex, or a pattern that matched nothing |

A stale waiver is listed in a note. With no `navigation.replace`, the scan is a note only.

## Review backends

`parity-review.mjs` supports **local coding-agent CLIs only** — `grok`, `claude`, `codex`
— chosen with `PARITY_REVIEW_BACKEND` (default `grok`). The remote `chat/completions` path
was removed deliberately: parity review should not share the product's API keys, depend on
a paid vision API, or reuse the app's model defaults for left/right screenshot judgement.

Each backend runs read-only in the config root, which may be an umbrella folder that is not
a git repository (`codex` is passed `--skip-git-repo-check` for that reason). The CLI must be
installed and signed in. When one fails, the pair's `error` reads
`<cli> exited <code>: <first stderr line>`, for example `grok exited 1: Error: Not signed in`.

Backends differ in recall and every one of them has **inverted** left and right at least
once — reported a control as missing on the mirror when only the mirror had it. So:

- Verify every finding against source before acting on it, whatever the backend.
- **Zero findings is not proof either.** Spot-check the two screenshots behind every clean
  result. Observed 2026-11-07: a re-review called a pair clean that had an invisible
  selected chip and a profile screen of nothing but "—" placeholders.
- For a load-bearing parity claim, run more than one backend and take the **union**.
- **Sensitivity-test whichever you pick**: run it on a pair you know is at parity (expect
  silence) and on a capture with known, deliberate gaps (expect the gaps). A reviewer that
  has not been tested this way is an unknown, not a gate. Keep the results in the repo that
  produced them, where the conditions are known.

Product-specific suppression rules go in `review.artifacts`; every field is required and
validated before any capture is reviewed. See `scripts/parity.config.example.json` and
"Scope every suppression rule to a CAPTURE" in `SKILL.md`.
