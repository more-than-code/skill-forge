---
name: design-sync-svelte
description: Sync a Svelte 5 / SvelteKit design system to claude.ai/design (Claude Design). The official /design-sync skill is React-only and fails on Svelte repos; this skill produces the same claude.ai/design project layout from Svelte sources — design tokens, server-rendered component preview cards, usage docs, and an optional custom-elements runtime bundle — and uploads it with the DesignSync tool. Use whenever the user wants their Svelte, SvelteKit, shadcn-svelte, or bits-ui components/design system in Claude Design, mentions /design-sync failing on a Svelte repo, or asks to sync Svelte UI to claude.ai/design.
---

# Sync a Svelte 5 design system to claude.ai/design

## What this is

Claude Design (claude.ai/design) renders designs live from real **React** code, so the
official `/design-sync` converter cannot ship Svelte components as the runtime. But the
official skill is explicit that the **upload format is the contract** — any toolchain
may produce it, as long as verification isn't skipped. This skill produces that layout
from a Svelte 5 repo. Read `references/ds-layout.md` before emitting or uploading
anything — it holds the exact layout, the `@dsCard` marker, the `styles.css` import
closure invariant, and the full DesignSync upload sequence.

What ships, honestly:

- **Tokens, fonts, and component CSS** — real, extracted from the repo. Designs are
  styled by them directly.
- **Preview cards** — real output: each card's markup comes from server-rendering the
  actual compiled component (`svelte/server`), styled by the repo's real built CSS.
  Not a hand-drawn lookalike.
- **Usage docs + conventions** — teach the design agent this system's visual language
  and vocabulary so its (React) output is on-brand and maps back to the Svelte API.
- **Runtime bundle — optional, off by default.** A custom-elements bundle can ship the
  real compiled Svelte components into the React runtime, but slot/children interop is
  lossy for composition-heavy components. Offer it only when the user wants it and the
  components suit it; see `references/custom-elements.md`. Never emit `.d.ts` files or
  `_ds_bundle.js` unless that path is taken — an API contract for components that
  aren't in the runtime makes the agent write imports that fail.

State this tradeoff to the user up front: without the bundle, the design agent builds
with generic React components *skinned by the real tokens, CSS, and conventions*; the
previews and docs keep it on-brand, and the conventions file maps its output back to
Svelte names. For utility-class systems (Tailwind + shadcn-svelte/bits-ui) this
spec-style path is high-value, because the design agent natively writes utility classes
— the conventions header does most of the work.

## 0. First sync — set expectations

If `.design-sync-svelte/config.json` has a `projectId`, this is a re-sync (see the
re-sync section). Otherwise tell the user: this is a first-time import into a **new
Claude Design project**; it iterates on builds and visually verifies every preview
card, which can take a while on a large component set; approvals happen near the
start; they can interrupt any time. Confirm before proceeding.

**Never write into `.design-sync/`** — that directory belongs to the official React
skill, and a config there with a `projectId` would make a later `/design-sync` run
treat this repo as a React re-sync. This skill's state lives in `.design-sync-svelte/`
(`config.json`, `NOTES.md`, `conventions.md`), committed at the end.

## 1. Pick the target project

Follow "Target project selection" in `references/ds-layout.md`. Record the `projectId`
in `.design-sync-svelte/config.json` the moment the target settles.

## 2. Explore the repo

Install with the repo's own package manager (lockfile decides). Then map, and record
findings in `config.json` as you go so re-syncs skip rediscovery:

- **Components** — the design system's reusable set, not every `.svelte` file. Look in
  `src/lib/components/` (SvelteKit library convention, and where shadcn-svelte
  generates into), `src/lib/index.ts` exports, or a `packages/ui` workspace. Multiple
  candidates → ask the user which set is the design system. Record as
  `componentDirs` + optional `exclude`.
- **Tokens** — Tailwind 4: `@theme` blocks in the entry CSS (tokens are CSS custom
  properties already). Tailwind 3: `tailwind.config.*` theme. Plain Svelte: global CSS
  custom properties. shadcn-svelte: the `--background`/`--primary`/`--radius` variable
  set in the app CSS, including the `.dark` block.
- **Fonts** — `@font-face` in app CSS, `static/fonts/`, or fontsource imports.
- **Groups** — group components the way the repo does (`ui/`, `forms/`, directory
  names); the picker groups cards by the `@dsCard group` value.

## 3. Build the output directory

Everything goes into `ds-bundle/` (gitignored), laid out per `references/ds-layout.md`.

### styles.css — build the real CSS

Build the repo's actual stylesheet — never hand-write component CSS:

- Tailwind 4: `npx @tailwindcss/cli -i <entry.css> -o ds-bundle/_app.css` (or take the
  CSS asset from a `vite build`). The entry's `@source` coverage must include every
  component dir being synced, so their utilities are all generated.
- Tailwind 3: the CLI equivalent with the repo's config.
- Component-scoped Svelte styles: a `vite build` of the library emits them into the CSS
  asset; use that.

Emit `ds-bundle/styles.css` as the root that `@import`s `tokens/*.css`, font-face
rules, and `_app.css`. Designs receive only this import closure — verify every token
and class you'll later document actually appears in it.

**Known limit to record in NOTES.md and the conventions header**: a utility-first build
contains only the classes the repo uses. The design agent may write valid Tailwind
utilities that aren't in the build and silently get no styling. Mitigate in the
conventions header: tell the agent to prefer the token variables (`var(--…)`) and the
enumerated class vocabulary — both verified present.

### tokens/

One file per concern (`colors.css`, `typography.css`, `spacing.css`, `radius.css`) as
CSS custom properties on `:root` (plus the dark-theme block if the repo has one),
copied from the repo's real values — never invented. `@import` them from `styles.css`.

### Preview cards — server-render the real components

For each component, generate `components/<group>/<Name>/<Name>.html` by rendering the
actual compiled component:

1. Write a small render script per batch (a `.ts`/`.js` run with `vite-node`, `tsx`, or
   a tiny Vite SSR build — whatever the repo already supports) that imports the
   component and calls `render()` from `svelte/server` with representative props;
   for slot/snippet children, use `createRawSnippet` to pass realistic content.
2. Wrap the returned HTML in the card shape from `references/ds-layout.md` (first line
   `<!-- @dsCard group="…" -->`, stylesheet link to `../../../styles.css`), showing
   several variants/states per card where the API has them.
3. Interactive-only components (dialogs, dropdowns, tooltips) don't SSR into a useful
   closed state — render their open/expanded state by composing what `render()` gives,
   or set the relevant open prop.

If a component won't SSR (browser-only APIs at module scope), fall back to a
hand-authored card using the component's real classes — and mark it in NOTES.md as
unverified-by-render so re-syncs know.

### <Name>.prompt.md

Per component: what it is, the **Svelte API** (props with types/defaults from the
source, slots/snippets, key events), one realistic usage snippet, and the visual
variants shown in the card. The design agent reads this to stay on-brand and to name
things correctly; engineers read it when translating designs back. Keep it under a
screenful.

### README.md + guidelines/

`guidelines/svelte-mapping.md`: how a design maps back to code — component name →
import path, card variant → prop values, and the rule that the agent's generic markup
should carry `data-component="<Name>"` on elements standing in for a DS component so
handoff is mechanical.

## 4. Verify before upload

Off-script generation is legitimate; off-script verification is not. Gate every card:

1. **Render check** — open each card with Playwright (headless chromium): fail on
   console errors, missing stylesheet, or a visually blank body. If Playwright isn't
   available, install it in a scratch dir; if that's impossible, the run is
   unverified — say so and get the user's explicit OK before uploading anything.
2. **Visual grade** — screenshot each card and look at it: does it show the component
   styled as the real app shows it (compare against the repo's Storybook/routes when
   available)? Broken cards get fixed or dropped to a minimal honest card — never
   uploaded pretty-but-wrong.
3. **Vocabulary check** — every class, token, and component name in the conventions
   header and prompt files must grep-verify against `ds-bundle/styles.css` and the
   emitted component dirs. A name that doesn't resolve is worse than no guidance.

## 5. Author the conventions header (README.md)

This file is inlined into the design agent's system prompt — it's the highest-leverage
artifact of a spec-style sync. Every sentence must satisfy this test: *could the agent
act on this without guessing?* Cover, tersely (2–4k chars):

- **Setup/wrapping** the agent's output needs (theme class on a root element, dark-mode
  mechanism).
- **The styling idiom with its actual vocabulary** — for a Tailwind/shadcn system: the
  token variables table and the verified utility families; for scoped-CSS systems: the
  `var(--…)` pattern with real names. Never a generic idiom the repo doesn't have.
- **Where truth lives** — name `styles.css`, `tokens/`, and the per-component
  `prompt.md` files so the agent reads sources instead of guessing.
- **One idiomatic build snippet** adapted from a verified card.
- **The mapping rule** — output is React/HTML but the system of record is Svelte:
  reference `guidelines/svelte-mapping.md` and the `data-component` convention.

Write it to `.design-sync-svelte/conventions.md`, copy into `ds-bundle/README.md`. If
the file already exists from a prior sync, don't rewrite it — re-validate its names
against the fresh build and propose edits for anything that no longer resolves.

## 6. Upload

Run the atomic upload sequence in `references/ds-layout.md` exactly (sentinel with
`{"by":"design-sync-svelte"}`, ≤256 files per call, sentinel re-arm, STOP on stuck
failures, omit `_ds_sync.json`). Then report: project URL, component count, cards
verified, known limits. Offer to commit `.design-sync-svelte/` (config, NOTES,
conventions) — one commit, sync inputs only.

## Re-syncs

Read `.design-sync-svelte/config.json` + `NOTES.md`, rebuild `ds-bundle/` fresh,
re-verify cards whose component source or CSS changed (no hash anchor is kept — when
in doubt, re-verify all; the render check is cheap), re-validate the conventions file,
then upload with reconciliation deletes per the reference. Persist anything the user
corrects mid-run into config or NOTES immediately.
