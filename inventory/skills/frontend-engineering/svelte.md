# Svelte Companion

Load this companion for Svelte component or library work. For SvelteKit apps, load this file first, then `sveltekit.md`.

## Svelte Gotchas

- Use Svelte 5 runes deliberately: `$state` for reactive state, `$derived` for computed values, and `$effect` for effects that should re-run when accessed state changes.
- Keep values as plain variables when they do not drive template updates, derived values, or effects.
- Avoid legacy `$:` reactive blocks in new Svelte 5 code unless the surrounding codebase still uses them and the compatibility trade-off is intentional.
- Prefer `$props()` destructuring for component inputs, and keep public props minimal and explicit.
- Prefer explicit callback props for parent/child events. Avoid `createEventDispatcher` unless legacy code depends on that pattern.
- Prefer Svelte 5 event properties such as `onclick` and `onchange` over legacy `on:` directives in new code.
- Stores are still useful for shared cross-component state, existing store APIs, external subscriptions, and framework conventions. Avoid stores for component-local state that can stay in runes.
- Use browser-only lifecycle work carefully. In SvelteKit apps, also apply `sveltekit.md` guidance for SSR, routing, and data loading.

## Svelte Patterns

### Runes
```svelte
<script lang="ts">
  let count = $state(0);
  let doubled = $derived(count * 2);

  $effect(() => {
    console.log("count changed", count);
  });
</script>

<button onclick={() => count += 1}>
  {count} / {doubled}
</button>
```

Use runes for state that participates in template updates, derived values, or effects. Keep non-reactive intermediate values as plain variables.

### Component props
```svelte
<script lang="ts">
  let { title, onClose } = $props<{
    title: string;
    onClose: () => void;
  }>();
</script>

<button onclick={onClose}>{title}</button>
```

Keep prop APIs narrow. Prefer a callback prop over implicit event dispatch in new Svelte 5 components.

### DOM events
```svelte
<button onclick={handleClick}>Save</button>
<input onchange={(event) => updateValue(event.currentTarget.value)} />
```

Use event properties in new code unless the surrounding codebase is intentionally staying on legacy syntax.

### Snippets
Use snippets for reusable template fragments that are local to a component. Extract a component instead when the fragment needs independent state, lifecycle, tests, or reuse across files.

### Stores
Use stores when state is genuinely shared outside one component tree, when integrating with an existing store-based API, or when wrapping an external subscription source. Keep short-lived component-local state in runes.

### Dynamic and imperative components
Use the modern `Component` type for dynamic component references and the Svelte 5 `mount` API for justified imperative mounting. Avoid legacy `SvelteComponent` classes or class-based instantiation in new code.

## Svelte Review Prompts

- Is this value really reactive, or should it stay a plain variable instead of becoming `$state`?
- Should this be `$derived` instead of a manually synchronized variable?
- Is this side effect better expressed as an event handler, lifecycle boundary, or `$effect`?
- Are props destructured with `$props()` and kept minimal?
- Are event handlers using Svelte 5 event properties in new code?
- Is two-way `bind:` actually needed, or would an explicit value plus event callback be clearer?
- Is component-local state using runes instead of stores?
- If dynamic components or imperative mounting are needed, are they using Svelte 5 APIs rather than legacy classes?

## Svelte Anti-Patterns

- Using `$state` for values that do not drive rendering, derived state, or effects.
- Manually synchronizing values that could be `$derived`.
- Using `$:` reactive statements for new complex logic instead of runes.
- Using stores for component-local state that can stay inside Svelte 5 runes.
- Using custom event dispatch in new components where explicit callback props would be clearer.
- Adding two-way `bind:` for convenience when it obscures ownership.
