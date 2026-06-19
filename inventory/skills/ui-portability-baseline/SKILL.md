---
name: ui-portability-baseline
description: >
  Lightweight UI maintainability and portability baseline for frontend work that
  should remain easy to migrate across repositories or align with a stricter
  design system later. Use when implementing or reviewing UI where full
  design-system governance is not required yet.
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

## Review Checklist

Before completing UI work, check:

- [ ] Existing primitives were reused where available.
- [ ] New styling uses semantic tokens or existing theme variables.
- [ ] Supported themes remain covered.
- [ ] Keyboard access, focus states, labels, accessible names, and readable contrast remain covered.
- [ ] Control sizing matches surrounding operational UI.
- [ ] No unnecessary local component fork was introduced.
- [ ] Feature logic remains separate from design-system implementation details.
- [ ] Any portability debt is named in completion notes.

## Verification

- Run the normal lint, typecheck, and test gates expected by the repository.
- Render or manually inspect the changed UI in each supported theme, or at minimum the default and dark/high-contrast theme when those exist.
- Check the changed UI at the viewport sizes relevant to the surrounding page or component.
- Exercise keyboard navigation and visible focus for any changed interactive control.
- Run stricter design-system checks only when the task or repo requires strict compliance.
- If advisory governance findings are available, report them as portability debt rather than automatic blockers.

## Relationship To Stricter Skills

- Use broader frontend engineering skills for architecture, state, layout, accessibility, and component design.
- Use repo-specific design-system skills for strict primitive, token, lint, and governance enforcement.
- Use this skill when the goal is maintainable and portable UI without full strict enforcement.
