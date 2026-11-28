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
| `value` | About two lines (at most 400 characters): what the skill saves or wins for a team. Not its mechanics |
| `howItWorks.title` | The finding the diagram makes, as a sentence (at most 120 characters) |
| `howItWorks.stages` | 2 to 4 boxes drawn left to right: `name` (at most 18 characters), 1 to 4 `lines` (at most 26 each), optional `accent: true` on at most one box, the one that matters most |
| `workflow` | 2 to 6 steps (at most 200 characters each), in order, as the skill's own text lays them out |
| `inAction` | 1 to 6 items, each with a `caption` (at most 300 characters), a `source` (at most 200: what was run, on which commit, and the date) and exactly one of: `image` (`file`, `alt`), `excerpt` (at most 1500 characters, newlines kept: the tool's output as printed, or say in the caption that it is a summary) or `swatches` (`name` of at most 10 characters, `hex` as `#RRGGBB`) |

All text is shown as plain text: Markdown, HTML and links appear literally, so leave them out. The Site draws the diagram and swatches itself with its
own design tokens, so a showcase holds no SVG, CSS or script. SVG text does not wrap, which is why
the box and swatch lengths are capped. Images must be real PNG, JPEG or WebP files, not links.

## Rules

These follow the `landing-page` skill's doctrine:

- **Facts only.** Every line traces to the skill's own text or to the run its `source` names.
  Nothing planned, no placeholder numbers, no usage or install counts until the platform records them.
- **Real samples from our own products only.** Runs on Skill Forge's own Site and repos, or on
  other products we make. Never show a third-party brand as if it used the skill. Anything made up
  is captioned "Illustrative".
- **No private data.** No customer, project, person, host or private repository names in images or
  excerpts; crop or trim them.
- **Before and after** images say which side is which in the image, the caption and the alt text, and
  `source` names the commit of each side (not "the live site" or a branch, which move).
- **Public only when shipped.** An image of unreleased work goes in only once the change it shows
  is merged where the Site's snapshot reads it.
