# SvelteKit Companion

Load this companion after `svelte.md` for SvelteKit app work.

## SvelteKit Gotchas

- Prefer `load` for route data dependencies instead of pushing initial page data fetching into `onMount`.
- Choose universal `load` or server `load` deliberately. Use server-only load functions, actions, or endpoints for secrets, cookies, privileged access, and auth-sensitive data.
- Browser globals must be guarded during SSR and prerendering.
- Forms that mutate server state should use SvelteKit form actions when that model fits, so progressive enhancement and navigation behavior stay aligned with the framework.
- After mutations, make invalidation and refresh paths explicit with `invalidate`, `invalidateAll`, redirects, or returned action data.
- Put auth and permission checks at route or server boundaries instead of scattering them through UI components.
- Prefer existing local UI primitives, route conventions, API helpers, and type models before introducing new local patterns. Check common SvelteKit locations such as `src/lib/components`, `src/lib/types`, and `src/routes/api` when they exist.

## SvelteKit Patterns

### Universal route data
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

### Server route data
```ts
// +page.server.ts
import { redirect } from "@sveltejs/kit";

export async function load({ locals }) {
  if (!locals.user) {
    throw redirect(303, "/login");
  }

  return {
    user: locals.user
  };
}
```

Use server load when the route depends on cookies, credentials, secrets, direct database access, or privileged service calls.

### Form actions for server mutations
```ts
// +page.server.ts
import { fail } from "@sveltejs/kit";

export const actions = {
  saveProfile: async ({ request, locals }) => {
    if (!locals.user) {
      return fail(401, { message: "Unauthorized" });
    }

    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();

    if (!name) {
      return fail(400, { name, missing: true });
    }

    // validate and persist
    return { success: true, name };
  }
};
```

### Enhanced forms when client hooks are needed
```svelte
<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
</script>

<form
  method="POST"
  use:enhance={() => {
    return async ({ result, update }) => {
      await update();
      if (result.type === "success") {
        await invalidateAll();
      }
    };
  }}
>
  <input name="name" />
  <button>Save</button>
</form>
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

Use `onMount` for browser-only behavior, not for route data needed during SSR or initial navigation.

## SvelteKit Review Prompts

- Should this data come from `load`, a form action, or a server endpoint instead of a browser-only fetch?
- Should this load run universally or only on the server?
- Are secrets, cookies, auth checks, and privileged service calls kept out of client/universal code?
- Does this code behave correctly during SSR, hydration, prerendering, and client-side navigation?
- Are invalidation and refresh paths explicit after a mutation?
- Is the route boundary the right place for auth, permissions, and data ownership?
- Are progressive enhancement and no-JS behavior acceptable for this form or route?
- Does the implementation follow existing local UI primitives and design-system conventions before adding custom controls?

## SvelteKit Anti-Patterns

- Fetching initial route data in `onMount` when it belongs in `load`.
- Putting secrets, cookies, privileged access, or auth-sensitive logic in universal or client code.
- Mutating server state through ad hoc browser fetches when a form action would preserve framework behavior.
- Forgetting invalidation, redirect, or returned action state after a mutation.
- Using browser globals during SSR or prerendering without guards.
- Packing route loading, mutation handling, and complex markup into one page component when local components or helpers would make ownership clearer.
