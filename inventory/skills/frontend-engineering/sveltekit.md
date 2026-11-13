# SvelteKit Companion

Load this companion after `svelte.md` for SvelteKit app work.

## New SvelteKit Project: Before the First Component

The `svelte.md` version gate is setup, not only migration advice. A fresh scaffold has none of it, and a project that writes only runes still needs the gate: one component written in Svelte 4 syntax compiles silently. Observed 2026-11-13 on one project: a new SvelteKit app (Svelte 5, 137 runes-only components) shipped without layers 2 and 3. The gap was caught in review, not by any check.

Before the first component lands:

1. `svelte` `^5` and `svelte-check` v4+ in `package.json` (layer 1).
2. `compilerOptions.runes` in `svelte.config.js`, with the `node_modules` exemption (layer 2).
3. A `check` script, `svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --fail-on-warnings`, run in CI and pre-commit (layer 3).
4. The lint bans (layer 4). If the project has no ESLint, either add it for these rules, or record that you chose an equivalent instead: for example, a test that greps `*.svelte` for `export let`, `$:`, `on:` and `createEventDispatcher`, and imports for `svelte/legacy` and `$app/stores`. Such a test replaces layer 4 only, never layers 2–3: a grep cannot see what the compiler sees.
5. Prove it with the two throwaway components from `svelte.md`, then delete them.

## SPA Build Served by Another Backend

When `adapter-static` builds a client-only app that a non-Node server (Go, Rust, Java) embeds or serves:

- **Config:** `adapter({ pages, assets, fallback: 'index.html' })`, with `export const ssr = false` and `export const prerender = false` in the root `+layout.ts`.
- **Do not lose `_app/`.** Embedders often skip files whose names start with `_` or `.`. Go's `//go:embed dist` drops `_app/` silently, so the app ships without its JS and CSS. Use `//go:embed all:dist`, and have the server answer 404 for dot-path segments, since `all:` embeds those too. Check the output: list the embedded files, or request one `_app/immutable/` asset from the built server.
- **Cache:**
  - `_app/immutable/*`: `Cache-Control: public, max-age=31536000, immutable`.
  - `_app/version.json`, `_app/env.js`, and `index.html`: revalidate (`no-cache`).
- **Fallback:** only route paths get `index.html`. A miss under `_app/`, or any path with a file extension, is a 404. Otherwise a stale client asking for a deleted chunk gets HTML with status 200, and fails with a MIME error instead of reloading.

## SvelteKit Gotchas

- Prefer `load` for route data dependencies instead of pushing initial page data fetching into `onMount`.
- Choose universal `load` or server `load` deliberately. Use server-only load functions, actions, or endpoints for secrets, cookies, privileged access, and auth-sensitive data.
- Browser globals must be guarded during SSR and prerendering.
- Read page state from `$app/state` (`page.url`, `page.data`), not the deprecated `$app/stores` (`$page`); `$app/state` needs SvelteKit 2.12+. Add `{ name: "$app/stores", message: "Use $app/state." }` to the `no-restricted-imports` paths from the `svelte.md` version gate.
- Forms that mutate server state should use SvelteKit form actions when that model fits, so progressive enhancement and navigation behavior stay aligned with the framework.
- After mutations, make invalidation and refresh paths explicit with `invalidate`, `invalidateAll`, redirects, or returned action data.
- Put auth and permission checks at route or server boundaries instead of scattering them through UI components.
- Prefer existing local UI primitives, route conventions, API helpers, and type models before introducing new local patterns. Check common SvelteKit locations such as `src/lib/components`, `src/lib/types`, and `src/routes/api` when they exist.

## Tailwind v4 and shadcn-svelte

Applies when the project uses them: `@tailwindcss/vite` in `package.json`, `components.json` at the root.

- Tailwind v4 has no `tailwind.config`. Theme tokens live in `@theme` and shadcn-svelte's CSS variables in the entry CSS, usually `src/app.css`. Add or change a token there instead of hard-coding the value in a component.
- shadcn-svelte components are copied into the repo (the `ui` alias in `components.json`), not installed as a package. Upgrading the CLI or `bits-ui` does not change components already added: re-add a component through the CLI to pick up upstream changes, and review the diff against local edits.
- Add a primitive with the CLI (`pnpm dlx shadcn-svelte@latest add <component>`) before hand-writing one that shadcn-svelte ships. The CLI also installs what it depends on, such as `svelte-sonner` for toasts.
- Keep local edits to copied components small and deliberate, so a later re-add is a reviewable diff instead of a rewrite.
- `bits-ui` is the headless layer under the copied components. On a `bits-ui` major upgrade, re-add or check every copied component that imports it.

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
- In a new project: does `svelte.config.js` force runes mode, and does the `check` script use `--fail-on-warnings`?
- For an SPA served by another backend: does the build ship `_app/`, and does a miss under `_app/` return 404 rather than `index.html`?

## SvelteKit Anti-Patterns

- Fetching initial route data in `onMount` when it belongs in `load`.
- Putting secrets, cookies, privileged access, or auth-sensitive logic in universal or client code.
- Mutating server state through ad hoc browser fetches when a form action would preserve framework behavior.
- Forgetting invalidation, redirect, or returned action state after a mutation.
- Using browser globals during SSR or prerendering without guards.
- Packing route loading, mutation handling, and complex markup into one page component when local components or helpers would make ownership clearer.
