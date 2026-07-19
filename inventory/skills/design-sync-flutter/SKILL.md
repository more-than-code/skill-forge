---
name: design-sync-flutter
description: Sync a Flutter app's design system to claude.ai/design (Claude Design) as a spec-style project — ThemeData/ColorScheme/TextTheme extracted into design tokens, widget catalog turned into preview cards and usage docs, plus a design-to-Flutter mapping so exported designs translate back to widgets. The official /design-sync skill is React-only and cannot ingest Flutter at all. Use whenever the user wants their Flutter theme, widgets, or design language available in Claude Design, asks to sync a Flutter design system to claude.ai/design, or wants Claude Design output to match their Flutter app.
---

# Sync a Flutter design system to claude.ai/design

## What this is — and what it honestly is not

Claude Design renders designs live from React code in a browser. Flutter widgets
cannot run there, so **no runtime bundle ever ships from a Flutter repo** — never emit
`_ds_bundle.js` or `.d.ts` files. What ships is a **spec-style design system**, which
Claude Design fully supports:

- **Tokens** — the app's real `ThemeData` (ColorScheme, TextTheme, spacing, radii,
  elevation) as CSS custom properties. Every design gets skinned by them.
- **Preview cards** — one per widget, HTML/CSS recreations built strictly from those
  tokens, fidelity-checked against real Flutter renders when obtainable.
- **Usage docs + a mapping guide** — the design agent learns the widget vocabulary and
  tags its output so designs translate back to Flutter mechanically.

Set the expectation with the user up front: the design agent will produce web designs
*in the app's visual language*, and the mapping guide makes implementing them in
Flutter mechanical — but the pixels in Claude Design come from CSS recreations, not the
Flutter engine. Fidelity is maintained by verification, not by sharing a renderer.

Read `references/ds-layout.md` before emitting or uploading anything — it holds the
exact project layout, the `@dsCard` card marker, the `styles.css` import-closure
invariant, and the full DesignSync upload sequence.

## 0. First sync — set expectations

If `.design-sync-flutter/config.json` has a `projectId`, this is a re-sync (see the
last section). Otherwise tell the user: first-time import into a new Claude Design
project; every card gets built and visually verified, which takes a while on a large
widget set; approvals happen near the start; they can interrupt any time. Confirm
before proceeding. Skill state lives in `.design-sync-flutter/` (`config.json`,
`NOTES.md`, `conventions.md`); never touch `.design-sync/`, which belongs to the
official React skill.

## 1. Pick the target project

Follow "Target project selection" in `references/ds-layout.md`; record the `projectId`
in `.design-sync-flutter/config.json` the moment the target settles.

## 2. Explore the repo

Record findings in `config.json` as you go (paths, exclusions, corrections):

- **Theme source** — `ThemeData` construction: conventionally `lib/theme/`,
  `lib/core/theme/`, or inline in `MaterialApp`. Collect: `ColorScheme` (both
  brightnesses if defined), `TextTheme` (family/size/weight/height per role),
  `ThemeExtension` subclasses (custom tokens live here), spacing/inset constant
  classes, `BorderRadius`/shape constants, elevation use.
- **Fonts** — `pubspec.yaml` `fonts:` (asset paths per weight/style) or `google_fonts`
  usage.
- **Widget catalog** — the *reusable design-system widgets* (`lib/widgets/`,
  `lib/core/widgets/`, a shared `ui`/`design_system` package), not every widget in the
  app. Ambiguous → ask the user which set to sync. Group them the way the repo does
  (buttons, inputs, cards, navigation…) — the picker groups by the `@dsCard group`
  value.
- Note which Material widgets the app uses bare (styled only by theme) — those become
  guidance in the conventions header rather than cards.

Read the Dart source directly — values are almost always literal or const-resolvable.
Only when a value genuinely can't be resolved statically, write a tiny Dart script
(`dart run`) that instantiates the theme and prints the resolved values as JSON.

## 3. Build the output directory

Everything goes into `ds-bundle/` (gitignored), laid out per `references/ds-layout.md`.

### tokens/ and styles.css

One CSS file per concern, values copied from the theme — never invented:

- `tokens/colors.css` — `--color-primary`, `--color-on-primary`, `--color-surface`, …
  mirroring the `ColorScheme` role names (plus `ThemeExtension` colors under their own
  names). Dark scheme → a `.dark` block or `prefers-color-scheme` section.
- `tokens/typography.css` — one custom-property cluster per `TextTheme` role
  (`--text-title-large-size`, `-weight`, `-height`, family), plus `@font-face` rules
  pointing into `fonts/`.
- `tokens/spacing.css`, `tokens/radius.css` — from the repo's constants; if the app has
  no named spacing scale, derive the observed scale from the widgets and say so in
  NOTES.md.

`styles.css` `@import`s all of them and the font-face rules — designs receive only this
import closure, so anything a card or design needs must be reachable from it. Keep the
CSS↔Dart correspondence in `guidelines/token-map.md` (e.g. `--color-primary` ←
`colorScheme.primary`, `--radius-md` ← `AppRadius.md`), uploaded so the agent sees it.

### Preview cards

`components/<group>/<Name>/<Name>.html` per widget, per the card shape in the
reference. Rules that keep recreations honest:

- Style **only** with the token variables — a hardcoded hex or px in a card is a bug,
  because it can silently diverge from the theme.
- Show the widget's real states/variants (enabled, disabled, error, sizes) as the
  Flutter code defines them — check the widget source for its actual conditionals.
- Recreate structure (padding, radius, elevation/shadow, typography roles) from the
  widget's build method, not from memory of what Material looks like.

### <Name>.prompt.md

Per widget: what it is and when it's used, the **Flutter API** (constructor parameters
with types/defaults, from the source), one realistic usage snippet, variants shown in
the card, and the widget's file path. Under a screenful.

### guidelines/

- `token-map.md` — the CSS-variable ↔ Dart mapping table (above).
- `flutter-mapping.md` — how a design maps back to widgets: DS widget name → import
  path + constructor; common HTML patterns → Flutter equivalents (flex row/column →
  `Row`/`Column`, gap → `SizedBox`/spacing token, card pattern → the app's card
  widget); and the handoff rule that generated markup carries
  `data-widget="<Name>"` on any element standing in for a DS widget.

## 4. Verify before upload

Spec-style cards are recreations, so verification is what makes them trustworthy:

1. **Render check** — open every card with Playwright (headless chromium): no console
   errors, stylesheet resolves, body visually non-blank. No Playwright available and
   not installable → the run is unverified; say so and get the user's explicit OK
   before uploading.
2. **Fidelity check against real renders, when obtainable** — best source first:
   existing golden test images (`test/**/goldens/`), then screenshots the user can
   provide, then `flutter run` + screenshot if a device/simulator is available.
   Compare side by side with the card screenshot and fix material differences
   (spacing, radius, weight, color). No reference obtainable → mark the card
   `unverified recreation` in NOTES.md and tell the user which ones.
3. **Vocabulary check** — every token variable, widget name, and file path named in
   the conventions header, prompt files, and guidelines must exist in `ds-bundle/` or
   the repo. Grep, don't trust memory.

## 5. Author the conventions header (README.md)

Inlined into the design agent's system prompt — the highest-leverage artifact here.
Every sentence must satisfy this test: *could the agent act on this without guessing?*
Tersely (2–4k chars):

- **Design language in one paragraph** — density, radius scale, elevation habits, tone.
- **Token vocabulary** — the variables table (real names from `tokens/`); instruct the
  agent to style exclusively with `var(--…)` tokens, never raw values.
- **Component vocabulary** — the card names, with the `data-widget` tagging rule so
  output maps back to Flutter.
- **Where truth lives** — `tokens/`, `guidelines/token-map.md`,
  `guidelines/flutter-mapping.md`, per-component `prompt.md`.
- **Platform framing** — designs will be implemented in Flutter: prefer simple
  flex-based layouts, mobile-first viewports, and the documented components over
  free-form invention.

Write to `.design-sync-flutter/conventions.md`, copy into `ds-bundle/README.md`. If it
already exists from a prior sync, don't rewrite it — re-validate its names against the
fresh build and propose edits for anything that no longer resolves.

## 6. Upload

Run the atomic upload sequence in `references/ds-layout.md` exactly (sentinel content
`{"by":"design-sync-flutter"}`, ≤256 files per call, sentinel re-arm, STOP on stuck
failures, omit `_ds_sync.json` and `_ds_bundle.js`). Then report: project URL, widget
count, which cards are verified vs marked unverified, and offer to commit
`.design-sync-flutter/` — one commit, sync inputs only.

## Translating designs back to Flutter

When the user later brings a Claude Design export (or handoff bundle) from this
project: `guidelines/flutter-mapping.md` + `token-map.md` are the contract. Map
`data-widget` elements to the named widgets, map every `var(--…)` through the token
map to `Theme.of(context)` lookups (never hardcode the resolved values), and flag any
element that maps to no documented widget as new-component work for the user.

## Re-syncs

Read `.design-sync-flutter/config.json` + `NOTES.md`, rebuild `ds-bundle/` fresh,
re-verify cards whose theme or widget source changed (no hash anchor is kept — when in
doubt re-verify all), re-validate the conventions file, then upload with the
reconciliation deletes per the reference. Theme value changed → tokens regenerate from
source, so cards styled only by tokens pick it up automatically; that's why hardcoded
values in cards are bugs. Persist anything the user corrects mid-run into config or
NOTES immediately.
