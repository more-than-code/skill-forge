# Svelte Companion

Load this companion for Svelte component or library work. For SvelteKit apps, load this file first, then `sveltekit.md`.

**All Svelte code is Svelte 5+ in runes mode.** Do not write Svelte 4 syntax, even to match surrounding code. A project still on Svelte 4 is migrated in full first — `npx sv migrate svelte-5` across the project, then rewrite whatever it leaves in `svelte/legacy` — before any new Svelte code is written in it. There is no partially migrated state to work in. The [version gate](#svelte-version-gate) makes this mechanical rather than a review judgment.

### Svelte 4 → Svelte 5

| Svelte 4 | Svelte 5 |
|---|---|
| `export let x` | `let { x } = $props()` |
| `$: y = f(x)` | `let y = $derived(f(x))` |
| `$: { sideEffect(x) }` | `$effect(() => { sideEffect(x) })` |
| `on:click={h}` | `onclick={h}` |
| `createEventDispatcher` | callback props (`let { onsave } = $props()`) |
| `<slot />`, `<slot name="x" />` | `{@render children?.()}`, snippet props |
| `$$props`, `$$restProps` | `let { a, ...rest } = $props()` |
| `<svelte:component this={C} />` | `<C />` (components are dynamic by default) |
| `beforeUpdate` / `afterUpdate` | `$effect.pre` / `$effect` |
| `new Component({ target })` | `mount(Component, { target })` |

## Svelte Gotchas

- Use Svelte 5 runes deliberately: `$state` for reactive state, `$derived` for computed values, and `$effect` for effects that should re-run when accessed state changes.
- Keep values as plain variables when they do not drive template updates, derived values, or effects.
- Never use `$:` reactive blocks; use `$derived` for values and `$effect` for side effects.
- Declare component inputs only with `$props()` destructuring, and keep public props minimal and explicit.
- Use explicit callback props for parent/child events, never `createEventDispatcher`.
- Use event properties such as `onclick` and `onchange`, never `on:` directives.
- Pass content with snippets and `{@render}`, never `<slot>`. The one exception is a custom element compiled with `shadow: "open"`, where `<slot>` is the native shadow-DOM slot.
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

Event properties are ordinary props, so they can be spread, forwarded, and typed like any other.

### Snippets
Use snippets for reusable template fragments that are local to a component. Extract a component instead when the fragment needs independent state, lifecycle, tests, or reuse across files.

### Stores
Use stores when state is genuinely shared outside one component tree, when integrating with an existing store-based API, or when wrapping an external subscription source. Keep short-lived component-local state in runes.

### Dynamic and imperative components
Use the `Component` type for dynamic component references and the `mount` API for justified imperative mounting. Never use `SvelteComponent` classes or class-based instantiation.

## Svelte Version Gate

Svelte 5 picks runes mode per component: a file that uses no runes silently compiles as Svelte 4, so `export let` and `$:` still compile and a plain `svelte-check` passes them. Mixed-version code needs to be made impossible, not just discouraged. Gate in four layers; each catches something the others miss.

1. **Svelte 5 dependency.** `svelte` in `package.json` must be a `^5` (or later) range, and `svelte-check` must be v4+.

2. **Force runes mode** in `svelte.config.js`, so every project component compiles as Svelte 5. `export let`, `$:`, `$$props`, and `beforeUpdate`/`afterUpdate` become compile errors; `on:`, `<slot>`, and `<svelte:component>` become deprecation warnings. Exempt `node_modules` so legacy third-party components still compile:

   ```js
   compilerOptions: {
     runes: ({ filename }) =>
       filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
   },
   ```

3. **`svelte-check` with warnings as failures** — turns the layer 2 deprecations into failures. In SvelteKit apps run `svelte-kit sync` first so generated types exist.

   ```bash
   svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
   ```

4. **Lint bans** in `eslint.config.js`, after the `eslint-plugin-svelte` presets. This gives editor-speed feedback that does not depend on `svelte.config.js`, and it catches APIs the compiler still accepts in runes mode (`createEventDispatcher` compiles clean, as does the `svelte/legacy` shim the migration tool leaves behind):

   ```js
   {
     files: ["**/*.svelte"],
     rules: {
       "no-restricted-syntax": ["error",
         { selector: "SvelteReactiveStatement",
           message: "Svelte 4 `$:` — use $derived or $effect." },
         { selector: "ExportNamedDeclaration > VariableDeclaration[kind=/^(let|var)$/]",
           message: "Svelte 4 `export let` — use $props()." },
         { selector: "ExportNamedDeclaration[declaration=null][source=null]",
           message: "Svelte 4 `export { x as y }` prop — use $props() with renaming." },
       ],
     },
   },
   {
     rules: {
       "no-restricted-imports": ["error", { paths: [
         { name: "svelte", importNames: ["createEventDispatcher"],
           message: "Svelte 4 events — use callback props." },
         { name: "svelte/legacy",
           message: "Migration shim — rewrite with runes." },
       ] }],
     },
   }
   ```

   ```bash
   eslint .
   ```

Wire layers 3 and 4 into the same pre-commit and CI step so either failure blocks the change.

- Match `$:` as `SvelteReactiveStatement`. The parser gives it its own node type, so the generic `LabeledStatement[label.name='$']` selector silently matches nothing.
- Ban the `export { className as class }` form too. In runes mode it compiles as a component export, not a prop, so the compiler raises no error for it; the parent's value is silently ignored. Inline `export const` / `export function` (in either script) stay legal.
- Scope the syntax ban to `*.svelte` only. In `.svelte.js` / `.svelte.ts` modules, `export let` is ordinary module syntax, not a prop. The import bans apply everywhere.
- Do not lint-ban `<slot>`: layer 2 already warns on it in components, and stays quiet inside shadow-DOM custom elements, where `<slot>` is correct.
- Rule options replace rather than merge: if the config already sets `no-restricted-syntax` or `no-restricted-imports`, fold these entries into that rule, or the later one silently drops the earlier bans.
- `<script lang="ts">` components need `parserOptions.parser` set to the TypeScript parser; without it every TS component is a parsing error, which blocks the gate but hides the real findings.
- Turn the gate on only after the full migration; a partly migrated project fails it by design. Do not exclude project paths from the `runes` function or from ESLint to get it passing — the `node_modules` exemption is the only one.
- Prove the gate before trusting it with two throwaway components, then delete them: one with `export let x;` and `$: y = x;` (both commands must exit non-zero), and one that is otherwise valid runes code with an `on:click` (`svelte-check` must exit non-zero). Keep them separate — `svelte-check` stops at a file's first compile error, so a deprecation next to `export let` is never reported, and without `--fail-on-warnings` the `on:` file passes.

## Svelte Review Prompts

- Is this value really reactive, or should it stay a plain variable instead of becoming `$state`?
- Should this be `$derived` instead of a manually synchronized variable?
- Is this side effect better expressed as an event handler, lifecycle boundary, or `$effect`?
- Are props destructured with `$props()` and kept minimal?
- Are event handlers using Svelte 5 event properties in new code?
- Is two-way `bind:` actually needed, or would an explicit value plus event callback be clearer?
- Is component-local state using runes instead of stores?
- If dynamic components or imperative mounting are needed, are they using Svelte 5 APIs rather than legacy classes?
- Does the diff contain any Svelte 4 construct from the migration table, and does the project's version gate actually run in CI?

## Svelte Anti-Patterns

- Using `$state` for values that do not drive rendering, derived state, or effects.
- Manually synchronizing values that could be `$derived`.
- Using `$:` reactive statements or `export let` props instead of runes, or relying on review instead of the version gate to keep them out.
- Using stores for component-local state that can stay inside Svelte 5 runes.
- Using `createEventDispatcher`, `on:` directives, `<slot>`, `$$props`, or `svelte/legacy` imports in place of callback props, event properties, snippets, rest props, or runes.
- Leaving `svelte.config.js` without forced runes mode, so a component with no runes silently compiles as Svelte 4.
- Adding two-way `bind:` for convenience when it obscures ownership.
