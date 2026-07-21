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

- Tailwind 4: `npx @tailwindcss/cli -i <entry.css> -o ds-bundle/_ds_bundle.css` (or take
  the CSS asset from a `vite build`). The entry's `@source` coverage must include every
  component dir being synced, so their utilities are all generated.
- Tailwind 3: the CLI equivalent with the repo's config.
- Component-scoped Svelte styles: a `vite build` of the library emits them into the CSS
  asset; use that.

**Fonts must be copied and their URLs rewritten** — this bites every time. A CSS
`@import "@fontsource-variable/inter"` (or any npm font) inlines `@font-face` rules
whose `src: url(./files/xxx.woff2)` points into `node_modules`, which does not exist on
claude.ai/design. Copy the *referenced* woff2 files into `ds-bundle/fonts/` and rewrite
the paths, e.g.:

```sh
# copy only the subsets the built CSS actually references
for f in $(grep -oE '[a-z0-9-]+\.woff2' ds-bundle/_ds_bundle.css | sort -u); do
  find node_modules/.pnpm -path "*/@fontsource-variable/*/files/$f" -exec cp {} ds-bundle/fonts/ \; ; done
sed -i '' 's#url(\./files/#url(fonts/#g' ds-bundle/_ds_bundle.css   # match your source's url() prefix
```

Then confirm `grep -c 'url(fonts/' ds-bundle/_ds_bundle.css` matches the font count and
`grep -c 'url(./files/' ` is 0.

Emit `ds-bundle/styles.css` as the root that `@import`s `_ds_bundle.css` (which already
carries the inlined `:root`/`.dark` tokens and `@font-face` rules). Designs receive only
this import closure — verify every token and class you'll later document actually
appears in it.

**Known limit — the delivered CSS is a *closed set*, record it in NOTES.md and shape the
conventions header around it.** A Tailwind build contains only the utility classes that
appear in the scanned source — which is the *whole app's* union (so common
`flex`/`grid`/`p-*`/`gap-*`/`w-full` are present), but NOT arbitrary bracket values
(`p-[13px]`, `w-[420px]`) and NOT utilities the app never uses (`m-4`, `max-w-md`,
`bg-card`, `bg-accent` — even when the underlying `--card`/`--accent` *variables* are
defined). A design agent composing new layouts WILL reach for classes outside this set
and get silently unstyled output. Two mitigations, apply both:
  1. In the conventions header, enumerate only *verified* utilities (grep each against
     the built CSS — see §4/§5), and tell the agent that any token beyond that list is
     available as `var(--token)` (always defined) via inline `style`, not as a `bg-*`
     utility.
  2. If the design surface needs to be broad, widen the build: add a Tailwind
     `@source inline(...)`/safelist of the common utility families to the CSS entry
     before building, so they're baked in. Note what you safelisted in NOTES.md.

### tokens/

One file per concern (`colors.css`, `typography.css`, `spacing.css`, `radius.css`) as
CSS custom properties on `:root` (plus the dark-theme block if the repo has one),
copied from the repo's real values — never invented. `@import` them from `styles.css`.

### Preview cards — server-render the real components

For each component, generate `components/<group>/<Name>/<Name>.html` by rendering the
actual compiled component. **Use a real `vite build --ssr`, not middleware
`ssrLoadModule`** — see the SSR recipe below; it's the part most likely to fight you.

1. Author an SSR entry (`.ts`) that imports the components and, for a `props` matrix per
   component, calls `render(Comp, { props })` from `svelte/server`, joining the returned
   `body` strings. For components that render `{@render children()}`, pass children via
   `createRawSnippet(() => ({ render: () => '<span>…</span>' }))`.
2. Bundle it with `vite build --ssr` using a **standalone** config — the bare
   `@sveltejs/vite-plugin-svelte` (NOT the full `sveltekit()` plugin), a `$lib` alias to
   `src/lib`, and **node_modules externalized** (`ssr: { noExternal: [] }`,
   `optimizeDeps: { noDiscovery: true }`). Then run the built `.mjs` with node to emit
   the bodies. Two hard-won reasons for this exact shape:
   - Middleware-mode `ssrLoadModule` compiled components in *client* mode on a
     Vite 8 + rolldown + Svelte 5 stack, so `render()` threw
     "Component.render is no longer valid" — a full `--ssr` build compiles in server mode.
   - `ssr.noExternal: true` makes Vite try to re-compile *precompiled* dependency
     `.svelte` files (e.g. `@lucide/svelte` icons) and dies on
     `'new.target' can only be used in functions` — externalize deps so only your own
     components compile; bits-ui / lucide load as their shipped output.
3. Wrap each `body` in the card shape from `references/ds-layout.md` (first line
   `<!-- @dsCard group="…" -->`, stylesheet link to `../../../styles.css`), showing
   several variants/states per card where the API has them.
4. Interactive/composed components (dialogs, popovers, command menus, input groups)
   built from multi-part bits-ui primitives don't SSR into a useful closed state and
   their `Root`/`Trigger`/`Content` split doesn't render standalone. Author these
   spec-style: a hand-built card using the components' *real* class strings (read them
   from the `.svelte` source), showing the open/expanded state. Mark them in NOTES.md as
   spec-authored (not SSR-verified) so re-syncs know.

If a leaf component won't SSR (browser-only APIs at module scope), fall back to the same
spec-style card and mark it unverified-by-render in NOTES.md.

Keep the harness under `.design-sync-svelte/render/` — it's reusable across re-syncs.

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
   console errors, a failed `.css` request, or a visually blank body (probe
   `getComputedStyle` — e.g. confirm the body font resolved to the DS font and height
   > 0). Playwright is usually NOT a repo dep: install it in the session scratchpad
   (`npm i playwright && npx playwright install chromium` in a temp dir) and import it
   by absolute path. It ships CommonJS, so from an `.mjs` harness use
   `import pw from '<abs>/playwright/index.js'; const { chromium } = pw;` (a named
   `import { chromium }` fails). If installing is impossible, the run is unverified —
   say so and get the user's explicit OK before uploading anything.
2. **Visual grade** — screenshot each card and look at it: does it show the component
   styled as the real app shows it (compare against the repo's Storybook/routes when
   available)? Broken cards get fixed or dropped to a minimal honest card — never
   uploaded pretty-but-wrong.
3. **Vocabulary check** — every utility class, token, and component name in the
   conventions header and prompt files must grep-verify against the built
   `ds-bundle/_ds_bundle.css` (the closed set) and the emitted `components/<group>/<Name>/`
   dirs. This gate reliably catches drift — e.g. `bg-card`/`bg-accent` enumerated but
   never baked. A name that doesn't resolve is worse than no guidance: fix it, drop it,
   or (for a defined token with no utility) rewrite it as `var(--token)`. When grepping, remember Tailwind **escapes `/` and `.` in selectors** (`bg-muted/50`→`.bg-muted\/50`, `gap-2.5`→`.gap-2\.5`), so a naive `grep -F ".bg-muted/50"` reports a false miss — match the escaped form or check with a substring test that accounts for the backslash.

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
