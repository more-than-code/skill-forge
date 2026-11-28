---
name: quiet-ui-style-guide
description: >
  Usage rules for a dense, calm work-tool interface ("quiet UI", 安静的页面): which type
  size, weight and radius to use where, at most two nested boxes, hairlines instead of
  shadows, motion only on page change, one primary action per page, greyscale first,
  component states, Chinese UI text rules, and a style checklist to run on a diff or a
  screenshot. All values come from `ui-design-tokens`. Activate when designing, building
  or reviewing a page or component in this style.
---

# Quiet UI Style Guide

Rules for a work tool people look at all day: dense, calm, greyscale first, with colour
and motion kept for the few things that need attention.

This skill holds **only the rules for using tokens**. Every value (type sizes, line
heights, font stacks, weights, spacing steps, radii, colours, durations, easing, shadows,
breakpoints) lives in the `ui-design-tokens` skill, and the token names below are its
names. Load it alongside this one. Where a repository has its own design doc or token
file, its values win; these rules still apply.

Related skills, not repeated here:

- `ui-portability-baseline`: shared primitives, semantic tokens, theme coverage, embedding
  in a host. Its rules apply too.
- `landing-page`: public marketing pages, including palette and status colours. A landing
  page is not a work tool; this skill does not govern it.
- `frontend-engineering`: architecture, state, accessibility and performance review.
- `review-checklist`: how a review runs and is graded. The checklist at the end of this
  skill is the UI-style items such a review adds; it is not a separate reviewer lens.

## 1. Type (文字)

- **Sizes only from the `--fs-*` scale.** No raw `px` font sizes in feature code.
  - `--fs-xs`: captions, timestamps, counts. The smallest size for any text a user must
    read; only chart axis labels, avatar initials and count badges may go below it.
  - `--fs-sm`: secondary info, labels, table headers.
  - `--fs-md`: body, forms, list rows (the default).
  - `--fs-lg`: card and section titles.
  - `--fs-xl`: dialog and work-item titles, stat numbers.
  - `--fs-2xl`: page titles. `--fs-3xl`: cover pages and KPI numbers.
  - `--fs-4xl` and `--fs-5xl` (display): export covers and a home-page greeting only. A
    fluid hero size (`clamp()`) is allowed only there, and it falls back to `--fs-3xl` on
    phones.
- **Three weights, all real faces.** Use only the three weight tokens: the strongest for
  page and card titles and for each row's own item name (in a table, only the first
  column is bold); regular for everything else; the lightest only for long subtitles at
  `--fs-lg` or larger. Every weight maps to a face that exists, so the browser never fakes
  an in-between or bold weight. Do not use a light weight for small text: thin CJK strokes
  break up at small sizes.
- **Fonts never depend on `local()` alone.** Aliases that map system fonts (Segoe UI,
  Microsoft YaHei 微软雅黑, PingFang 苹方) to the three weight ranges work only where those
  fonts are installed; Linux and Android fall back to whatever is there. The font stack in
  `ui-design-tokens` ends with a web-font fallback (Latin and CJK) and a generic family;
  load it with `font-display: swap`, and split CJK fonts by `unicode-range` so a page
  downloads only the subsets it uses.
- **Line height from the `--lh-*` tokens**: tight for headings and big numbers, body for
  running text (1.4 to 1.6 is common practice), and the CJK long-text value for
  paragraphs of Chinese, which needs more room than Latin text.
- **Survive user text settings.** Sizes in `rem` (or tokens that resolve to it) so text
  zoom works; layouts must survive 200% zoom (WCAG 1.4.4) and the text-spacing override of
  WCAG 1.4.12 (line height 1.5, paragraph spacing 2x, letter spacing 0.12em, word spacing
  0.16em) without clipping or overlap.
- **Text colour from the ink tokens only**: `--ink` for text, `--ink-2` for secondary,
  `--ink-3` for the weakest captions (still 4.5:1 in both themes). No lighter greys, no
  series colours for text, no pure white or pure black text or surfaces (不用纯白和纯黑);
  text on a coloured fill uses `--on-fill`.

## 2. Radius (圆角)

- **Three everyday steps:** containers (cards, panels, dialogs) `--r-lg`; controls
  (buttons, inputs, list rows, small cards inside a panel, segmented groups) `--r-md`;
  tags, chips and swatches `--r-sm`. `--r-xl` for covers and large blocks only.
- **Inner is one step smaller than outer** (panel `--r-lg`, then its controls `--r-md`,
  then tags `--r-sm`; a segmented group is a control at `--r-md`, its buttons `--r-sm`).
- **Pill (`--r-pill`) only for thin bars** such as progress bars and count badges. Buttons
  and tags are never pills. Circles (`50%`) only for avatars and round icon buttons.
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
- **Layout facts of the default preset** (adjust per product, then keep them stable):
  sidebar 228px expanded and 60px collapsed; page padding 24 to 32px; header and sidebar do
  not move between pages.
- **Breakpoints only from `ui-design-tokens`**, and as few as the layout needs. A component
  a host may embed chooses layout from a container query or a hosted signal, not a
  viewport breakpoint (`ui-portability-baseline` §8).
- **Two-pane pages**: an edit page is edit on the left, live preview on the right
  (编辑页 = 左边编辑、右边预览); on a narrow screen the preview becomes a view switch
  (edit / preview), not a squeezed second column.

## 5. Motion (动效)

- **Only page changes animate** (只有换页才动): when the route changes, the content area
  does one short fade out and fade in, with no movement. Sidebar and header stay still.
- **Changes inside a page are instant**: switching tabs, filtering, collapsing and opening
  a dialog do not animate the page; a selected state changes colour only, over `--t-fast`.
- **Nothing flies across the screen**: no shared-element transitions between positions
  (they stretch text and fly in from unrelated places). The one exception is a selection
  marker moving between same-size icons in a rail.
- Menus, dialogs and side panels each have one short entrance (`--t-fast` to `--t-med`).
  A pressed button may scale slightly (0.97); list rows do not scale.
- **Respect reduced motion**: `prefers-reduced-motion` and the user's in-app motion
  setting turn durations to 0. No meaning may depend on an animation being seen.

## 6. Colour use

Colour values and theme mechanics are in `ui-design-tokens`; contrast and theme rules are
in `ui-portability-baseline`. The usage rules for this style:

- **Greyscale first** (黑白灰为主): colour only for brand logos, status dots and numbers
  that are a real alarm. Cards, charts and tags are greyscale.
- **Series colours** (`--series-*`) only to tell categories apart, always next to a text
  label. **Status colours** (`--good`, `--warning`, `--serious`, `--critical`) only for
  status, always with an icon or text, never as a category colour. Colour is never the only
  signal (WCAG 1.4.1).
- **Charts are greyscale with the current item highlighted**; axes and legends in grey
  small text.

## 7. Component states

Every interactive control defines all of these, using tokens only:

- **Hover**: a surface step (`--surface-2` or `--surface-3`), no movement, no shadow.
- **Focus**: a visible `--focus` indicator on `:focus-visible`, at least 3:1 against what
  is next to it (WCAG 1.4.11), never removed without a replacement (2.4.7), and not hidden
  behind sticky headers or panels (2.4.11).
- **Selected / on**: colour change only (section 5); for underline tabs, a bold label and a
  2px ink underline.
- **Disabled**: `--ink-disabled` text and no hover; keep it in the tab order only if a
  tooltip explains why. Never disabled by lowering contrast alone on something the user
  must read to understand.
- **Error**: the field's border and a message below it in `--critical`, with an icon or
  text saying what to fix; announce it to assistive technology.
- **Loading**: keep the layout's size (a skeleton or an inline spinner), do not shift
  content.
- **Target size**: every clickable target is at least 24×24 CSS px, or has 24px spacing
  (WCAG 2.5.8). The smallest button size in the default preset is exactly 24px high; do
  not go below it.
- Control borders (`--line-2`) and the focus indicator meet 3:1; `--line` is decorative
  only and must not be the only boundary of a control.

## 8. Page patterns (安静的页面)

- **One focus per page** (一页一个重点): the page opens with one sentence saying the next
  step ("Next: …", 「下一步：…」) beside one primary button. The primary button is solid
  ink (in dark theme a near-white fill with dark text); every other button is outline or
  text.
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
- **Empty states are plain text** (空状态是普通说明文字), not a grey box inside the card.
- **One icon block per page**: the page title carries the icon block, section titles do
  not.
- **Show the entity's logo wherever it appears** (sidebar, lists, tables, cards,
  schedules) when the product has per-entity logos.
- **Toolbars group related icon buttons** in one container, one radius step above its
  buttons.
- **A documented page exception** (for example a marketing-style home page with its own
  accent and pill inputs) is allowed only when it is written in the repository's design
  doc and scoped to that page's root class; every other page keeps these rules.

## 9. Chinese UI text (界面文字)

- No 【】 in UI text; placeholders use full-width parentheses （…）.
- Use full-width punctuation inside Chinese text and half-width inside Latin text and
  numbers; no space between Chinese characters and full-width punctuation.
- Keep the Chinese term when translating a design doc and give the English beside it, as
  this skill does, so the two can be searched together.

## 10. Style checklist (风格检查清单)

Run it on a diff (read the CSS and markup) or on a screenshot (desktop light, desktop dark,
phone). Report each failed item with the file and line or the screen region, and a fix.
When it runs inside a code review, its failures are findings for that review's frontend or
code-quality lens, graded by `review-checklist`'s rubric.

- [ ] Font sizes, weights and line heights come from tokens; no text below `--fs-xs` except
      axis labels, avatar initials and count badges.
- [ ] Only three weights, each a real face; no light weight below `--fs-lg`.
- [ ] Font stack has a web-font fallback, not `local()` alone.
- [ ] Radius: containers `--r-lg`, controls `--r-md`, tags `--r-sm`; inner one step smaller
      than outer; pills only on thin bars and count badges.
- [ ] At most two nested boxes; rows inside a group are separated by lines, not boxes.
- [ ] Hairline `--edge` on cards; shadow only on floating layers.
- [ ] Spacing from `--space-*`; tables in cards line up with the card title.
- [ ] Only page changes animate; nothing flies across the screen; reduced motion turns
      motion off.
- [ ] Greyscale first; colour only on logos, status dots and alarm numbers; colour is never
      the only signal.
- [ ] One primary action per page, with a "next step" sentence; other buttons outline or
      text.
- [ ] Switches are underline tabs or option buttons only; no level repeated from the
      sidebar.
- [ ] Lists of 3 to 5 with "View all N"; 2 to 3 KPIs; empty states as plain text; one icon
      block per page.
- [ ] Every control has hover, visible focus (3:1), disabled and error states; targets at
      least 24×24px.
- [ ] Layout survives 200% zoom and the WCAG 1.4.12 text-spacing override; no horizontal
      scroll at phone width.
- [ ] Chinese UI text: no 【】; placeholders （…）.
- [ ] Any page exception is written in the repo's design doc and scoped to that page.
