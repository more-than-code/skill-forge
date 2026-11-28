---
name: ui-design-tokens
description: >
  Every design token value for a web app UI in one place: colour roles for light and
  dark, type scale, spacing, radius, motion and shadow, as a W3C DTCG tokens.json with a
  generated tokens.css (light-dark(), no duplicated dark block), a three-state theme
  switch, reduced-motion and forced-colours handling, and a dependency-free contrast
  checker (WCAG 2.2 gate, APCA advisory). Ships a quiet, brand-neutral default preset to
  swap for your own. Activate when defining or changing token values, adding dark mode or
  a theme switch, adding a token, or checking a palette's contrast.
---

# UI Design Tokens

This skill owns token **values** and the mechanism that delivers them. It does not say
when to use which token.

| Need | Where |
|---|---|
| Token names, values, light/dark, theme switch, contrast check | this skill |
| Rules for using tokens (which size for titles, when a shadow is allowed, review checklist) | `quiet-ui-style-guide` |
| Deriving a palette from brand seed colours | `brand-palette-roles` (writes into the role names below) |
| Colour and contrast rules for a marketing site | `landing-page` |
| Token discipline in feature code, theme portability | `ui-portability-baseline` |
| Component architecture, state, framework specifics | `frontend-engineering` |

## Files

- `tokens.json`: the source of truth, in the W3C Design Tokens (DTCG 2025.10) format.
  A colour's `$value` is its light value; its dark value is in
  `$extensions["com.skillforgecloud.modes"].dark`. Group `$extensions` give each
  group's CSS prefix. The root `$extensions["com.skillforgecloud.contrast"].pairs`
  lists the foreground/background pairs the checker tests.
- `tokens.css`: generated from `tokens.json`. Never edit it by hand.
- `scripts/tokens.mjs`: `css` prints `tokens.css`; `check` tests every declared pair in
  both modes.
- `scripts/color.mjs`: WCAG 2.2 ratio and APCA Lc for any two colours; importable or
  `node scripts/color.mjs <fg> <bg> [text|large-text|ui]`.

Node 18 or later; no dependencies.

## Adopt the tokens in a repo

1. Copy `tokens.json`, `scripts/` and the generated `tokens.css` into the repo (for
   example `src/styles/tokens/`). Keep the names; swap the values for the product's own
   (with `brand-palette-roles` when starting from brand colours).
2. Load `tokens.css` before every other stylesheet. Feature CSS uses `var(--…)` only:
   no hex values, no pixel sizes that a token covers.
3. Add the pre-paint script below to `<head>` so the stored theme applies before first
   paint.
4. Run `node scripts/tokens.mjs check` and fix every WCAG failure before shipping.

`tokens.css` uses `light-dark()` with `color-scheme`, so each value is written once and
there is no second dark block to keep in step. `light-dark()` is Baseline 2024
(Chrome 123, Firefox 120, Safari 17.5). A product that must support older browsers
generates a fallback from the same `tokens.json` (a `prefers-color-scheme: dark` block
plus a `[data-theme="dark"]` block, both written by the generator, never by hand).

## Colour roles

Names describe the role, never the hue, so a re-theme changes values only.

| Role | Use |
|---|---|
| `--bg` | Page background behind every plane and card |
| `--plane` | Large app regions (sidebar, rail), one step above `--bg` |
| `--surface`, `--surface-2`, `--surface-3` | Cards and inputs; nested or hovered; pressed, selected or deepest |
| `--ink`, `--ink-2`, `--ink-3` | Primary text; secondary (labels, metadata); captions and placeholders |
| `--ink-disabled` | Text of disabled controls only |
| `--line`, `--line-2` | Decorative dividers; never the only cue that something is a control |
| `--line-strong` | A control's border when the border is its only visual cue |
| `--edge` (colour `--edge-color`) | 1px inset hairline (`box-shadow`) that outlines a card without a border |
| `--ring` | Soft decorative halo; never the focus indicator |
| `--focus` | Keyboard focus indicator |
| `--accent`, `--accent-ink`, `--accent-wash` | The one accent as a fill; as text and links; as a tinted background |
| `--on-fill` | Text and icons on `--accent` fills |
| `--series-1` … `--series-6` | Chart categories only, never state |
| `--good`, `--warning`, `--serious`, `--critical` | State marks: dots, icons, bars, borders. Never text colour |
| `--good-wash` … `--critical-wash` | Background of a state badge or banner; its text is `--ink` |
| `--shadow-near`, `--shadow-far` | Colours inside `--shadow` and `--shadow-sm` |

Value rules the preset meets, and any replacement values must meet:

- **No pure white or black.** Light surface `#F7F7F5` with ink `#262624` (about 14:1);
  dark surface `#151517` with ink `#E4E3DF` (about 13:1).
- **One accent.** A second brand colour goes into a series slot, not a second accent.
- **Text is 4.5:1 on every surface it can sit on, in both themes,** captions included
  (WCAG 1.4.3). `--accent-ink` meets it on `--bg`, `--surface` and `--accent-wash`;
  `--on-fill` on `--accent`.
- **Graphics that carry meaning are 3:1** against adjacent colours (WCAG 1.4.11):
  `--focus`, `--line-strong`, `--accent`, the status colours (also on their own wash) and
  every series colour.
- **Status colours carry no text.** A badge is `-wash` background, `--ink` text and a
  status-coloured dot or icon, so state never depends on colour-on-colour text.
- **Disabled text is exempt** from contrast minimums (WCAG 1.4.3), so it must not be the
  only signal: pair it with the disabled attribute and a non-colour cue.

## Other scales

Values are in `tokens.json`; the CSS names are:

- Type: `--font-sans`, `--font-mono`; sizes `--fs-xs` … `--fs-5xl` (`--fs-md` is body);
  line heights `--lh-tight`, `--lh-snug`, `--lh-body` (Latin paragraphs), `--lh-cjk`
  (CJK paragraphs); weights `--fw-light`, `--fw-regular`, `--fw-bold`.
  The font stack starts with two `local()` aliases (`App Sans`, `App Sans CJK`) that map
  each weight token to a real installed face (Segoe UI; Microsoft YaHei or PingFang SC),
  then system fonts, then Noto Sans / Noto Sans SC for Linux and Android, so no weight is
  synthesised. Rename the aliases freely; keep three weights mapped to three faces.
- Spacing: `--space-1` … `--space-8` on a 4px base (4, 8, 12, 16, 24, 32, 48, 64).
- Radius: `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`, `--r-pill`.
- Motion: `--t-fast` (120ms), `--t-med` (220ms), `--t-slow` (320ms); `--ease-out`,
  `--ease-in-out`.
- Shadow: `--shadow`, `--shadow-sm`, `--edge`.
- Breakpoints: 640, 960, 1280px (`breakpoint.*` in `tokens.json`). Media queries cannot
  read custom properties, so these are literal values in page-level CSS; components that
  a host may embed use container queries instead (see `ui-portability-baseline`).

## Theme switch: system, light, dark

No `data-theme` on `<html>` follows the system; `data-theme="light"` or `"dark"` forces a
mode through `color-scheme`, which `light-dark()` follows. Keep the `color-scheme` meta
tag in step so the browser's own UI (scrollbars, form controls) matches before CSS
loads.

```html
<meta name="color-scheme" content="light dark">
<script>
  // Pre-paint: inline in <head>, before any stylesheet.
  try {
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.dataset.theme = t;
      document.querySelector('meta[name="color-scheme"]').content = t;
    }
  } catch {}
</script>
```

```js
// mode: 'system' | 'light' | 'dark'
function applyTheme(mode) {
  const root = document.documentElement;
  root.classList.add('theme-switching'); // tokens.css disables transitions for this frame
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  document.querySelector('meta[name="color-scheme"]').content =
    mode === 'system' ? 'light dark' : mode;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}
function setTheme(mode) {
  applyTheme(mode);
  try { mode === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', mode); } catch {}
}
// Keep other tabs in step.
addEventListener('storage', (e) => { if (e.key === 'theme') applyTheme(e.newValue ?? 'system'); });
```

The control offers all three states (a segmented control or menu: System, Light, Dark),
not a two-state toggle that loses "follow system".

## Motion

- Durations and curves come from the tokens; no literal `ms` or `cubic-bezier()` in
  feature CSS.
- `tokens.css` honours `prefers-reduced-motion: reduce` (durations to 0, animations cut
  to 1ms, view transitions off) unless the user set `data-motion="on"` on `<html>`;
  `data-motion="off"` applies the same reduction regardless of the OS. Offer the user
  setting next to the theme switch, persisted the same way.

## Forced colours (Windows high contrast)

Forced colours drop `box-shadow`, so `--edge`, `--shadow` and `--ring` disappear and
custom colours are replaced by system colours. `tokens.css` maps `--focus` and
`--line-strong` to system colours under `@media (forced-colors: active)` and leaves
fills to the browser (mapping `--accent`/`--on-fill` to `Highlight`/`HighlightText`
hides button labels behind the browser's text backplate). Components that draw an outline or a focus indicator
with `box-shadow` (including `--edge`) also set `outline: 1px solid transparent`, which
is invisible normally and turns into a visible system-coloured outline in forced
colours.

## Add or change a token

1. Edit `tokens.json`, never `tokens.css`. Name it by role; give both a light and a dark
   value; write a `$description` saying what it is for.
2. If it is text or a meaningful graphic, add its pairs to the contrast `pairs` list
   (`text`, `large-text` or `ui`) against every background it can sit on.
3. Regenerate: `node scripts/tokens.mjs css > tokens.css`.
4. Check: `node scripts/tokens.mjs check` (add `--json` for machine output). Exit 1 means
   a WCAG failure: fix the value, never drop the pair. APCA results below the advisory
   level (`|Lc|` 60 text, 45 large text, 30 UI) are reported, not blocking; mention them
   in the PR.
5. Remove a token only after no CSS uses it; a rename keeps the old name as an alias
   (`"$value": "{color.new-name}"`) for one release.

## Verify

- `node scripts/tokens.mjs check` passes with 0 WCAG failures.
- `tokens.css` matches `node scripts/tokens.mjs css` output (a stale file is a bug).
- Render the changed UI with the system in light and in dark, with each forced
  `data-theme`, with reduced motion, and with forced colours, for example in Playwright:
  `page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce', forcedColors: 'active' })`.
- Tab through the changed screen: the focus indicator is visible on every surface.

## The default preset

The preset was harvested from a production app's quiet, neutral design system and then
corrected where it failed the checks above: darker light-mode `--ink-3`, `--accent`,
status and series colours to reach 4.5:1 and 3:1; a real `--focus` token (the source's
halo was about 1.2:1); `--line-strong` for controls; `-wash` backgrounds for all four
states; one shadow geometry for both themes. With the preset as shipped, the checker
reports 0 WCAG failures and a few APCA advisories in dark mode (`--ink-3` captions are
about Lc 52): acceptable at WCAG AA, worth revisiting if the product adopts APCA as its
target.
