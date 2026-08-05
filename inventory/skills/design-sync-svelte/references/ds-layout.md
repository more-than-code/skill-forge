# The claude.ai/design DS-project layout and upload protocol

This is the format claude.ai/design consumes, reverse-engineered from the official
`/design-sync` skill (which states: "The upload format is the contract; the converter is
the deterministic path to it, not the only path" and "Off-script generation is
legitimate; off-script *verification* is not"). Produce this layout by any means; never
skip verification.

## Project layout

| Artifact | Consumed by | Notes |
|---|---|---|
| `_ds_bundle.js` | design agent runtime | IIFE assigning React components to `window.<globalName>`, first line `/* @ds-bundle: {…} */`. **Omit entirely for spec-style projects** — a broken or non-React bundle is worse than none. |
| `styles.css` | every rendered design | Root stylesheet. Designs receive ONLY its transitive `@import` closure (plus the JS bundle). Any CSS a design needs — tokens, fonts, component CSS — must be reachable from it via `@import`. A preview card linking a stylesheet directly proves nothing about designs. |
| `tokens/*.css` | designs (via styles.css) | Design tokens as CSS custom properties. `@import`ed from `styles.css`. |
| `fonts/` | designs (via styles.css) | Font files + `@font-face` rules reachable from `styles.css`. |
| `components/<group>/<Name>/<Name>.html` | humans in the component picker | Preview card. First line MUST be `<!-- @dsCard group="…" -->` — the app's self-check reads it to register the card. No marker, no card. |
| `components/<group>/<Name>/<Name>.prompt.md` | design agent | Usage reference: what the component is, how to compose it, real examples. |
| `components/<group>/<Name>/<Name>.d.ts` | design agent | API contract (`<Name>Props` interface). **Only emit when a real `_ds_bundle.js` ships** — a `.d.ts` without a bundle makes the agent import components that don't exist. |
| `guidelines/*.md` | design agent | Free-form guidance docs (uploaded, agent-visible). |
| `README.md` | design agent (inlined into its system prompt) | The conventions header goes here — see the SKILL.md conventions section. |
| `_ds_needs_recompile` | app self-check | Sentinel file, content `{"by":"<skill-name>"}`. Uploading it triggers the app's self-check on next project open (rebuilds card index / manifest, then clears it). |
| `_ds_sync.json` | future re-syncs | Content-hash anchor letting re-syncs skip unchanged components. **Omit it** — the official converter's hash recipe isn't reproducible here, and omission is the documented honest choice: the next sync simply re-verifies everything. |

The app's self-check regenerates the manifest, adherence config, and index from the
uploaded files — do not emit those yourself.

## Preview card shape

```html
<!-- @dsCard group="Buttons" -->
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="../../../styles.css">
  <style>/* card scaffolding only — centering, padding, variant grid */</style>
</head>
<body>
  <!-- the component, ideally in several representative variants/states -->
</body>
</html>
```

Relative paths: cards live three levels deep, so root files are `../../../styles.css`.
Show real variants (primary/secondary, sizes, disabled) — the card is how humans judge
whether the sync can be trusted.

## Target project selection

Load the tool first if absent: `ToolSearch(query: "select:DesignSync")`.

**Auth preflight — do this before any build work.** `DesignSync` rides the user's
claude.ai login with design scopes; that access is granted outside this skill, so an
unauthorized session fails at the *upload*, after you've already spent minutes building
and verifying. Call `DesignSync(list_projects)` early — it's cheap and raises no
permission prompt — purely to confirm access. If any call fails with an authorization
error, **relay the tool's guidance to the user verbatim**: its message is
environment-aware (an interactive terminal names `/design-login`; headless sessions get
a path that works there), so paraphrasing it can send them somewhere that doesn't exist.
Wait for them to act, then retry. An empty project list is a normal first-sync result,
not an auth failure.

1. **Pinned**: config file has a `projectId` → `DesignSync(get_project)` to confirm it
   still exists and `type` is `PROJECT_TYPE_DESIGN_SYSTEM`; say which project you're
   syncing to. Re-ask only if gone or the user redirects.
2. **Fresh (first-sync default)**: `DesignSync(list_projects)` to pick a non-colliding
   name, confirm the name with the user, then `DesignSync(create_project)` (it raises
   its own permission prompt — if denied, stop and ask; never retry unasked).
   Pushing to a regular (non-design-system) project never converts it — the type is
   immutable at creation, so always verify before pushing.
3. **Re-adopt an existing project only on the user's explicit ask**, and warn in plain
   language that syncing may replace or remove files already in it.

**Record the `projectId` in the skill's config file the moment the target is settled**,
before anything uploads — a death later then repairs the SAME project instead of
creating a duplicate.

## Upload sequence (atomic — build and verify everything locally first)

1. Build the complete output dir (e.g. `ds-bundle/`) and finish all verification gates.
2. **Decide the direction first — this determines the globs, and getting it wrong
   destroys work that cannot be recovered from the repo.** `list_files` the project:

   - **Bootstrap** — the project is empty, or its `tokens/`/`guidelines/` were produced
     by a previous run of this skill. The repo is the source. Push everything:
     `["components/**", "tokens/**", "fonts/**", "guidelines/**", "styles.css", "README.md", "_ds_needs_recompile"]`

   - **Canon-upstream** — the project already holds hand-curated `tokens/**`,
     `guidelines/**`, or a `README.md` written by a designer. **The project is now
     upstream of the repo**, and those files are the source of record; the repo's
     equivalents are extracted copies of one client's implementation. Push only the
     preview surface:
     `["components/**", "styles.css", "fonts/**", "_ds_*"]`

   If you cannot tell which mode applies, **ask** — do not guess toward the broader
   glob. Read one token file: repo-extracted files usually say so in their header
   ("extracted from src/app.css"), curated ones read as a specification.

   **Deletes are the sharper edge.** Mirroring the write globs into `deletes` means a
   re-sync removes every remote path the local output dir no longer contains — so in
   canon-upstream mode, `deletes` covering `tokens/**` or `guidelines/**` wipes the
   canon even if you never write those paths. In canon-upstream mode, `deletes` must be
   restricted to `components/**` (for components genuinely dropped from the sync).

   This is not hypothetical: in the `tutored` workspace (2026-08-03) the push-side
   `ds-bundle/tokens/colors.css` still carried the header *"Authoritative copy is in
   `_ds_bundle.css`"* while the project's `tokens/colors.css` had become 34 light + 31
   dark hand-curated oklch values. Re-running this skill unmodified would have silently
   replaced the specification with one client's implementation, with no error and no
   diff anyone would look at.

   Then explain the approval in plain language (no tool jargon) and call
   `DesignSync(finalize_plan)` with `localDir` = the output dir. If the approval is
   denied, STOP — report the local output path and ask how to proceed; denial means the
   session can't approve, not that the arguments were wrong.
3. **Sentinel first**: `write_files` `_ds_needs_recompile` alone — it fences the app's
   machinery against consuming a half-uploaded state.
   **Its CONTENT is load-bearing: `{"by":"<skill-name>"}`.** Upload it with `localPath`
   pointing at the real file, never `data: ""`. An empty sentinel is silently accepted —
   `write_files` reports success and `list_files` shows the path — but the self-check
   never fires, so `_ds_manifest.json` is never rebuilt and **every uploaded card stays
   invisible in the Design System pane**. Observed 2026-08-03: 15 components uploaded
   correctly across four pushes, all present via `list_files`, and the pane still showed
   the 4 cards from a much older sync. Verify with `get_file` after writing it.
4. **Content writes**: `write_files` everything else with root-relative paths verbatim,
   using `localPath` (contents never enter context). Max 256 files per call — chunk and
   reuse the same `planId`. Batch binary-heavy dirs (fonts) into smaller chunks; on a
   500, halve the chunk size and retry.
5. **Deletes** (re-syncs only): `delete_files` every remote path under the content dirs
   that the fresh output dir no longer contains (`list_files` to diff). A not-found
   rejection is the only failure to continue past.
6. **Sentinel re-arm**: `write_files` `_ds_needs_recompile` again — this is what makes
   the app refresh its view next time the project opens.
7. `DesignSync(list_files)` to confirm the remote count matches, then report the
   project URL: `https://claude.ai/design/p/<projectId>`.

Any write/delete failure that retries don't clear: **STOP** — no sentinel re-arm.
A partially-uploaded project self-heals on the next full sync; pretending it's done
does not.

Keep file lists and manifests under the skill's config dir — never bare `/tmp` paths
where a stale list from another repo's sync uploads the wrong design system. Regenerate
the upload list from the live output dir immediately before upload.

## Re-syncs

Read the config + NOTES file first, rebuild the output dir from scratch (deterministic
output makes an unnecessary rebuild a no-op), re-verify previews whose source changed
(no `_ds_sync.json` anchor means when in doubt re-verify everything), then run the
upload sequence with the reconciliation deletes in step 5.
