---
name: quiet-ui-style-guide
description: >
  Usage rules for a dense, calm work-tool interface ("quiet UI", 安静的页面: greyscale
  first, hairlines, little motion): which type size, weight and radius to use where, at
  most two nested boxes, motion only on page change, one primary action per page,
  component states, Chinese UI text rules, and a style checklist to run on a diff or a
  screenshot. All values come from `ui-design-tokens`. Activate when designing, building
  or reviewing a page or component of an app, console or dashboard in this style. Not for
  public landing or marketing pages (`landing-page`).
---

# Quiet UI Style Guide

Rules for a work tool people look at all day: dense, calm, greyscale first, with colour
and motion kept for the few things that need attention.

This skill holds **only the rules for using tokens**. Every value (type sizes, line
heights, font stacks, weights, spacing steps, radii, colours and their contrast, durations,
easing, shadows, breakpoints) lives in the `ui-design-tokens` skill, and the token names
below are its names. Load it alongside this one. Where a repository has its own design doc
or token file, its values win; these rules still apply.

The **default preset** is the set of values `ui-design-tokens` ships plus the layout
facts in section 4. A product may change the values; it keeps the rules.

Related skills, not repeated here:

- `ui-portability-baseline`: shared primitives, semantic tokens, theme coverage, embedding
  in a host. Its rules apply too.
- `landing-page`: public marketing pages. A landing page is not a work tool; this skill
  does not govern it.
- `frontend-engineering`: architecture, state, accessibility and performance review.
- `review-checklist`: how a review runs and is graded. The checklist at the end of this
  skill is a set of project items for such a review, not a separate reviewer lens.

## 1. Type (文字)

- **Sizes only from the `--fs-*` scale.** No raw `px` font sizes in feature code.
  - `--fs-xs`: captions, timestamps, counts. The smallest size for body copy, labels and
    captions; only chart axis labels, avatar initials and count badges may go below it,
    with a comment on the off-scale value.
    This is a house rule (WCAG sets no minimum size); text-zoom rules below still apply.
  - `--fs-sm`: secondary info, labels, table headers.
  - `--fs-md`: body, forms, list rows (the default).
  - `--fs-lg`: card and section titles.
  - `--fs-xl`: dialog and work-item titles, and numbers shown inline in a card or dialog.
  - `--fs-2xl`: page titles. `--fs-3xl`: cover pages and the big number of a KPI card.
  - `--fs-4xl` and `--fs-5xl` (display): export covers and a home-page greeting only. A
    fluid hero size (`clamp()`) is allowed only there, and it falls back to `--fs-3xl` on
    phones.
- **Three weights, all real faces.** Use only the three `--fw-*` tokens: `--fw-bold` for
  page and card titles and for each row's own item name (in a table, only the first column
  is bold); `--fw-regular` for everything else; `--fw-light` only for long subtitles at
  `--fs-lg` or larger. Every weight maps to a face that exists, so the browser never fakes
  an in-between or bold weight. Do not use the light weight for small text: thin CJK
  strokes break up at small sizes.
- **Fonts never depend on `local()` alone.** Aliases that map system fonts (Segoe UI,
  Microsoft YaHei 微软雅黑, PingFang 苹方) to the three weight ranges work only where those
  fonts are installed; Linux and Android fall back to whatever is there. Use the font stack
  in `ui-design-tokens`, which ends with a web-font fallback (Latin and CJK) and a generic
  family. Load web fonts with `font-display: swap`, split CJK fonts by `unicode-range` so a
  page downloads only the subsets it uses, and match the fallback's metrics
  (`size-adjust`) so the swap does not shift the layout.
- **Line height from the `--lh-*` tokens**: `--lh-tight` for headings and big numbers,
  `--lh-snug` for labels, list rows and table cells, `--lh-body` for running text. Chinese
  paragraphs need more room than Latin text: use the CJK line-height token where
  `ui-design-tokens` ships one, otherwise never less than `--lh-body`.
- **Survive user text settings.** Sizes resolve to `rem` so text zoom works; layouts
  survive 200% zoom (WCAG 1.4.4), reflow at 320 CSS px without horizontal scrolling
  (1.4.10), and the text-spacing override of 1.4.12 (line height 1.5, paragraph spacing 2x,
  letter spacing 0.12em, word spacing 0.16em) without clipping or overlap.
- **Text colour from the ink tokens only**: `--ink` for text, `--ink-2` for secondary,
  `--ink-3` for the weakest captions, each only on the surfaces `ui-design-tokens`
  documents as passing 4.5:1 (WCAG 1.4.3); never use a lighter grey, a series colour or a raw hex
  for text. No pure white or pure black text or surfaces (不用纯白和纯黑); text on a
  coloured fill uses `--on-fill`.

## 2. Radius (圆角)

- **Three everyday steps:** containers (cards, panels, dialogs) `--r-lg`; controls
  (buttons, inputs, select boxes, list rows, small cards inside a panel) `--r-md`; tags,
  chips and swatches `--r-sm`. `--r-xl` for covers and large blocks only.
- **Inner is one step smaller than outer**: panel `--r-lg`, its controls `--r-md`, tags
  inside them `--r-sm`. A group of option buttons is itself a control (`--r-md`) and its
  buttons are `--r-sm`.
- **Pill (`--r-pill`) only for thin bars** (progress bars) and count badges. Buttons and
  tags are never pills. Circles (`50%`) only for avatars and icon-only round buttons.
- **Use radius sparingly.** Too many rounded boxes in one area lose rhythm; where a thin
  line can separate, do not add another rounded box.

## 3. Surfaces (表面)

- **Hairline frames, not shadows.** Page on `--bg`; cards and panels on `--surface` with
  the `--edge` hairline (an optional very faint top gradient), no shadow.
- **At most two nested boxes**: panel, then group. Items inside a group are not boxed
  again; separate them with `--line` (on a grey group, `--line-2`). Example: a flow
  diagram has one box per stage; the steps inside a stage are rows with lines between.
- A small card inside a panel uses `--surface-2` and no extra border.
- **Shadow only on floating layers**: menus, dialogs, popovers, toasts (`--shadow`).
- **Tags in dense lists and tables are quiet text** (grey, no fill, no frame); colour stays
  only on the status dot. A tinted tag is fine only where there is little text, such as a
  card title or page header.
- **Tables inside a card line up with the card title**: first and last columns use the
  card's horizontal padding; dates and numbers do not wrap.

## 4. Spacing and layout

- **Spacing only from the `--space-*` scale.** Padding, gaps and margins use tokens; an
  off-scale value needs a comment saying why.
- **One padding token per role**, reused everywhere: page padding, card padding, list-row
  padding, gap between cards. A card's padding and its table's edge columns use the same
  token (section 3).
- **Layout facts of the default preset** (a product may change them, then keeps them
  stable): page padding `--space-5` to `--space-6` (24 to 32px); the sidebar is a layout
  constant, 228px expanded and 60px collapsed. Header and sidebar do not move between
  pages.
- **Breakpoints only from `ui-design-tokens`**, and as few as the layout needs. A component
  a host may embed chooses layout from a container query or a hosted signal, not a
  viewport breakpoint (`ui-portability-baseline`, "Do Not Assume You Own The Window").
- **Two-pane pages**: an edit page is edit on the left, live preview on the right
  (编辑页 = 左边编辑、右边预览); in a narrow container the preview becomes a view switch
  (edit / preview), not a squeezed second column.

## 5. Motion (动效)

- **Only page changes animate** (只有换页才动): when the route changes, the content area
  does one short fade out and fade in (`--t-fast` out, `--t-med` in), opacity only, no
  movement. Sidebar and header stay still.
- **Changes inside a page are instant**: switching tabs, filtering and collapsing do not
  animate the page, and nothing behind an opening dialog moves.
- **The only in-page motion is small and local**, each listed here and nowhere else:
  a selected state's colour transition over `--t-fast`; one short entrance for a menu,
  dialog or side panel (`--t-fast` to `--t-med`); a pressed button scaling very slightly
  (list rows never scale); a selection marker sliding between same-size icons in a rail.
- **Nothing flies across the screen**: no shared-element transitions between positions
  (they stretch text and fly in from unrelated places), no hover-triggered animation.
- **Respect reduced motion**: `prefers-reduced-motion` and the user's in-app motion
  setting turn durations to 0. No meaning may depend on an animation being seen.

## 6. Colour use

Colour values, theme mechanics and contrast pairs are in `ui-design-tokens`; theme
coverage is in `ui-portability-baseline`. The usage rules for this style:

- **Greyscale first** (黑白灰为主): colour only for brand logos, status dots, numbers
  that are a real alarm, and error states (section 7). Cards, charts and tags are
  greyscale; the primary button is ink, not a hue.
- **Series colours** (`--series-*`) only to tell categories apart, always next to a text
  label. **Status colours** (`--good`, `--warning`, `--serious`, `--critical`) only for
  status, always with an icon or text, never as a category colour. Colour is never the only
  signal (WCAG 1.4.1).
- **Charts are greyscale with the current item highlighted**; axes and legends in grey
  small text.

## 7. Component states and semantics

Every interactive control defines all of these, using tokens only:

- **Hover**: one surface step above the surface it sits on (`--surface` to `--surface-2`,
  `--surface-2` to `--surface-3`); no movement, no shadow.
- **Focus**: a visible `--focus` indicator on `:focus-visible`, never removed without a
  replacement (WCAG 2.4.7), at least 3:1 against what is next to it (1.4.11), and not
  hidden behind sticky headers or panels (2.4.11).
- **Selected / on**: colour change only, plus the rail marker of section 5; for underline tabs, a bold label and
  the ink underline, with the label's bold width reserved so the row does not shift.
  Expose the state to assistive technology (`aria-selected`, `aria-pressed` or
  `aria-current`).
- **Disabled**: `--ink-disabled` text and no hover. If a control is disabled for a reason
  the user can fix, say why next to it.
- **Error**: the field's border and a message below it in `--critical` (a pair
  `ui-design-tokens` documents as passing 4.5:1), with text saying what to fix, tied to the field
  (`aria-describedby`) and announced.
- **Loading**: keep the layout's size (a skeleton or an inline spinner); do not shift
  content.
- **Real controls**: anything clickable is a `button`, link or input, reachable by
  keyboard. Tabs are a `tablist` of buttons; every field has a visible label (a placeholder
  is not a label); decorative icons and emoji are `aria-hidden`.
- **Target size**: every target is at least 24×24 CSS px, or an undersized target has
  clearance so that a 24px circle centred on it overlaps no other target or its circle
  (WCAG 2.5.8; inline links in text are exempt). The smallest button in the default preset
  is exactly 24px high; do not go below it.
- `--line-2` is the control border and must meet 3:1 (WCAG 1.4.11) where the border is what shows the
  control's edge; `--line` is decorative only and is never the only boundary of a control.

## 8. Page patterns (安静的页面)

- **One focus per page** (一页一个重点): the page opens with one sentence saying the next
  step ("Next: …", 「下一步：…」) beside one primary button. The primary button is a solid
  `--ink` fill with `--on-fill` text; every other button is outline or text.
- **Big number plus one line**: at most 2 to 3 KPI cards, the number at `--fs-3xl`, one grey
  line below. A metric that is always 0 is left out.
- **Lists show 3 to 5 rows by default**, each with a title and one secondary fact (date or
  count); the rest goes behind "View all N →" (「查看全部 N 项 →」).
- **Only two kinds of switch** (切换只有两种样子): changing view, list or status/stage filter
  uses underline tabs (counts after the label in grey small text); picking one value from a
  small set (this week / this month, platform, format) uses option buttons. No boxed
  segmented bars, no solid dark blocks.
- **Each level appears once** (同一层级只出现一次): a switch already in the sidebar (view,
  status) is not repeated on the page.
- **Filters read as a sentence** (筛选写成一句话): "Show [open ⌄] work, owner [anyone ⌄]";
  the choosable parts are `--r-md` select boxes, the rest is plain text.
- **Edit forms are label-left, field-right rows** (左标签、右字段), a line between rows;
  dates, images and tags all use the same row. Selected tags are small `--r-sm` chips with
  × inside the input; the picker is a dropdown checklist, not a separate dialog.
- **Sort and filter popovers**: title and ×; one rule per row (field, select box, ×); a last
  row "+ Add …"; two equal-width buttons at the bottom, Cancel (outline) and Save (primary).
- **Empty states are plain text** (空状态是普通说明文字), shown only when there is nothing
  to list, not a grey box inside the card.
- **One icon block per page**: an icon block is the small tinted tile holding an icon
  beside a title. Only the page title has one; section and card titles do not.
- **Show the entity's logo wherever it appears** (sidebar, lists, tables, cards,
  schedules) when the product has per-entity logos.
- **Toolbars group related icon buttons** in one container, one radius step above its
  buttons.
- **A documented page exception** (for example a marketing-style home page with its own
  accent and pill inputs) is allowed only when it is written in the repository's design
  doc and scoped to that page's root class; every other page keeps these rules.

## 9. Chinese UI text (界面文字)

- No 【】 in UI text. Input placeholders and template slots use full-width parentheses:
  `（请输入名称）`, `（项目名）`.
- Full-width punctuation inside Chinese text, half-width inside Latin text and numbers; no
  space between a Chinese character and full-width punctuation.

## 10. Style checklist (风格检查清单)

Run it on a diff (read the CSS and markup) or on a screenshot (desktop light, desktop dark,
phone). Report each failed item with the file and line or the screen region, and a fix.
Inside a code review it runs as `review-checklist` item 9 (Project items), owned by the
session running the review or a reviewer given this checklist, and graded by that skill's
severity rubric. Within that rubric, by default, accessibility items (focus, labels,
target size, contrast, zoom and text spacing, colour as the only signal) are at least
Medium; pure style items are Low or Medium.

Common failure signals in a diff: raw hex or `px` for colour, type, radius or spacing;
`outline: none` with no replacement; `box-shadow` on a card; `transform` transitions or
`animation` on page content outside section 5's list; clickable `div` or `span`.

- [ ] Font sizes, weights and line heights come from tokens; no text below `--fs-xs` except
      axis labels, avatar initials and count badges.
- [ ] Only the three weights, each a real face; no light weight below `--fs-lg`.
- [ ] Font stack has a web-font fallback, not `local()` alone.
- [ ] Text uses `--ink`, `--ink-2` or `--ink-3` only; no pure white or black.
- [ ] Radius: containers `--r-lg`, controls `--r-md`, tags `--r-sm`; inner one step smaller
      than outer; pills only on thin bars and count badges.
- [ ] At most two nested boxes; rows inside a group are separated by lines, not boxes.
- [ ] Hairline `--edge` on cards; shadow only on floating layers.
- [ ] Tags in dense lists and tables are quiet grey text; colour only on the status dot.
- [ ] Spacing from `--space-*`; tables in cards line up with the card title.
- [ ] Only page changes animate; in-page motion limited to section 5's list; nothing flies
      across the screen; reduced motion turns motion off.
- [ ] Greyscale first; colour only on logos, status dots, alarm numbers and errors; charts
      greyscale with the current item highlighted; colour is never the only signal.
- [ ] One primary action per page, with a "next step" sentence; other buttons outline or
      text.
- [ ] Switches are underline tabs or option buttons only; no level repeated from the
      sidebar.
- [ ] Lists of 3 to 5 with "View all N"; 2 to 3 KPIs, none always 0; empty states as plain
      text; one icon block per page.
- [ ] Filters read as a sentence; edit forms are label-left rows; edit pages are edit-left,
      preview-right.
- [ ] Every control has hover, visible focus, selected, disabled, error and loading states
      as section 7 says; targets at least 24×24px.
- [ ] Clickable things are real controls; fields have visible labels; decorative icons are
      hidden from assistive technology.
- [ ] Layout survives 200% zoom, 320px reflow and the text-spacing override; no horizontal
      scroll at phone width.
- [ ] Chinese UI text: no 【】; placeholders （…）; full-width punctuation in Chinese.
- [ ] Any page exception is written in the repo's design doc and scoped to that page.
