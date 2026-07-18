# Skill Forge CLI — examples

Assume cwd is the skill-forge repo root and `skf` is on PATH (or use `node bin/cli.js`).

## Create from stdin

```bash
skf skill write demo-skill --set-version 0.1.0 --tags demo --json <<'EOF'
---
name: demo-skill
description: Demo skill for CLI recipes.
---

# Demo Skill

Instructions go here.
EOF
```

## Update body, then bump patch

```bash
skf skill write demo-skill --json <<'EOF'
---
name: demo-skill
description: Demo skill for CLI recipes.
---

# Demo Skill

Updated body.
EOF

skf skill bump demo-skill --json
# → previousVersion/version e.g. 0.1.0 → 0.1.1
```

## Add companion without rewriting SKILL.md

```bash
printf 'Example A\n' > /tmp/demo-examples.md
skf skill write demo-skill --skip-skill-md \
  --file EXAMPLES.md=/tmp/demo-examples.md --json
```

## Remove a companion

```bash
skf skill write demo-skill --skip-skill-md --remove-file EXAMPLES.md --json
```

## Set exact version

```bash
skf skill set-version demo-skill 0.2.0 --json
```

## Read for agent editing

```bash
skf skill read demo-skill --json
# Use .body and .companions["EXAMPLES.md"] etc.
```

## Partial failure recovery

```bash
# After a failed write with partial:true (multi-file tree may be inconsistent):
skf skill read demo-skill --json
# Fix local sources, then re-issue full write:
skf skill write demo-skill --json --file SKILL.md=/tmp/fixed.md --file EXAMPLES.md=/tmp/ex.md
skf validate

# After set-version/bump with partial:true: version already changed — fix validate
# errors (often an unrelated broken skill), do not blindly re-write content:
skf validate
# fix the reported registry/skill issues, then:
skf validate
```

## Install to a tool runtime (non-interactive)

```bash
# --yes alone is not enough: without --path the CLI prompts for Target path and hangs.
skf install demo-skill --type skill --target codex --path ~/.codex/skills --yes
skf install demo-skill --type skill --target claude-code --path ~/.claude/skills --yes
skf install demo-skill --type skill --target grok --path ~/.grok/skills --yes
```

## Delete

```bash
skf skill delete demo-skill --yes --json
```
