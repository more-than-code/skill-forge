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
- `scripts/color.mjs`: WCAG 2.2 ratio and APCA Lc for two hex or `rgb()` colours;
  importable or `node scripts/color.mjs '#262624' '#f7f7f5' [text|large-text|ui]` (quote
  the `#` in a shell).

Both CLIs exit 0 on pass, 1 on a WCAG failure and 2 on bad input (unknown token, no
pairs declared, unsupported colour), so a typo never reads as a pass or as a contrast
failure.

Node 18 or later; no dependencies.

## Adopt the tokens in a repo

1. Copy `tokens.json` and `scripts/` into the repo (for example `src/styles/tokens/`).
   Keep the names; swap the values for the product's own (with `brand-palette-roles`
   when starting from brand colours).
2. From that folder, generate the CSS: `node scripts/tokens.mjs css --out tokens.css`
   (`--out` writes only after generation succeeds; a shell `>` would empty the file on
   an error).
3. Run `node scripts/tokens.mjs check` and fix every WCAG failure.
4. Load `tokens.css` before every other stylesheet (how feature code uses tokens is
   `ui-portability-baseline` and `quiet-ui-style-guide`).
5. Add the pre-paint script below to `<head>` so the stored theme and motion setting
   apply before first paint.

`tokens.css` uses `light-dark()` with `color-scheme`, so each value is written once and
there is no second dark block to keep in step. `light-dark()` is Baseline 2024
(Chrome 123, Firefox 120, Safari 17.5). The generator does not emit a fallback for older
browsers; a product that needs one extends `tokens.mjs` to write a
`prefers-color-scheme: dark` block and a `[data-theme="dark"]` block from the same
`tokens.json`, rather than hand-copying dark values.

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
| `--focus` | Keyboard focus indicator colour; geometry is `--focus-width` and `--focus-offset` |
| `--accent`, `--accent-ink`, `--accent-wash` | The one accent as a fill; as text and links; as a tinted background |
| `--on-fill` | Text and icons on `--accent` fills |
| `--series-1` … `--series-6` | Chart categories only, never state |
| `--good`, `--warning`, `--serious`, `--critical` | State marks: dots, icons, bars, borders. Never text colour |
| `--good-wash` … `--critical-wash` | Background of a state badge or banner; its text is `--ink` |
| `--shadow-near`, `--shadow-far` | Colours inside `--shadow` and `--shadow-sm` |

Value rules the preset meets, and any replacement values must meet:

- **No pure white or black.** Light surface `#F7F7F5` with ink `#262624` (about 14:1);
  dark surface `#151517` with ink `#E4E3DF` (about 14:1).
- **One accent.** A second brand colour goes into a series slot, not a second accent.
- **Text is 4.5:1 on every surface it can sit on, in both themes,** captions included
  (WCAG 1.4.3): `--ink`, `--ink-2` and `--ink-3` on every surface and on `--accent-wash`;
  `--ink` and `--ink-2` on the status washes; `--accent-ink` on `--bg`, `--surface` and
  `--accent-wash`; `--on-fill` on `--accent`.
- **Graphics that carry meaning are 3:1** against adjacent colours (WCAG 1.4.11):
  `--focus`, `--line-strong`, `--accent`, the status colours and every series colour,
  each on all five surfaces (`--bg`, `--plane`, `--surface` … `--surface-3`); status
  colours also on their own wash. The focus outline is drawn
  `--focus-offset` outside the element, so it sits on the surface, not on an accent fill.
- **Series colours are checked against the background only,** not for telling them
  apart from each other or under colour-vision deficiency; label series directly or
  check that separately.
- **Status colours carry no text.** A badge is `-wash` background, `--ink` text and a
  status-coloured dot or icon, so state never depends on colour-on-colour text.
- **Disabled text is exempt** from contrast minimums (WCAG 1.4.3). The preset has no
  separate disabled fill or border: `--ink-disabled` on the control's normal surface.

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
- Focus: `--focus-width` (2px), `--focus-offset` (2px).
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
  // Pre-paint: inline in <head>, before any stylesheet. Under a strict CSP, allow it by hash.
  try {
    const root = document.documentElement;
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') {
      root.dataset.theme = t;
      const meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) meta.content = t;
    }
    const m = localStorage.getItem('motion');
    if (m === 'on' || m === 'off') root.dataset.motion = m;
  } catch {}
</script>
```

```js
// mode: 'system' | 'light' | 'dark'; anything else (a stale or foreign stored value) is 'system'.
function applyTheme(mode) {
  if (mode !== 'light' && mode !== 'dark') mode = 'system';
  const root = document.documentElement;
  root.classList.add('theme-switching'); // tokens.css disables transitions for this frame
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = mode === 'system' ? 'light dark' : mode;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}
function setTheme(mode) {
  applyTheme(mode);
  try { mode === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', mode); } catch {}
}
// Keep other tabs in step. A null key means localStorage.clear(): back to the defaults.
addEventListener('storage', (e) => {
  if (e.key === 'theme' || e.key === null) applyTheme(e.key === null ? 'system' : e.newValue);
  if (e.key === 'motion' || e.key === null) {
    const m = e.key === null ? null : e.newValue;
    if (m === 'on' || m === 'off') document.documentElement.dataset.motion = m;
    else delete document.documentElement.dataset.motion;
  }
});
```

The control offers all three states (a segmented control or menu: System, Light, Dark),
not a two-state toggle that loses "follow system".

## Motion

`tokens.css` honours `prefers-reduced-motion: reduce` (durations to 0, animations cut to
1ms and one iteration, smooth scrolling and view transitions off) unless the user set
`data-motion="on"` on `<html>`; `data-motion="off"` applies the same reduction
regardless of the OS. The one-iteration cut also stops indeterminate spinners, so a
busy state needs a non-animated cue too. The pre-paint script restores the setting;
the control sets it:

```js
// value: 'system' | 'on' | 'off'
function setMotion(value) {
  const root = document.documentElement;
  if (value === 'on' || value === 'off') root.dataset.motion = value;
  else delete root.dataset.motion;
  try { value === 'on' || value === 'off' ? localStorage.setItem('motion', value) : localStorage.removeItem('motion'); } catch {}
}
```

## Forced colours (Windows high contrast)

Forced colours drop `box-shadow`, so `--edge`, `--shadow` and `--ring` disappear and
custom colours are replaced by system colours. `tokens.css` maps `--focus` and
`--line-strong` to system colours under `@media (forced-colors: active)` and leaves
fills to the browser (in Chromium, mapping `--accent`/`--on-fill` to
`Highlight`/`HighlightText` hid button labels behind the text backplate). Components that draw an outline or a focus indicator
with `box-shadow` (including `--edge`) also set `outline: 1px solid transparent`, which
is invisible normally and turns into a visible system-coloured outline in forced
colours.

## Add or change a token

1. Edit `tokens.json`, never `tokens.css`. Name it by role; give both a light and a dark
   value; write a `$description` saying what it is for.
2. If it is text or a meaningful graphic, add its pairs to the contrast `pairs` list
   (`text`, `large-text` or `ui`) against every background it can sit on.
3. Regenerate: `node scripts/tokens.mjs css --out tokens.css`.
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

A quiet, neutral light and dark theme with px type sizes for dense app UI (switch the
`font-size` group to `rem` if the product should follow the user's browser font size).
The checker reports 0 WCAG failures on it and some APCA advisories in dark mode
(`--ink-3` captions are about Lc 52, `--ink-2` about Lc 59): acceptable at WCAG AA, worth
revisiting if the product adopts APCA as its target.
