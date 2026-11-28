---
name: landing-page
description: >
  Create or refresh a product's public landing page (the Site) so it sells the
  product's business value, demonstrates rather than describes, stays true to the code
  that ships today, and belongs to the owner's family of sibling sites without copying
  them. Covers inputs, the section order, the claims ledger, colour and contrast, gated
  wording, a separate site repo with previews, and visual checks before hand-off.
  Activate when building, redesigning or reviewing a landing or marketing page, or its
  comparison table.
---

# Landing Page

A repeatable process for a product's public landing page. Hosting, framework and design
tools vary per product; the doctrine and the checks below do not.

## Doctrine

1. **Business value first.** Open with what the product saves or wins for a team, not
   with features or mechanics.
2. **Demonstrate, don't describe.** Show each key point with a simple diagram, image or
   short animation. A point with no visual is a candidate for cutting.
3. **Don't overload.** A few key points, each about two lines plus a small visual. Cut
   repeated sections; put detail (full comparison tables, specs) lower down or behind an
   expander (`<details>`).
4. **Section order.**
   1. Value: what the team saves or wins, with simple diagrams.
   2. See it in action: one end-to-end walkthrough.
   3. Use cases: two or three short ones, limited to what ships today.
   4. Components: what the product is made of.
   5. Comparison: compact, with the full table behind an expander.
   6. Call to action.
5. **Siblings are references, not templates.** Learn principles from the owner's other
   product sites; keep this product's own logic, brand, colours and voice. Never mirror
   a sibling's layout or copy.
6. **Facts only.** Every claim matches what ships today on the product's default or
   integration branch. Planned work is marked "Planned, not built yet", or left out.
7. **Illustrative, never real.** Mocks are labelled "Illustrative interface" and use a
   made-up app and data. Real console screenshots leak customer, project and host names.
8. **One place per action.** No duplicate navigation or calls to action on one screen:
   - Header: section links plus a single persistent sign-in (if the product has one).
   - Hero: one primary action that the header does not carry, plus at most one secondary
     scroll link that the header also does not carry.
   - Closing band: may repeat the primary action; sign-in only as a small text link.
9. **No untrue legal claims.** No trademark, certification or compliance line without
   the registration or audit behind it.

Where the `role-product-design` skill is also loaded, its rules on claims, privacy in
visuals and audits apply too; this skill adds the landing-page procedure and does not
relax any of them.

## 1. Gather inputs before designing

- **Assets and past decisions:** logos, mocks, marketing visuals and design calls in the
  project's shared files, and the product's own tracked brand assets and design tokens.
- **Strategy in the owner's words:** who it is for, the wedge, what is current and what
  is planned. Ask when it is not written down.
- **The facts:** read the product's current default or integration branch, from the
  remote, for every claim you intend to make.

Start a **claims ledger** (in the PR description or a doc in the site repo): one row per
claim, with the file, test or doc on the product branch that proves it, or "planned".
A claim with no proof does not ship.

## 2. Look at sibling sites live

- Open each sibling site live in a browser, or read its remote repo at the latest commit.
  Never use a local checkout on someone's machine: it may be stale, and reading it needs
  permission.
- Read only. Never edit another product's site from this work.
- Ask the owner which sibling they consider the best reference. Write down the
  **principles** it gets right (clarity of the hero, rhythm, how it shows rather than
  tells), not its components to copy.

## 3. Post a short spec, then build

Before building, post a short spec for the owner: the value statement, the section list
with the visual planned for each, the comparison rows, the palette, and the open
questions. Then build in short rounds: one preview link per round, the owner's feedback,
the next round.

### Visuals and motion

- One open-licence icon set across the owner's family of sites, inlined as SVG, with its
  licence shipped in the site.
- Animation in CSS only, with a `prefers-reduced-motion` fallback. No client JavaScript
  unless the owner asks for it.
- Reuse the product's design tokens; when the site palette changes, keep the product's
  tokens in step (a separate PR in the product's repo, by that product's owner).

### Colour

- Do not rely on one brand colour. Define a palette: the primary plus secondary or
  complementary tints and variants, as tokens for light and dark themes.
- Colour carries meaning. Stages in a flow or cycle diagram each get their own related
  hue (for example cool to warm along the flow).
- Status labels use semantic colours, consistently across the page:
  - green: pass, done, attached
  - blue: info, reported, neutral facts
  - amber: waiting, in progress
  - red: failed, blocked, high severity
- Contrast meets WCAG AA (4.5:1 for body text) in both themes, including text on its
  tint and white text on stage fills. Check it with a tool, not by eye.

## 4. The comparison

- Compare against what the buyer already uses, not against an invented rival.
- Rows are buyer questions ("Can it fix the bug for me?"), not feature names.
- Each own-product cell is backed by the claims ledger. Each competitor cell is backed by
  the competitor's current public docs, with an "as of" date in the footnote.
- Planned work is marked planned, or left out; file the planned item in the product's
  tracker.
- Keep the visible table compact; the full table goes behind an expander. On phones,
  turn rows into cards (a `data-label` per cell) instead of horizontal scrolling.

## 5. Gate the wording

- Claims that depend on unreleased features sit behind a build flag, off by default.
- Guard tests fail the build when: gated wording appears with its flag off; a real
  customer, project, person or infrastructure name appears; a third-party URL appears
  that is not on an allowlist; client JavaScript appears where none is allowed; a legal
  claim the product cannot back appears.
- Mirror the page's claims in `llms.txt` (or the site's equivalent) and keep it under
  the same guards.

## 6. Site repo and hosting

These hold for any static host or framework:

- **Its own repo,** not a folder in the product repo. When moving an existing site out,
  split it with its history (for example `git subtree split`). The repo's `AGENTS.md`
  says: claims match the product branch, wording is gated, no client JavaScript (if
  that is the rule), PRs into the production branch, and merging publishes, so a merge
  needs the owner's OK.
- **CI checks, it never deploys:** check, build and the guard tests on every PR. The
  host's own Git integration deploys.
- **Production from the production branch; previews only for agent branch prefixes**
  (for example `claude/*`). Preview URLs are usually public to anyone with the link:
  say so, and keep unreleased wording behind its flag there too.
- **Owner-only steps:** granting the host's Git app access to the repo, creating or
  replacing the host project, and switching the custom domain. Switch the domain only on
  the owner's explicit yes, and keep the old deployment for rollback.

Example: on Cloudflare Pages this is a Git-connected Pages project (a new one replaces
an upload-only project), production branch `main`, preview branch control limited to the
agent prefixes. Other hosts (Vercel, Netlify, GitHub Pages, a static bucket) have the
same settings under other names.

## 7. Verify visually before hand-off

- Run the site's gates: type or template check with warnings as errors, build, guard
  tests. Report pass, fail and skip counts; skipped is not passed.
- Screenshots of every change: desktop light, desktop dark, phone full page
  (Playwright or the environment's browser).
- At phone width, `document.documentElement.scrollWidth` equals the viewport width:
  no horizontal scroll.
- Check the header and hero together for duplicate actions (doctrine 8).
- Remove CSS and components a restructure leaves unused.

## 8. Hand-off

Post the preview link and the screenshots (saved where the owner can open them), with
the claims ledger and the open items: domain switch, merge, the old site path to remove
from the product repo, and product token updates. Keep the PR open for the owner's
review.

## Checklist

- [ ] Value first; section order as in doctrine 4; each point has a visual
- [ ] Claims ledger complete; planned items marked or left out
- [ ] Siblings used for principles only, viewed live or from the remote
- [ ] Mocks labelled "Illustrative interface"; no real names
- [ ] One place per action; no unbacked legal claims
- [ ] Palette with semantic status colours; WCAG AA in light and dark
- [ ] Comparison rows are buyer questions, sourced and dated; full table behind an expander
- [ ] Guard tests for gated wording, names, URLs, JavaScript, legal claims
- [ ] CI never deploys; previews only for agent branches; domain switch on the owner's yes
- [ ] Gates run with counts; desktop light/dark and phone screenshots; no phone scroll
