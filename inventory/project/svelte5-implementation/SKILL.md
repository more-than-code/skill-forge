---
name: svelte5-implementation
version: 0.1.0
description: Guidelines for implementing Svelte 5 features, reactivity patterns, and component APIs.
---

# Svelte 5 Implementation Guidelines

## Reactivity (Runes)

Prefer Svelte 5 runes over legacy reactive syntax:
- Use `let x = $state(value)` for mutable state
- Use `$derived(...)` for computed values
- Use `$effect(...)` for side effects
- Avoid `$:` reactive blocks unless absolutely necessary and well-documented as legacy

Example:
```svelte
<script>
  let count = $state(0);
  let doubled = $derived(count * 2);
  
  $effect(() => {
    console.log(`Count is now ${count}`);
  });
</script>
```

## Event Handling

Use standard DOM event properties, not directives:
- ✅ `onclick={handleClick}`, `onchange={handleChange}`
- ❌ `on:click={handleClick}`, `on:change={handleChange}`

Do not use `createEventDispatcher` unless there's no alternative in Svelte 5.

Example:
```svelte
<button onclick={() => count++}>Click me</button>
<input onchange={(e) => handleInput(e.target.value)} />
```

## Component APIs

Prefer modern Svelte 5 component patterns:
- Use the `Component` type for dynamic components
- Use the `mount` API for imperative component instantiation
- Avoid legacy `SvelteComponent` class or class-based instantiation

Props should use destructuring with `let { prop } = $props()`:
```svelte
<script>
  let { title, onClose } = $props();
</script>
```

## Svelte 5 Constructs

Leverage modern Svelte 5 features:
- Use **Snippets** for reusable template fragments
- Use **enhanced compiler-driven optimizations** for better performance
- Use new syntax and patterns recommended in official Svelte 5 documentation

## Key Resources

- [Svelte 5 Official Docs](https://svelte.dev)
- [Svelte Runes Documentation](https://svelte.dev/docs/runes)
- [Component Basics](https://svelte.dev/docs/component-basics)

## Anti-Patterns

- ❌ Two-way binding with `bind:` (prefer explicit event handlers)
- ❌ Reactive statements with `$:` for complex logic
- ❌ Stores for component-local state (use runes instead)
- ❌ Lifecycle functions like `onMount`, `onDestroy` (use `$effect` instead)
