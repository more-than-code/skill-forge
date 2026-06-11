# SvelteKit Companion

Load this companion when the frontend task is SvelteKit-specific.

## SvelteKit-Specific Gotchas

- Prefer `load` for route data dependencies instead of pushing initial page data fetching into `onMount`.
- In Svelte 5, use runes deliberately: `$state` for reactive state, `$derived` for computed values, and `$effect` for side effects that should re-run when accessed state changes.
- Do not reach for `$state` automatically. Plain variables are still better when a value does not need to drive template updates, derived state, or effects.
- `onMount` only runs in the browser, so browser-only code belongs there, but route data needed for SSR should not.
- Server-only secrets and privileged access belong in server `load` functions, actions, or endpoints, not in universal client code.
- Forms that mutate server state should use SvelteKit form actions when that model fits, so progressive enhancement and navigation behavior stay aligned with the framework.
- Browser globals must be guarded during SSR and prerendering.

## SvelteKit Patterns

### Rune-based local state
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

### Route data via `load`
```ts
// +page.ts
export async function load({ fetch }) {
  const response = await fetch("/api/partners");
  const partners = await response.json();

  return { partners };
}
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
  let { data } = $props();
</script>

{#each data.partners as partner (partner.id)}
  <PartnerCard {partner} />
{/each}
```

### Client-side derived state from loaded data
```svelte
<script lang="ts">
  let { data } = $props();
  let filter = $state("active");
  let filteredPartners = $derived(
    data.partners.filter((partner) => partner.status === filter)
  );
</script>
```

### Browser-only work in `onMount`
```svelte
<script lang="ts">
  import { onMount } from "svelte";

  onMount(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => {
      // react to browser-only state here
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  });
</script>
```

### Form actions for server mutations
```ts
// +page.server.ts
export const actions = {
  saveProfile: async ({ request }) => {
    const form = await request.formData();
    const name = form.get("name");

    // validate and persist
    return { success: true, name };
  }
};
```

### Enhanced forms when you need client hooks
```svelte
<script lang="ts">
  import { enhance } from "$app/forms";
</script>

<form method="POST" use:enhance>
  <input name="name" />
  <button>Save</button>
</form>
```

## SvelteKit Review Prompts

- Is this value really reactive, or should it stay a plain variable instead of becoming `$state`?
- Should this be `$derived` instead of a manually synchronized variable?
- Is this side effect better expressed with `$effect`, or does it belong in `load`, an action, or `onMount`?
- Should this data come from `load`, a form action, or a server endpoint instead of a browser-only fetch?
- Does this code behave correctly during SSR, hydration, and client-side navigation?
- Are invalidation and refresh paths explicit after a mutation?
- Is the route boundary the right place for auth, permissions, and data ownership?
- Are progressive enhancement and no-JS behavior acceptable for this form or route?
