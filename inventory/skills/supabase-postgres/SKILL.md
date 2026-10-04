---
name: supabase-postgres
description: >
  Use a Supabase project as ordinary Postgres from an app that already has its
  own sessions. Covers the transaction and session poolers, the TLS
  certificate-verification trade-off, one connection per function, and why a Vercel
  Marketplace install does not attach an existing database. Use when connecting
  pg, Drizzle, or another Postgres client to Supabase, or when choosing
  Marketplace versus a project created in Supabase.
---

# Supabase Postgres

The app connects with a normal Postgres client. Supabase Auth, the Data API, and the generated client keys are a different product. Leave them off when sign-in is already an application cookie.

For the function host, env, and custom domain, use the `vercel-deploy` skill.

## Which host

Read the pooler config for the project. Do not invent the host. The ports, host form and user format below were seen on 2026-10-04 and Supabase has changed such details before, so the project's own pooler config wins.

- Transaction pooler, port 6543: application traffic from short-lived functions. As observed, it does not support named prepared statements, session state, LISTEN/NOTIFY, or query pipelining. Send unnamed queries. Drizzle does that by default.
- Session pooler, same host, port 5432: migrations and seeds. It is the IPv4 path. The direct host `db.<project-ref>.supabase.co` is IPv6-only on many networks unless the project has an IPv4 add-on, which depends on plan; check the dashboard.
- The user is `postgres.<project-ref>` and the database is `postgres`, unless the pooler config says otherwise.
- Open one connection per function process (pool max 1). The pooler holds the real sessions. A long-lived local process may keep a higher pool.

## TLS

`sslmode=require` encrypts and does not verify the server certificate, so it gives no server authentication: an attacker on the network path would not be detected. Treat it as a documented compromise, not a default. Prefer `verify-full` with the CA bundle Supabase publishes wherever the deployment can supply one.

The compromise exists because the pooler chain was not in Node's public trust store when observed (2026-10-04; re-check). `require` implemented as `rejectUnauthorized: true` failed with `SELF_SIGNED_CERT_IN_CHAIN`.

In `node-postgres`:

- `disable` returns no SSL. Local only.
- `require` returns `{ rejectUnauthorized: false }`: encrypted, not authenticated.
- `verify-full` uses a CA bundle the deployment supplies. Anything else is refused.

Log host, port, user, database, ssl mode, and whether a password is present. Do not log the password.

## Marketplace versus a project you create

Creating Supabase from the Vercel Marketplace does not attach an existing project. It creates a new empty database in a new organization.

Confirm the current Marketplace terms before relying on the lock; these are volatile. As documented when observed (2026-10-04), and to be verified against the current docs:

- One Supabase organization is bound to the whole Vercel team, not to one Vercel project.
- Projects in that organization are created from the Vercel dashboard.
- Owners follow Vercel roles. The invoice is the Vercel invoice.
- Uninstalling the integration removes the organization.
- A custom domain on the Supabase URL is unsupported.
- Moving an existing Supabase-managed project into that organization is unsupported. The other direction is supported.

Create the project in Supabase when the app already has a database, uses its own auth, or the invoice should stay on the Supabase account. The connection is still public TLS either way. Plan allowances were seen to match; confirm for your plan. File-storage quota is not Postgres disk. Bytes stored in table columns count toward disk.

## CLI and migrations

Use `npx supabase`. Do not install it globally.

In one case (2026-10-04), a project-scoped token ran the database query API for its project and still failed `projects list` because it lacked `projects_read`. That failure does not mean the token is useless. Do not paste the token into the chat or onto a command line that is logged.

Before running migrations or seeds, confirm the target project ref with the user and that it is not a production database they did not intend. Run them through the session pooler. If the migration script loads an env file from a previous database, export the new host, port, user, database, and TLS mode, then run the script without that file. A variable the process already has must win over the file. Do not reuse the previous database's password.

Apply each migration the way the app already records applied versions. Do not reapply a version that is already recorded.

## Checks

- The process reaches listen only after a successful `select 1`, or an equivalent query.
- TLS outside local is `verify-full` where a CA bundle is available; otherwise `require`, recorded as a compromise (encrypted, not authenticated).
- Auth, public buckets, and the Data API stay off when the app does not use them.
- A Marketplace project ref is a different ref from the database the app already uses.

## Leave alone unless asked

- Auth, the Data API, and public buckets.
- A Marketplace install when an existing project is the database.
- The database password in `--value`, in the repo, or in logs.
