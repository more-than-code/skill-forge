---
name: product-parity
description: Verify that a mirrored or ported client faithfully reproduces its source of truth — screens, look, geometry, design tokens, copy/i18n, interaction behaviour, and the API calls behind them — using a capture-driven parity harness rather than code review. Use when porting or mirroring a product to a second client (web ↔ mobile or any pair), auditing feature/screen parity, investigating "the two clients differ" reports, or when a parity phase was marked complete on static-audit evidence alone. Covers capture harness design, dynamic-state capture via named prep steps, per-screen/per-lens working discipline, false-positive control, and coverage accounting.
---

# Product parity

Verifying that a mirrored client reproduces its source of truth — not only how it
looks, but what it does: routes, interaction behaviour, and the API calls behind
them. The failure this skill prevents: a parity phase closing "complete" on
evidence that structurally cannot see the gaps it claims to have checked.

**Parity is a product property, not a visual one.** A screenshot pair proves two
surfaces look alike; it cannot distinguish a live control from a dead icon, and it
never asks whether either client is *right*. Treat look as one lens among several
(§3), not as the definition of the job.

Companion files in this directory — load the one the task needs:

- **`REFERENCE.md`** — the bundled gate: every script, checks A–N, their config blocks and
  the files they read. Load it to configure the harness or trace a gate failure.
- **`DYNAMIC-STATES.md`** — capturing menus, sheets and API-driven states with `prep` steps.
- **`RECIPES.md`** — implementation recipes: manifest shape, source and mirror capture,
  data handoff, board generator, runner.

## 1. The core principle

**Static audit cannot verify UI parity.** Reading both codebases proves routes
exist, calls are made, and nothing crashes. It is blind to what parity actually
means: states, secondary actions, in-page information architecture, and copy.

Lint + type-check + unit tests + a code-reading audit can all be green while
every screen differs. The only evidence that settles it is **a rendered artifact
from each client, side by side, from identical data**.

If someone proposes closing a parity milestone on a code audit, that is the
smell. Ask what rendered output was compared.

### This board answers ONE of several questions — know which

Conflating these is how a client's bug becomes the specification.

| Axis | Question | Authority | Mechanism |
|---|---|---|---|
| **Product parity** | can the user do the same things — affordances, copy, states, in-page IA? | the **source client** | this board + the vision review |
| **Token conformance** | are the design tokens *declared* correctly in each client? | the **design system**, if one exists | a deterministic token check (check D) |
| **Geometry / alignment** | do shared-chrome regions that should share a vertical centre actually do so on *both* clients? | the **source client** (cross-client spread) | a deterministic geometry check (check H) |
| **Visual conformance** | does the rendered result actually *look* right? | the **design system** | usually nothing — see below |

**The vision review is the product-parity axis only.** Its prompt puts layout,
spacing, alignment, ordering, type scale, font size and colour explicitly *out of
scope*, because LLM judgement on those is the noisiest thing it does and because
a mirroring client is allowed to differ there. Do not read a green vision review
as "it looks right" — it never asked.

**The usual blind spot:** a token check compares *declarations*, not pixels. A
client can define every canonical token perfectly and still apply the wrong one
in the wrong place. If the design system publishes rendered component previews,
that gap is closeable — but note the asymmetry: previews generated *from* the
source client can only ever match it, so the meaningful comparison is
**mirror-client rendering vs the design-system preview**. Prefer sampling
computed values at known anchors (deterministic, can gate) over asking a model
whether two images look the same (noisy, gets switched off).

## 2. The parity board

```
one fixed data world (shared seeded DB / fixed backend state)
        │
        ├─► [1] source client capture  ──► out/<source>/<id>.png
        │        └── + record the API bodies it rendered from ──► out/api/<id>.json
        │                                                              │
        │                                              [2] data handoff
        │                                                              ▼
        └─► [3] mirror client capture (headless) ────────────► out/<mirror>/<id>.png
                                                                       │
                                          [4] pair into a board ───────┴──► board.html
                                                                       │
                                                     [5] semantic review (human/vision)
                                                                       ▼
                                                               gap list → tracker
```

**Manifest-driven.** One entry per `(screen, state)`: route on each client, auth
mode, readiness selector, the API endpoints the screen depends on, and a
checklist of jobs/actions/states. Adding a screen must be **one manifest entry
and nothing else** — the moment it requires harness code, the loop stops being
run.

**Either client can be the source.** The config's `source` and `mirror` blocks name the
two columns (`REFERENCE.md`, "The two columns"); the defaults are a web source and a
Flutter mirror. Name them correctly: the reviewer is told which image is the source of
truth from those names.

## 3. Work one screen and one lens at a time

The gate reports every failure across every capture at once. That is right for *reporting*
and wrong for *working*: a 13-finding ratchet plus a coverage failure plus an a11y count is
not a task, it is a weather report. Sweeping across all of it produces half-fixes in ten
places and a diff nobody can review.

**Pick one capture and one lens. Finish it. Re-run. Then pick the next.**

A lens is one question about one screen — **except the ones that are not**:

| Lens | Question | Evidence | Scope |
|---|---|---|---|
| Coverage | is this screen captured at all, on both clients? | manifest entry + two PNGs (check A) | per-capture |
| Look | do the pixels agree? | visual review finding for THIS capture (check F) | per-capture |
| Geometry | do declared regions share a centre on both? | check H | per-capture |
| Interaction | are the affordances real, activatable controls? | check I + semantics dump | per-capture |
| Control names | do both clients expose the same controls in shared chrome? | check K | per-region |
| Data / API | did both clients request the declared endpoints? | check J + api bags (one documented entry shape — `REFERENCE.md`, J) | per-capture |
| Tokens | do both clients use canon values? | check D | **project-wide** |
| Copy / i18n | same strings, same keys? | checks B/C | **project-wide** |
| Assets | does every source image asset have a mirror counterpart? | check N | **project-wide** |
| Run validity | can this run's artifacts be trusted at all — and are they newer than the source UI? | checks G, L, M | **per-run** |

**A project-wide lens cannot answer a per-screen question, and a screen is never "done"
on its say-so.** Check D compares token *declarations* across the whole app; checks B/C
compare the *values of shared keys*. Neither knows which screen you are working on, so
"chat canvas × tokens" is not a task that exists. The per-run lens is a precondition, not
a task: if G or L fails, nothing else in that run means anything yet.

The failure this causes has a name — **call-site choice**. Both clients can define every
key identically and still pick the wrong one in a given place. Measured 2026-08-17: the
mirror's single-chat menu rendered `chat_archive_action` ("Archive") where the source
client rendered `chat_archive_one_action` ("Archive chat") — the mirror using the *bulk*
string for a *single-item* action. Check C passed, correctly: both keys exist on both
clients with identical values. The vision reviewer had both labels in front of it across
two runs and reported nothing. It was found by reading the two call sites.

This is the same shape as the icon-only gap (§6): **a lens whose scope does not match the
question being asked.** When you catch one, ask which lens *should* have owned it, and
whether that lens can be scoped to the thing that varies.

One more scope hole worth knowing: check C excludes multi-line source entries from the
drift comparison and says so in its output (`N source entries not single-line, excluded`).
That count is strings sitting outside the check while it reads as green. Read the number;
do not let it become invisible.

Why this ordering discipline matters, from a real session:

- Fixing "the composer looks wrong" turned out to need FIVE separate lenses — geometry
  (a framework tap-target default), interaction (an unnamed control), coverage (no capture
  reached the typed state), look, and finally data. Attacked as one problem it produced
  three wrong diagnoses in a row. Attacked one lens at a time, each step was decidable.
- A single capture's fix routinely INVALIDATES other captures (re-capturing the mirror
  skews the columns, which fails freshness). Finishing one screen and re-running keeps that
  visible instead of burying it under the next change.

**Definition of done for one screen×lens:** the specific check passes, you ran it yourself
and pasted the output, and nothing that previously passed now fails. If a fix requires a
second lens, that is a second pass — write the finding down and come back to it.

Do NOT batch a rename, a token change and a capture change into one commit because they
were all discovered in the same run. Commit per intent.

## 4. Dynamic states (menus, popups, actions, API calls)

A capture is one static state, so anything reached by *doing* something — dropdowns,
context menus, sheets, the result of a tap that fires an API call — is invisible to every
check in this harness. The mechanism that closes it is `prep`: named steps performed
between ready and the screenshot, implemented by BOTH harnesses under the same name.

Read **`DYNAMIC-STATES.md`** before adding a step, a dynamic capture, or an API assertion.
The rule that matters most: a `prep` implemented on one client only makes the two columns
photograph different screens, which is worse than no capture at all.

## 5. Hard rules

### Never pixel-diff a parity bar that excludes pixel parity
Most mirroring efforts explicitly allow layout, spacing, and type-scale to
differ. A pixel or SSIM diff then fails ~100% of pairs and carries zero signal.
Comparison is a **judgement task against a checklist** — same jobs, same IA,
same actions, same states, same copy — not a threshold task.

### Both clients must render from identical data
Different content between columns produces noise that drowns real gaps. Capture
the source client's API responses and feed them to the mirror's fakes.

**The fixed-world precondition is fragile.** If anyone is using the app against
the same database while captures run, the two columns will legitimately show
different content from a single pipeline run — the source screenshot and the API
fetch happen at different instants. Before reading content differences as gaps,
confirm nobody was writing to the data world. Prefer a quiesced or snapshot
database for captures you intend to act on.

### Passive response recording fails against server-side rendering
If the source app renders server-side (SvelteKit `+page.server.ts`, Next.js
server components, Rails, …), the **browser never issues the API calls** — the
server does, internally. A `page.on('response')` recorder captures nothing
useful.

**Use active fetch:** declare each screen's endpoints in the manifest and fetch
them through the *authenticated browser context* (Playwright `page.request`),
which shares the cookie jar. Works regardless of who initiates the call. Keep
passive recording as a supplement for genuinely client-side calls.

### Every faked dependency must be data-wired
Wiring only some repositories and leaving the rest returning empty lists makes
those screens render their empty state — indistinguishable from a real gap. This
is the same failure as the SSR one, on the other side of the handoff.

**Guard it:** add per-capture content assertions so an empty render **fails the
test** rather than silently writing a blank image.

### Load fonts and icon fonts in the headless harness
Widget/component test runners do not load bundled fonts. Icons render as tofu
boxes and unstyled text renders as solid blocks, which destroys icon and copy
review. Load the text font, the icon font, and any framework-bundled fonts
explicitly. Resolve package paths from the dependency manifest, not a hardcoded
cache path.

### The instrument must not edit what it measures
When delegating, forbid the agent fixing gaps from touching the harness, and
forbid the agent building the harness from touching product code. Otherwise the
before/after proof is worthless.

**One carve-out:** when a fix adds a *model field*, the fixture reader must learn
to supply it or the change can never appear in a capture. Allow **data wiring**
(parsing a new field and passing it through); still forbid changes to
assertions, comparison logic, or capture selection. Require the delegate to
disclose it, and review the diff — data wiring cannot fake a result, but an
assertion change can.

### Keep the capture test out of the default test suite

The mirror-side capture is usually written as a golden/snapshot test, so it lands in
`test/` and runs on every `npm test` / `flutter test` / `pytest`. That means **any
routine test run silently rewrites one column of the board** — and the columns then
come from different builds, so every pair compares mismatched output while the board
still looks populated.

Tag it and exclude it by default; produce captures *only* from the pipeline script,
which does both columns together. For Flutter:

```yaml
# dart_test.yaml
tags:
  parity:
    skip: "capture test — writes parity-out/; run via scripts/parity/run.sh"
```

```dart
@Tags(['parity'])
library;
```

and have the runner pass `--run-skipped`. Verify the exclusion empirically — compare a
capture's mtime before and after a plain test run — rather than assuming the tag took.

This is not hypothetical: it was found only because `capture-columns-skewed` fired
after an unrelated `flutter test`, 4107 minutes of skew that nothing else would have
surfaced.

## 6. False positives are more convincing than real findings

A parity board manufactures failures that look exactly like bugs. **Maintain an
explicit artifact table** in the plan doc and check every finding against it
before logging.

Recurring artifact classes:

| Class | Looks like | Actually is |
|---|---|---|
| Deliberately stubbed subsystem | A sync/feature bug (e.g. mirror shows 6 items, source shows 17) | A provider you overrode to a no-op to keep captures offline |
| Missing glyph coverage | Broken text rendering | Test font stack lacks CJK/script glyphs; fine on real devices |
| Image decoding | Missing assets | Asset/network images not decoded in the test runner; often inconsistent *within one screen*. A fallback drawn **over** an image that did load is not this — it is a bug (below) |
| Fallback font | Wrong typeface / black bars | A style that bypasses the theme font resolves to the runner's default |
| Concurrent writer | Reviewer non-determinism; a gap that appears or vanishes between runs | A second agent or process writing the same output tree — see below |

The stubbed-subsystem one is the dangerous case: it mimics a real defect **and**
often there is an open ticket about exactly that subsystem, so it gets believed.

### "Probably the harness" is a hypothesis, never a verdict

The artifact table cuts both ways. Once a class of difference is known to come from the
harness, every difference that *resembles* it gets waved through — and a real defect that
looks like an artifact sits on the board indefinitely.

Observed 2026-11-06, on one project: a mirror avatar painted the person's initial on top of
every portrait. It was visible in the parity captures for about three months and in device
screenshots taken for unrelated changes. Reviewer and agents read it as the harness's
no-image fallback, because other avatars on the same screens really were falling back to
initials. Widget tests passed: the letter is in the tree either way.

- **Every difference between the columns is a finding until it is adjudicated** — fixed, or
  recorded in the accepted-findings baseline with a reason. An artifact explanation is
  something to *verify* (does the artifact's mechanism produce exactly this?), not a label
  to apply because it fits.
- **Close the artifact where you can, rather than learning to see past it.** Load real image
  assets in the headless harness, and record which captures still fell back, so a fallback
  is a known, per-capture fact instead of a screen-wide excuse (`RECIPES.md`).
- **A screenshot taken for one change is a parity sample of the whole frame.** When an agent
  captures a device or browser to check one thing, it also compares the rest of the frame
  with the source client and lists every difference it sees — in the same report, even when
  the change under test is fine.

### Scope every suppression rule to a CAPTURE, never to a subject

Each artifact above becomes a "never report this" line in the reviewer prompt. **A rule
scoped by subject silences that subject everywhere**, including on screens the artifact
cannot occur on — and a false negative is invisible, so nothing ever tells you.

Measured 2026-08-17. The prompt carried:

> *"The sticker catalog shows fewer stickers on the RIGHT because sticker sync is stubbed
> offline in the harness."*

Written about one screen. The reviewer generalised it to *any* sticker difference, and
stayed silent on a P1: the source client had replaced its composer sticker button with a
reasoning-effort control and the mirror still showed the sticker. **Zero findings on that
capture across two runs on fresh, correctly paired images.** The gap was found by a human
recalling the product change, then confirmed by source diff in minutes.

Note the direction, because it is the tell: the rule anticipated **fewer** stickers on the
mirror; the real gap was an **extra** sticker control on the mirror. A rule cannot even be
checked against reality when it is phrased as a topic rather than an observation.

Write them as: *this capture, this element, this direction.* Then add the counter-clause
explicitly — "a sticker **button** present on one client and not the other, on any screen,
IS a finding" — because the model will otherwise fill the gap by generalising. The
reviewer enforces that shape: every `review.artifacts` entry needs `captures`, `element`,
`direction`, `cause`, `counterClause`, `owner`, `addedOn` and `removeWhen`.

**Audit the suppression list whenever a real gap is found and the reviewer missed it.** That
is the only signal you get; there is no failing test for a false negative.

### Icon-only affordances are invisible to the vision review by design

The prompt puts iconography and layout out of scope — correctly, since a mirroring client is
allowed to differ there. The consequence is that **swapping one icon-only control for another
in the same slot is a change the vision review cannot report** without violating its own
scope. That is not a prompt bug and cannot be fixed by rewording.

**Do not try to fix this with prompt tuning — measure it instead.** On one project
(2026-08-17) a confirmed gap of exactly this shape — the source client's composer swapped an
icon-only control for a different one, the mirror kept the old one — was reported by the
vision reviewer in a small minority of repeated runs on identical, correctly paired, fully
legible captures, while a control-name diff found it every time. The prompt was rewritten
twice in between, ending with the relevant suppression scoped away from that capture *and* an
explicit clause saying such a difference IS a finding. Detection did not improve. The
reviewer is comparing two unlabelled glyphs; being told what to report does not help it
see them. Its one hit described the source glyph as a "paper-plane send" when it is a
rocket — it was guessing.

That is one observation on one product, and it is here to explain a MECHANISM, not to serve
as a benchmark: **run your own sensitivity test** (`REFERENCE.md`, "Review backends")
rather than citing a number from someone else's project.

The check that closes it is **check K, the control-name set diff** — which also compares *images* in the region, so a source image whose label the mirror shows only as text fails as "image on the source, text on the mirror". Both clients dump their
accessibility tree and the gate compares the sets of accessible names. It needs a semantics
dump from **both** clients; until the source client emits one, this class is uncovered — say
so when reporting coverage rather than letting a green review imply otherwise.

**Scope it geometrically or it will be switched off.** A whole-screen diff drowns: measured
on the same capture, the source client yielded 91 interactive nodes against the mirror's 17,
because a full-page capture includes the entire scrollback while the mirror captures a
viewport. Raw diff = 25 differences, ~3 real. Filtering by role (91 → 19) and by name length
does not fix it, because the survivors are *content* — the two clients legitimately show
different messages. Check K therefore compares only within declared regions of shared
chrome, and requires BOTH clients to emit painted, viewport-relative coordinates. A dump
that reports layout position instead will put pinned chrome outside the viewport and the
region will match nothing — the check refuses to grade such a dump.

### A second writer corrupts the board silently, and looks like model variance

The output tree is usually one untracked directory with no locking — captures, semantics
dumps, api bags, the review output and the filing ledger all in it. Nothing stops a second
agent, a parallel session, or a stray test run writing there mid-analysis.

**The tell: findings change without you running the reviewer.** Also — a gap you confirmed in
source disappears between runs, or a control appears on the mirror that its committed code
does not contain. Reach for that explanation *before* concluding the reviewer is
non-deterministic, because both look identical from where you are sitting.

Why the other validity checks cannot save you here: every one of them was built for **stale**
inputs. A review-vs-capture timestamp comparison, a column-skew comparison — a concurrent
write defeats both, because it is *fresh* and it is *consistent*. It simply belongs to
someone else's run.

Observed 2026-08-17: a second session re-ran the reviewer and landed a product fix on a
branch while a first session was measuring. The changing results were written up as a
measured property of the reviewer, and a fix was reported as landed when it existed only on
an unmerged branch. Both conclusions came from contaminated state, drawn by a harness whose
entire purpose is refusing to do that.

Two things follow, and the first matters more:

1. **Isolate before you measure.** Give each run its own output directory. Sharing a
   directory is not a small risk to manage — it invalidates the results, and you cannot tell
   afterwards which findings were yours.
2. **Stamp the run and check attribution** — the artifacts must belong to the run that claims
   to have produced them (check L, from the pipeline's `.run.json`). This is the backstop for
   when isolation is skipped.

And when a fix appears to have landed, **verify which branch it is on** before recording it.
A capture renders the working tree, not the mainline.

### A duplicate capture manufactures findings in bulk

If two manifest entries render **the same screen on one side** — no seeded
session, a redirect, a shared empty state — then every difference on the *other*
side reads as a gap, and the reviewer will report each one confidently. This is
the highest-yield false-positive source found so far: on 2026-08-03 four
byte-identical source captures produced **22 of 51 findings**.

The gate checks this before anything else is graded (`duplicate-captures:<column>`). The
fix is to seed the state those routes need, or waive them — **never** accept their
findings into the baseline, which would bake a fixture defect into the ratchet
permanently.

Note the asymmetry when you see it: duplicates on the *source* column mean one
screen is being compared against several distinct mirror screens; duplicates on
the *mirror* column often mean the mirror genuinely fails to distinguish two
states (e.g. guest vs signed-in home) — that one may be a real finding.

## 7. Coverage is the ceiling

**A screen absent from the manifest reads as silence, and silence is
indistinguishable from success.** This is the single most likely way a parity
board misleads.

**A green Tier 1 gate says nothing about visuals.** Routes, strings, API calls and
control names are text, and an image usually carries a text alternative — so a logo on
the source and the same word as plain text on the mirror pass every one of those checks.
A visual parity claim needs a **Tier 2 capture newer than the last UI commit** to the
source client, and the gate now refuses to pass a board older than that (check M).
Observed 2026-11-07 on one project: the source client added a brand wordmark to its
header, login and standalone pages; the mirror had no brand assets and printed the
product name. The last full capture was nearly three months old, the gate was green, and
the gap surfaced only when the owner asked. It was the third miss of one shape: a visible
difference no check could see (§6, "Probably the harness"). Declare the source's asset
folders (check N) so a new image fails the day it lands, with no capture needed.

Rules:
- **Never report "N/N green" without stating what is not captured** — and which checks
  the gate skipped. A skipped check is printed as a note, not a failure.
- Audit the manifest against the source client's full route list before trusting any parity claim.
- Empty/default states are not coverage of the populated screen. A route captured only in its empty state has not been compared.
- The screens most likely to be missing are the ones whose dependencies are hardest to fake — which are usually the most important screens (the primary conversation/feed/editor view).

**Pick fixtures that exercise the feature.** Capturing an entity that lacks the
data under test proves nothing: a profile screen rendered for an entity with no
optional fields will look correct even when the field port is entirely broken.
Choose the entity *with* the data, or add a second capture that has it.

**Screen captures do not cover catalog-wide invariants.** A board verifies the
entities you pointed it at. If every item in a catalog must satisfy a property,
write a test that **enumerates the catalog** — that is cheaper and stronger than
N more captures.

## 8. Before judging by eye, verify what is running

Reports of "the UI is wrong" are frequently stale builds. Hot reload does not
re-run lazily-initialised top-level state, so newly added fields read as null on
retained instances, and edits to generated files may not be live at all.

Check before investigating: compare committed vs working-tree values for the
string in question, and confirm the runtime actually reloaded. A crash on a
field that provably cannot be null is a stale-reload signature — prove it with a
fresh-process test rather than "fixing" sound code.

Related: an edit to a source data file (`.arb`, `.json`, locale module) that
feeds a **generated** artifact has no runtime effect until regeneration. Verify
the generated file, not just the source.

## 9. Workflow

1. **Inventory** the source client's routes; list them against the manifest. Name the uncovered ones explicitly.
2. **Pilot** 3–4 screens end to end before scaling. Confirm the board surfaces a gap you already know about — if it cannot reproduce a known gap, the format is wrong.
3. **Scale** by adding manifest entries. Watch for empty renders on newly added screens (§5).
4. **Review** each pair against its checklist (§11), filtering through the artifact table (§6).
5. **Record** gaps in the tracker with the evidence, and artifacts in the plan doc so they are never re-litigated.
6. **Fix** in a separate pass, with the harness frozen. Re-run and diff the captures to prove closure — not "I wrote the code".

### 9.1 The board measures; it does not close

A screenshot pipeline is a **ratchet**: it answers "did the gap grow?" It never answers
"who is shrinking it?" Projects run it for weeks, keep it green, and find the gap
untouched — because measuring got mistaken for mirroring. The closing loop is a
different activity and it is mostly **source diffing**, not looking at pictures:

```
capability diff (source, file:line both sides)
  → adjudicate each claim against source
    → implement one gap
      → verify on the real device/browser
        → re-capture, re-run the gate
```

**Capability gaps produce no pixels.** A dropped part, an unhandled variant, a field read
under the wrong name — each renders as *nothing*, and nothing looks like clean design.
The board shows a tidy screen and the reviewer reports no finding. Measured 2026-08-08
on one project: a controller consuming only two of its stream's part types silently
dropped every in-chat card. Weeks of visual review never mentioned it; one source diff
found it in an hour. **If the mirror is far behind, diff the source. Do not add
screenshots.**

### 9.2 Read the source of truth — never derive from the mirror

When implementing a mirrored value, read it from the **source client**. Never copy the
value already sitting in the target: you will propagate its errors and make them look
deliberate.

Observed the same day: a composer line-height was "fixed" by matching the hint to the
field's own existing value. Both then agreed — and both were wrong against the web
source (`text-sm leading-5` = 14px text on a **20px** line box; the target had 1.25,
a 17.5px box). The internal inconsistency was fixed and the actual mirroring error
survived, because the mirror was treated as the spec.

This is the same instinct as trusting a reviewer's finding text, and the same instinct
that lets one client's bug become the specification. **The mirror is never evidence
about the source.**

### 9.3 Say how you verified

Every completion claim names its evidence in one line. "Analyzer clean, not run on
device" is a fine thing to say; "fixed" when you mean "compiles" is not.

The recurring failure is accepting a **proxy** for the thing itself — a linter for a
working app, a match count for absent code, an exit code for work done, a rendered card
for a *current* card. For UI work the definition of done is **seen on the real
surface**: build, launch, screenshot. Twice in one session a fix was reported from
analyzer output alone and did not hold up on device.

### 9.4 Reviewer output is a lead list, never a finding list

Adjudicate every visual finding against source before writing code. On a 13-finding run
(2026-08-08): 6 confirmed, 4 false, 3 inverted — **more than half wrong**, and one would
have deleted a correct feature from the mirror. The same model, given the same findings
as a *source-reading* task, correctly identified its own earlier inversions. Inversion is
not peculiar to one backend: every backend tried has at some point reported a control as
missing on the mirror when only the mirror had it.

Accepting a finding into the baseline is a decision that needs an owner and a tracker
entry. Otherwise the baseline becomes where gaps go to be forgotten: the gate goes
green, and "accepted" quietly reads as "resolved".

**An acceptance is of one screen as it looked, not of a category forever.** Observed
2026-11-07 on one project: `copy-mismatch` and `missing-state` accepted on a Settings
capture in August silently covered a full Settings restructure in November. The gate pins
each acceptance to the sha256 of the source capture it was reviewed against, so it lapses
when that screen changes.

### 9.5 Route findings to a queue a human actually works

Adjudication that happens by reading `findings.json` happens rarely, and a decision nobody
makes is a decision to ship the gap. Findings need a durable queue with both captures
attached, worked in the same unit this skill works in — one screen, one lens at a time.

If the project has a defect inventory, file into it: see the **`defect-drainer-intake`**
skill for the bridge contract and the adjudication loop. Two rules matter regardless of
where the queue lives:

- **The bridge files everything.** A bridge that drops low-confidence findings has replaced
  the human's judgement with its own, and the human is now reviewing the bridge.
- **A closed false positive must also update the baseline here**, or the next run reports it
  again and the queue teaches people to ignore it.

**The arrow back matters more than the queue.** An adjudication you have made twice is a
deterministic check you have not written yet — that is how the composer misalignment became
check H and stopped needing a human forever. Every lens in §3 earns unattended status one
check at a time, by being right repeatedly, never by a decision that the harness is now
trustworthy.

## 10. Enforcement — the part that actually prevents recurrence

A one-off audit, however good, decays from the moment it is taken. The source
client keeps shipping; the mirror does not. **If the comparison is not a gate, it
is a snapshot, and you will be re-running this exercise in three months.**

Design the loop so drift *fails something*. The bundled gate (`REFERENCE.md`) implements
everything below; this section is why each check exists and how to keep it honest.

### Tier 1 — cheap, no browser, run on every change

These need no capture infrastructure and catch a large share of drift:

- **Coverage ratchet (A).** Enumerate the source client's routes and assert every one has a manifest entry (or an explicit waiver with reason, date, owner and `removeWhen` — **one gap per waiver**; a waiver whose prose also covers another screen lends that screen its tracker and its hold, which is how one project's Settings drift went on hold behind an unrelated sign-in task). **A new source route with no manifest entry fails the build.** This is the single highest-value gate — it converts the "silence looks like success" failure into a hard error at the moment the gap is created.
- **Copy drift (B, C) and locale coverage.** Diff every shared i18n key between source and mirror; fail on divergence. **A source key the mirror lacks fails too** — it is the cheapest evidence of a source UI the mirror never built. Observed 2026-11-07: a web Settings restructure added 8 keys, the gate printed *"637 shared keys compared"*, and stayed green for 2 days. List deliberate web-only keys in `i18n.sourceOnly` with a reason. Compare the table the app *ships*, not only the editable source. Count, per locale, the mirror's base-locale keys that another locale lacks — they fall back silently, and no shared-key comparison can see them. Observed 2026-11-06 on one project: 70 such keys, hidden from a gate that compared only shared, single-line keys.
- **Catalog invariants.** Enumerate catalogs and assert every entry carries the fields the UI reads (§7). Not part of the gate — write it as a test in the repo.
- **Capture validity (G) and run attribution (L).** The ratchet is only as honest as its inputs, so the gate refuses to grade a run it cannot trust: duplicate captures, a review older than its captures, columns from different runs, artifacts written outside the run's stamped window. **A ratchet over stale inputs is worse than no ratchet: it prints the word PASS.** This was found the hard way — a gate reported *"47 findings, 0 not in baseline"* while grading a two-day-old review, on a day when tokens, theme, chat components and i18n had all changed.
- **Geometry / alignment invariants (H).** Named regions on the captured PNGs that should share a vertical centre are measured on **both** clients; the gate fails when the *spread* between those centres differs across clients by more than a tolerance. This is the check for **implicit framework defaults with no counterpart in the source client** — a class of defect no token comparison and no vision reviewer can see.

  Observed 2026-08-10: Flutter's `IconButton` silently enforces a 48×48 tap target (`MaterialTapTargetSize.padded`) where the web button is content-sized at ~36px. Both rows bottom-align, so the taller sibling set the row height and pushed the composer placeholder ~6.7pt below the icon row — on every screen, for weeks. No token was wrong, no string differed. Five reasoned fixes missed it; the vision reviewer never mentioned it once. Check H failed at 0.652% spread delta pre-fix and passed at 0.060% post-fix.

  **Scope discipline — read before adding entries.** Shared chrome **only**: composer, page header, canvas header, list row. Chrome appears on every screen (so a defect there is systemic) and changes slowly (so declarations do not rot). Per-screen invariants are **not** worth it: region coordinates drift with every redesign, and a check that cries wolf gets switched off. Keep the set under ~**5** entries. A check with 90 entries is a check that lies.

  **Cross-client comparison, not absolute offsets.** Asserting an absolute "correct" offset would make the script the arbiter of good design. Comparing the two keeps the source client the source of truth.

- **Freshness (M) — required.** Declare the source client's UI folders (routes, components, brand and design assets). A commit to them newer than the captures fails the gate with the commits listed, so a board nobody re-ran cannot stay green; `sourceFiles` on a manifest entry narrows it to one screen. Every other validity check compares artifacts with each other — M is the only one that compares them with the product. Unconfigured, it **fails**: an info line saying "not configured" reads as green, and one project ran on 3-month-old captures behind exactly that line. Opt out only with `freshness.optOut: "<reason>"`.
- **Asset parity (N) — required.** Pair each source asset folder with the mirror folder that should carry the same images; a source image with no counterpart fails unless waived with a reason, owner, date and `removeWhen`. It needs no capture, so it is the cheapest visual check there is. Unconfigured, it fails unless `assets.optOut` gives a reason.
- **Inventory parity (O) — required.** Scan both clients' code for the things a screen is built from — API calls at least, and the streamed tool results the source renders specially — and fail on any source item the mirror's code never mentions. **Captures show only the states someone thought to produce; the code shows all of them.** Observed 2026-11-07: two whole features (a chat panel a tool result opens, an AI lookup offered when search finds nothing) were missing on the mirror and the gate passed both — the mirror had no call to either endpoint and no handler for the tool, which a scan finds in a second.
- **Required interaction states (P).** A route with a capture satisfies coverage (A) even when every capture shows it populated. A state behind a user action — an empty search and its fallback, a panel a tool result opens — is its own capture, produced by a `prep` step; declare the ones that matter in `states.required` so their absence fails.
- **Behaviour (I, K) and data (J).** Declared affordances must be activatable controls (I); the controls named in a shared-chrome region must agree across clients (K); both clients must request the endpoints a screen declares (J). These are the only checks that see what a screen *does* and what it is *built from* — a dead icon, a swapped icon-only control and a skipped fetch are all pixel-identical to the correct screen. Declare few of each, for the same reason as H.

### Design-system conformance (check D) — when there is a canon

Skip this if the project has no design system; the check disables itself cleanly.
But if one exists, **it changes who "truth" is** for part of the board.

**The direction that matters.** Without a canon, the mirror is graded against the
source client — so any bug in the source client becomes the specification. That is
not hypothetical: a source client rendered a "Log out" control to signed-out
users, the mirror correctly rendered "Log in", and the vision review dutifully
reported *the mirror* as wrong. A design system fixes this by being upstream of
**both** clients, which is why check D is **symmetric — the source client is
checked too, and fails the same way.**

Keep the canon as one committed, read-only snapshot pulled from the design tool
(`REFERENCE.md`, check D, has the config and the per-format rules).

**What check D cannot see.** It reads declarations, never pixels. A client can
define all N canonical tokens perfectly and still apply the wrong one in the wrong
place. That residue is the visual-conformance axis in §1, and check D is not it.

### Tier 2 — full board, on PR or nightly

- Regenerate captures and fail on any that render empty (content assertions, §5).
- Publish the board as a build artifact so review is one click, not a local setup.

### Definition of done for a mirrored feature

**The source-client change is not done until the mirror has a manifest entry and
a reviewed capture — or a dated, named waiver.** Put this in the contributing
guide. Without it, mirroring is always someone else's later task, nobody is
blocked by its absence, and gaps accumulate silently. That incentive asymmetry,
not ignorance, is what produces most parity debt.

**When a design system exists, that is only half of done.** Two loops close
independently, on different cadences and different authorities:

```
PRODUCT   source-client feature ──▶ mirror implements ──▶ parity board + vision review
          authority: the source client (routes, screens, affordances, copy)

VISUAL    client components ──push──▶ design tool ──(design work)──▶ tokens/guidelines
                                                          │
                                                     pull ▼
                                          ONE committed snapshot
                                                          │
                                        both clients conform ──▶ check D
          authority: the design system (colour, radius, type)
```

A feature is done when **both** are green: the mirror matches (parity board) **and**
both clients conform to canon (check D). Tracking only the first is how a client's
implementation quietly becomes the specification.

**Who does which arrow matters.** The design work happens inside the design tool, by
whatever agent or person works there. **The push and the pull are repo-side actions**
— a coding agent with repo write access — because the design tool cannot write to your
repository. Do not write a workflow that expects the design agent to update the repo
snapshot; it cannot, and the snapshot silently goes stale while everyone assumes it
is current.

### Make it cheap or it will not be run

The loop survives only if adding a screen is one manifest line and running it is
one command. Every step that requires editing harness code is a step where
someone skips it. Budget for that ergonomics work explicitly — it is what
separates a living gate from an abandoned script.

### Who owns what — the test, not the list

The gate and reviewer ship with this skill and reach every repo via `skf sync`; see
`REFERENCE.md` for how to run them without hardcoding where the skill landed.

**The skill owns what stays true when you point the harness at a different product.
The repo owns everything else.**

Memorise the test, not the inventory; the inventory is what the test produces.

| Skill | Repo |
|---|---|
| the gate and the checks | the capture harnesses (both clients) |
| the reviewer's *form* — scope rules, required fields | the capture manifest |
| doctrine: what counts as a finding, how to write a rule | waivers, accepted-findings baseline |
| — | `parity.config.json`, product suppression rules |

The ambiguous cases are all suppressions, and they split on **cause**:

- caused by the **capture technique** — test-runner font stacks, images not decoded,
  fallback glyphs — the skill, because they follow from the capture method it recommends;
- caused by the **product's own stubs or features** — the repo, because the skill cannot
  know what you stubbed.

**A suppression is a waiver, and a broader one.** A per-finding waiver silences one known
thing; a suppression rule silences a whole subject on every capture, forever. Hold it to at
least the waiver standard — reason, owner, date, and the condition that removes it — and
prefer a `removeWhen` condition over a review date. A condition tells the next person what
to verify; a date tells them to have an opinion on a Tuesday.

This is not bookkeeping. Product knowledge stored in the skill is invisible to the people who
would audit it, and it goes stale silently: the rule that cost a P1 on 2026-08-17 was correct
when written and became a defect when the product moved underneath it. Nothing failed,
because a suppression working as designed and a suppression hiding a real gap look identical
from outside.

**Completeness cannot be enforced, and must not be faked.** A new harness legitimately has
zero product artifacts — you learn them *from* the board, by watching it produce false
positives. Hard-failing an empty list just produces an entry written to satisfy the gate.
So the tooling validates the *shape* of every declared rule and says loudly when none are
declared; judging whether the list is complete stays with the human. The event that should
trigger that audit is not a date: it is **a human finding a gap the reviewer missed.**

## 11. Review checklist per pair

- [ ] Same **jobs** available on both
- [ ] Same **primary actions** and confirmations
- [ ] Same **states**: empty, loading, error, guest vs authenticated
- [ ] Same **in-page IA** — what is reachable from here
- [ ] **Copy** matches the source of truth, in every locale
- [ ] Counts, badges, and metadata present on both
- [ ] Differences checked against the artifact table before logging
- [ ] Layout/spacing divergence **ignored** unless the bar says otherwise

## 12. Delegating this work

Split by what the sandbox can run: headless component/golden capture is usually
sandbox-safe; browser automation frequently is not. Have the delegate author the
browser script and run the headless half; run the browser half yourself.

Verify independently — re-run the gates in your own shell and **look at the
images**. A completion claim is not evidence.

Concrete implementation recipes: see `RECIPES.md`.
