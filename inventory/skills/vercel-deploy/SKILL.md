---
name: vercel-deploy
description: >
  Deploy a Node app with the Vercel CLI. Covers the working directory, the
  framework preset, the function region versus the build region, env secrets,
  redeploying after an env change, Deployment Protection between projects, and
  a custom domain that keeps its existing nameservers. Use when deploying or
  changing a Vercel project, attaching a domain, or debugging a function that
  builds in one region and runs in another.
---

# Vercel deploy

Run `npx vercel` from the app directory. Do not install the CLI globally. A command whose working directory is a different repo uploads that repo.

Read `npx vercel <command> --help` when a flag is rejected. The mechanism below is stable; the flag spelling is not.

## Before the first deploy

Link only inside the app directory:

```bash
npx vercel link --yes --project <name> --scope <scope>
```

Set the framework preset to the framework the app is (`sveltekit`, `fastify`, and so on) before the first production deploy. A project left on Other builds as a generic output or as files under `api/`, and a real server entry is then rejected.

Confirm the function region. The build machine region is not the runtime region. Read the runtime region from the response header `x-vercel-id` or from `vercel inspect` (the output format varies by CLI version). Pin it in `vercel.json` `regions` or in the framework adapter. Do not assume the platform default.

## Framework entry

- SvelteKit: pin the adapter major to the Kit major already in the repo; a mismatch crashed at runtime (seen on one project, 2026-10-04; check the adapter's release notes for your pairing). The adapter sets the function runtime and region. The project Node version is the build image. On that project the adapter served the Web request directly, so the Node adapter's body-size limit did not apply; confirm this for your version.
- Fastify zero-config, as observed on one project and not verified against the current docs, selects the first file that imports the `fastify` package. The search preferred `src/app.ts` over `src/server.ts`. A factory file named `src/app.ts` was taken as the function and failed unless its default export was a server. Name the factory something else, and import `fastify` from the real entry.
- A `vercel.json` `functions` pattern applies to files under `api/`. A pattern for `src/server.ts` fails the build even after the framework preset is correct. Seen on one project, 2026-10-04: that pattern was rejected, and the plan's own duration cap already applied, so the key could not raise the duration. Confirm the current plan cap in the plan docs. Remove a `functions` key that does not match a file under `api/`.

## Environment

Add a secret on stdin with `--sensitive`. Do not pass it with `--value`, and do not print it.

```bash
printf '%s' "$SECRET" | npx vercel env add SECRET production,preview --sensitive
```

A public value (an origin, a model id) is config, not a secret:

```bash
npx vercel env add PUBLIC_ORIGIN production,preview --value 'https://<host>' --no-sensitive
```

Set both Production and Preview unless the user asked for one. `vercel env ls` shows encrypted or hidden values. That confirms the name exists.

A new or changed variable applies to the next deployment. Redeploy production after changing it. The running deployment keeps the previous snapshot.

On the CLI version seen (2026-10-04), `vercel link` wrote `.vercel/` and `.env.local` (an OIDC token) and appended `.vercel` and `.env*` to `.gitignore`; check what yours wrote. An `.env*` line after `!.env.example` ignores the example again. Keep the token untracked. Do not commit `.env.local`. Delete the appended lines when they undo an existing negation.

## Calling another Vercel project

Deployment Protection on the callee returns a login wall to a server-side fetch and to a phone that is not signed in to Vercel. `all_except_custom_domains` was seen to still protect the `*.vercel.app` host. Disabling SSO on the callee weakens its protection, so ask the user first, and only when that host must answer before a custom domain exists. Re-enable it once the custom domain works, and leave Git fork protection on.

## Custom domain, existing nameservers

Leave the nameservers where they are when the zone already lives at another DNS host.

1. `vercel domains add <domain> <project>`.
2. `vercel domains inspect <domain>` prints one recommendation. `vercel domains verify <domain>` prints the records this project requires. Those two have been seen to disagree. Write the verify records.
3. An apex cannot be a CNAME. Use the A records from the domain card. A subdomain is usually a CNAME to the host the card names. That host is specific to the project. It is not a stable public constant.
4. Seen on one project, 2026-10-04: inspect recommended one anycast address, the app answered on it, and verify then required a different address set and a project-specific CNAME. The first address was the wrong long-term record.
5. Confirm with `vercel domains verify` reporting a valid configuration, and with a request whose runtime header shows the pinned region.

## Checks

- The production alias, not only the deployment URL.
- The runtime region, from the response header or from inspect.
- A path that proves the app, not only the platform default page.
- After an env change, the new deployment's logs show the new value in effect.

## Leave alone unless asked

- A Git connection. Do not import a repo or run `vercel git connect`.
- Nameservers.
- `.vercel/` and `.env.local` in git.
