---
name: frontend-engineering
description: >
  Review browser-based frontend architecture, component design, state management,
  accessibility, performance, and styling. Use this as the shared entrypoint for
  framework-agnostic frontend guidance, then load framework companion files such as
  `react.md`, `svelte.md`, or `sveltekit.md` when the implementation is stack-specific.
---

# Frontend Engineering

Use this skill for browser-based frontend work across frameworks.

Read this file first for shared frontend principles. If the task is framework-specific,
load the matching companion file in this directory:

- `react.md` for React-specific hooks, rendering, composition, and performance guidance
- `svelte.md` for Svelte-specific component syntax, runes, props, events, snippets, stores, and component APIs
- `sveltekit.md` for SvelteKit-specific routing, data loading, forms, actions, and SSR guidance; load after `svelte.md`

## Related Skills
- **code-quality:** General code structure, naming, and refactoring.
- **performance-analysis:** Profiling and optimization strategies.
- **security-baseline:** Input validation, XSS prevention, CSP headers.
- **api-contracts:** API shape consumed by the frontend.
- **testing-strategy:** Component and integration testing.
- **ui-portability-baseline:** Lightweight UI primitive reuse, tokens, themes, and basic accessibility.

## Activation Guide

Activate this skill for:
- Browser UI implementation or review
- Frontend architecture decisions
- Accessibility, layout, or styling changes
- Client/server data flow that affects the web UI

Then load a companion file when:
- The task is explicitly React-based
- The task is explicitly Svelte-based
- The task is explicitly SvelteKit-based, in which case load `svelte.md` first, then `sveltekit.md`
- Framework lifecycle, rendering, routing, or state rules matter to correctness

## Shared Gotchas

- `100vh` on mobile includes browser chrome and can produce layout bugs. Prefer `100dvh` for full-viewport layouts.
- Keys and identities must stay stable across list reordering, streaming updates, and optimistic UI.
- Route state, fetched data, and local UI state should have clear ownership. Avoid duplicating the same truth in multiple places.
- One styling system per project is easier to maintain than mixing several approaches.
- Real-time connections, timers, and event listeners need explicit cleanup and reconnection behavior.

## Checklist

### Component Architecture
- [ ] Components follow single responsibility — one reason to change
- [ ] Public component interfaces are minimal and explicit
- [ ] Side effects are isolated to framework-appropriate lifecycle boundaries
- [ ] Components are split before they become difficult to trace or review
- [ ] Business logic is extracted from view markup when it obscures intent

### State Management
- [ ] State lives at the lowest common owner, not higher by default
- [ ] Server state and client UI state are handled separately
- [ ] Derived state is computed instead of duplicated
- [ ] Loading, error, empty, and retry states are handled for async flows
- [ ] High-frequency state updates do not force unnecessary re-renders across the app

### Routing & Navigation
- [ ] Route structure matches UI hierarchy and user navigation
- [ ] Deep links are directly loadable and bookmarkable
- [ ] Auth or role checks happen at route or server boundaries, not ad hoc in random components
- [ ] Unsaved changes are guarded before navigation
- [ ] Large route bundles are split lazily when appropriate

### Styling & Layout
- [ ] Layout primitives match the problem: flex for 1D, grid for 2D
- [ ] Responsive behavior uses shared tokens or breakpoints
- [ ] Overflow is intentional and tested on small screens
- [ ] Z-index usage follows a scale, not one-off escalation
- [ ] Global styles are narrowly scoped and do not leak across features

### Data Fetching & Real-Time
- [ ] Data loads in a predictable lifecycle boundary, not during render
- [ ] Duplicate requests are avoided where practical
- [ ] In-flight work is canceled or safely ignored on teardown/navigation
- [ ] Streaming updates append or patch incrementally instead of replacing full state
- [ ] Reconnection, stale state, and failure handling are visible to users when relevant

### Accessibility
- [ ] Interactive elements are keyboard-operable and focus-visible
- [ ] Custom controls expose the correct labels, roles, and states
- [ ] Focus is managed during modal and route transitions
- [ ] Color contrast and non-color cues satisfy the UI state being communicated
- [ ] Dynamic status changes are announced when users would otherwise miss them

## Anti-Patterns

- **God components** — rendering, fetching, validation, and routing packed into one file
- **Duplicated state ownership** — the same data tracked in route state, local state, and a store
- **Framework lifecycle misuse** — using lifecycle hooks for business flow that belongs in events, loaders, or actions
- **Styling sprawl** — multiple competing styling systems in the same project
- **No teardown discipline** — leaked timers, sockets, observers, or subscriptions

## Framework Companions

Load the companion file that matches the active stack before making framework-specific decisions:

- `react.md`
- `svelte.md`
- `sveltekit.md`
