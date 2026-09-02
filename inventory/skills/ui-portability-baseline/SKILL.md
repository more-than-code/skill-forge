---
name: ui-portability-baseline
description: >
  Lightweight UI maintainability and portability baseline for frontend work that
  should remain easy to migrate across repositories or align with a stricter
  design system later, including components that must survive being embedded in a
  host container (side panel, drawer, split view, modal) where viewport
  breakpoints, viewport units and fixed positioning stop meaning what they say.
  Use when implementing or reviewing UI where full design-system governance is
  not required yet.
---

# UI Portability Baseline

## Purpose

Use this skill to keep UI work maintainable, consistent, and easy to port across repositories without requiring full design-system governance on every change.

This is an advisory baseline unless the task explicitly requires strict design-system compliance.

## Principles

### 1. Reuse Shared Primitives First

- Prefer existing shared primitives such as buttons, inputs, selects, textareas, checkboxes, dialogs, tabs, menus, and cards.
- Avoid raw form/control elements in feature code when a shared primitive exists.
- Keep reusable interaction behavior in shared primitives where practical.
- Do not copy-paste components just to make small styling changes.

### 2. Use Semantic Styling

- Prefer semantic tokens, CSS variables, and existing theme classes over hardcoded colors.
- Avoid inline styles, one-off hex colors, and raw palette values in feature code.
- Name styles by intent: surface, border, muted text, selected, disabled, danger, success, warning, focus.

### 3. Preserve Theme Portability

- New or changed UI surfaces should work across supported themes.
- Do not add theme-specific backgrounds, shadows, borders, or text colors without equivalents for other supported themes.
- Prefer existing theme variables over new local color definitions.

### 4. Keep Control Density Consistent

- Buttons, inputs, selects, tabs, and toolbar controls should feel like the same system.
- Avoid oversized call-to-action buttons inside dense operational surfaces.
- Match button size and spacing to nearby controls in forms, tables, toolbars, filters, and dialogs.

### 5. Preserve Basic Accessibility

- Prefer semantic elements and shared accessible primitives over custom clickable containers.
- Keep keyboard access, visible focus states, labels, and accessible names intact.
- Check that foreground and background choices preserve readable contrast in supported themes.
- Do not hide meaningful content from assistive technology unless an equivalent path remains.

### 6. Separate Feature Logic From UI System Details

- Keep business logic, API calls, and workflow state separate from styling and primitive implementation details.
- Prefer simple props and generic component APIs that could survive a future design-system swap.
- Use local UI barrels where available instead of deep imports.

### 7. Avoid Portability Debt

Treat these as portability debt unless intentionally justified:

- Raw form/control elements in feature code.
- Hardcoded colors or spacing where tokens exist.
- Inline style objects.
- Duplicated local variants of shared components.
- Feature-specific component APIs that expose repo-specific implementation details.
- Styling that only works in one supported theme.
- Custom interactions without keyboard, focus, label, or accessible-name coverage.
- UI changes that were not checked in supported themes or relevant viewport sizes.
- Viewport breakpoints or viewport units inside a component a host may embed.
- Fixed-position overlays rendered inside the component tree rather than into `body`.
- Components that reach for a specific sibling surface instead of routing through a host interface.

### 8. Do Not Assume You Own The Window

A component that renders as a full page today may be embedded tomorrow - in a side panel, a drawer, a split view, a modal, an inline preview. Four viewport assumptions break the moment it is:

- **Breakpoints ask about the window, not the container.** Responsive utilities and `@media (min-width: ...)` measure the viewport, so a narrow container on a wide screen keeps every wide-layout rule. Choose layout from an explicit "am I hosted" signal, or from container queries where they are available - never from a viewport breakpoint.
- **Viewport units mean the screen.** `100vh`, `100dvh` and `vw` size to the display, not to the container. Inside a host, size to `100%`.
- **`position: fixed` is not reliably viewport-relative.** It resolves against the nearest ancestor carrying a `transform`, `filter` or `perspective` - and hosts commonly carry one for slide-in animation. Render fixed overlays into `body` so no ancestor can redefine what their coordinates mean.
- **The host supplies its own chrome.** A title, a close control, a surrounding frame. A component that draws its own gives the reader two, and offers actions that make no sense from inside the host.

**Anything aimed at the surrounding surface must be routed through the host, not assumed.** A component cannot know what it is embedded next to, so "send this somewhere" interactions - quoting into a nearby conversation, sharing, opening a related record - belong behind an interface the host provides, exactly as a close control does. A component that reaches for a specific sibling works in one placement and silently does nothing in the next.

**The failure modes are not equally visible.** Chrome, sizing and layout fail loudly - the shape is obviously wrong. Fixed positioning fails silently: the overlay is created correctly and placed outside the visible area, which is indistinguishable from the feature being dead. On a report that "the control never appears", instrument early rather than re-reading the component.

Observed 2026-09-02: one set of pages reused inside a side panel produced four separate defects - duplicated chrome, a sidebar that never collapsed, a view sized to the screen, and an overlay placed off-screen - all four traceable to these assumptions and to nothing else.

## Review Checklist

Before completing UI work, check:

- [ ] Existing primitives were reused where available.
- [ ] New styling uses semantic tokens or existing theme variables.
- [ ] Supported themes remain covered.
- [ ] Keyboard access, focus states, labels, accessible names, and readable contrast remain covered.
- [ ] Control sizing matches surrounding operational UI.
- [ ] No unnecessary local component fork was introduced.
- [ ] Feature logic remains separate from design-system implementation details.
- [ ] Components a host may embed choose layout from a hosted signal or container query, not a viewport breakpoint.
- [ ] Hosted-capable components size to `100%` rather than to viewport units.
- [ ] Fixed-position overlays render into `body`.
- [ ] Actions aimed at the surrounding surface go through the host interface.
- [ ] Any portability debt is named in completion notes.

## Verification

- Run the normal lint, typecheck, and test gates expected by the repository.
- Render or manually inspect the changed UI in each supported theme, or at minimum the default and dark/high-contrast theme when those exist.
- Check the changed UI at the viewport sizes relevant to the surrounding page or component.
- Where a component can be embedded, exercise it in **both** placements - standalone and hosted - and test any overlay in each, since an off-screen overlay is indistinguishable from a dead control.
- Exercise keyboard navigation and visible focus for any changed interactive control.
- Run stricter design-system checks only when the task or repo requires strict compliance.
- If advisory governance findings are available, report them as portability debt rather than automatic blockers.

## Relationship To Stricter Skills

- Use broader frontend engineering skills for architecture, state, layout, accessibility, and component design.
- Use repo-specific design-system skills for strict primitive, token, lint, and governance enforcement.
- Use this skill when the goal is maintainable and portable UI without full strict enforcement.
