# Skill showcases

A showcase presents one skill the way the landing page presents the product: what it is worth to
a team, how it works, the workflow, and a real run. The Site shows it on the skill's page
(`/skills/<name>`), above the install snippet and file list. A skill without one keeps the plain page.

## Where it lives

```
showcase/<skill>/
  showcase.json            # the four sections
  <name>.png|.jpg|.webp    # images showcase.json names, each at most 512 KB
```

The folder sits beside `inventory/`, not inside the skill, like `evals/<skill>/`: `sync` never
installs it and the lock never hashes it, so adding or changing a showcase needs no version bump.
Change it in the same PR as the skill whenever the skill's behaviour changes what it says.

`node bin/cli.js validate` checks every folder: the name is an installable registry skill,
`showcase.json` has exactly the fields below, every named image exists and is small enough, and the
folder holds no other files. The Site copies showcases when its catalog snapshot is refreshed
(`pnpm catalog`), so a showcase goes public with the next snapshot of `main`.

## showcase.json

| Field | Holds |
|---|---|
| `value` | Two lines: what the skill saves or wins for a team. Not its mechanics |
| `howItWorks.title` | The finding the diagram makes, as a sentence |
| `howItWorks.stages` | 2 to 6 boxes drawn left to right: `name`, 1 to 4 short `lines`, optional `accent: true` on the one box that matters most |
| `workflow` | 2 to 6 steps, in order, as the agent does them |
| `inAction` | 1 to 6 items, each with a `caption`, a `source` (what was run, where, and the date) and exactly one of: `image` (`file`, `alt`), `excerpt` (plain text output, newlines kept) or `swatches` (`name`, `hex` as `#RRGGBB`) |

Text is plain: no Markdown, HTML or links. The Site draws the diagram and swatches itself with its
own design tokens, so a showcase holds no SVG, CSS or script.

## Rules

These follow the `landing-page` skill's doctrine:

- **Facts only.** Every line traces to the skill's own text or to the run its `source` names.
  Nothing planned, no placeholder numbers, no usage or install counts until the platform records them.
- **Real samples from our own products only.** Runs on Skill Forge's own Site and repos, or on
  other products we make. Never show a third-party brand as if it used the skill. Anything made up
  is captioned "Illustrative".
- **No private data.** No customer, project, person, host or private repository names in images or
  excerpts; crop or trim them.
- **Before and after** images say which side is which in the image and name both in `source`.
- **Public only when shipped.** An image of unreleased work goes in only once the change it shows
  is merged where the Site's snapshot reads it.
