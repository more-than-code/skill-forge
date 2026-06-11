---
name: skill-authoring-guide
version: 0.1.0
description: Guidelines and best practices for creating, naming, and structuring new skills in the registry.
---

# Skill Authoring Guide

This skill provides the specifications and best practices for contributing new skills to the `skill-forge` registry.

## Naming Conventions

Skill names must be **specific** and **descriptive**. Avoid generic terms that could apply to multiple technologies or contexts.

### 1. Structure
Use `kebab-case` for all skill directory names.

### 2. Specificity Rule
A skill name should ideally compose of **Context/Technology** + **Capability/Action**.

| Bad (Generic) | Good (Specific) | Why? |
| :--- | :--- | :--- |
| `api` | `olilo-backend-api` | Specifies *which* API. |
| `guidelines` | `sveltekit-development-standards` | Specifies *framework* and strictness. |
| `inspect` | `page-render-inspector` | Specifies *what* is being inspected. |
| `documentation` | `agent-instruction-spec` | Specifies the *type* of documentation. |

### 3. Action-Oriented
If a skill performs a task, use a noun-verb or verb-noun phrase that describes the outcome (e.g., `inspector`, `setup`, `migration`).

## File Structure

Each skill must reside in its own directory under `inventory/shared/`, `inventory/project/`, or `inventory/system/` and contain at minimum a `SKILL.md` file.

```text
inventory/
└── project/
    └── my-specific-skill/
        ├── SKILL.md          # Required: Manifest and main documentation
        ├── specific_script.js # Optional: Supporting scripts
        └── templates/         # Optional: Boilerplate code
```

## SKILL.md format

The `SKILL.md` file serves as the manifest. It must start with YAML frontmatter.

```markdown
---
name: my-specific-skill
version: 0.1.0
description: A one-sentence summary of what this skill does or provides.
---

# Skill Title

## When to use
Briefly explain the scenario where an agent or developer should install this skill.

## Prerequisites
List any required dependencies (e.g., text, software versions).
```

## Best Practices

1.  **Modularity**: Skills should be self-contained. Avoid dependencies on other skills if possible.
2.  **Immutability**: Assume the user will install this into their project. Don't rely on files remaining in the `skill-forge` source directory.
3.  **"Content as Code"**: Everything needed to run the skill should be inside the skill's folder.
