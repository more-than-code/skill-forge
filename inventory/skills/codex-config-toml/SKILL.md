---
name: codex-config-toml
description: >
  Gotchas and safe patterns for editing ~/.codex/config.toml (approval_policy,
  sandbox_mode, model_context_window, model catalog). Activate when changing
  Codex config, debugging approval prompts despite "full-auto"/"never", context
  window overrides not applying, or verifying config with doctor vs exec.
---

# Codex config.toml Gotchas

Use this skill whenever you edit `~/.codex/config.toml` or debug why a Codex
setting "is in the file" but does not take effect.

**Hard rule:** presence of a key in the file is not proof Codex applies it.
Confirm **effective** policy with the right verifier.

## Primary file

- User config: `~/.codex/config.toml` (`$CODEX_HOME/config.toml`)
- Optional catalog override: path in `model_catalog_json` (e.g. `~/.codex/model_catalog.json`)

## Gotcha 1 — TOML table placement (silent no-op)

Keys after a `[table]` header belong to **that table** until the next header.

```toml
# WRONG — nested under provider; Codex ignores these as root settings
[model_providers.ica]
name = "ICA OpenAI"
approval_policy = "never"
sandbox_mode = "workspace-write"

# RIGHT — top-level root keys, then the provider table
approval_policy = "never"
sandbox_mode = "workspace-write"

[model_providers.ica]
name = "ICA OpenAI"
```

**Failure mode:** doctor still shows `OnRequest` / default sandbox after an "edit".
**Root cause:** keys became `model_providers.<id>.approval_policy` etc.

**Before saving:** scan upward — is there an open `[...]` header that should not own this key?

## Gotcha 2 — Obsolete approval syntax

```toml
# DEAD / ignored on current Codex
[approval]
mode = "full-auto"
```

Use current root keys:

```toml
approval_policy = "never"          # untrusted | on-request | never
sandbox_mode = "workspace-write"   # read-only | workspace-write | danger-full-access
```

| Key | Controls |
|-----|----------|
| `approval_policy` | Whether Codex **prompts** |
| `sandbox_mode` | What commands **may** do (fs/network) |

`never` + restricted sandbox → escalations may **fail** instead of prompt.
`never` + `danger-full-access` → fewer blocks, higher risk (Option A).
`never` + `workspace-write` → no prompts, still sandboxed (Option B).

## Gotcha 3 — Context window needs catalog + config

```toml
model_context_window = 400000
model_auto_compact_token_limit = 330000
```

Codex clamps to catalog `max_context_window`. Stock `gpt-5.5` often advertises
~272k max → effective ~258k (× ~95%), so a bare `400000`/`1050000` override fails.

**Fix pattern:**

1. Set `model_context_window` and `model_auto_compact_token_limit` (compact **below** window).
2. Point `model_catalog_json` at a catalog that raises `context_window` / `max_context_window` for the active model (and custom slugs like `gpt-5.5-gus` if missing).
3. Verify usable window from a live session event (`model_context_window`), not only the number in config.

Rough usable ≈ `min(config, catalog max) * effective_context_window_percent / 100`.

## Gotcha 4 — False verification

| Check | Trap |
|-------|------|
| Grep for the key in `config.toml` | Misses TOML nesting |
| `codex exec` alone | Non-interactive often defaults to `approval: never` → false green |
| Assume `codex doctor` is wrong | Doctor often reflects **interactive** defaults correctly |
| Skip restart | Running CLI/app keeps old policy |

**Verification checklist (in order):**

1. **Structure:** root-level keys (not under `[model_providers.*]` or other tables).
2. **`codex doctor`:** approval policy + sandbox summary.
3. **Restart** Codex CLI/app sessions.
4. **Interactive** behavior (does it still prompt?).
5. Optional: session rollout / turn context for `approval_policy` and `sandbox_policy`.
6. Context: live `model_context_window` in session events after catalog change.

## Gotcha 5 — Approval vs sandbox composition

- Prompting stopped ≠ command will succeed.
- Podman sockets, network, paths outside workspace may still fail under `workspace-write`.
- Do not "fix" network needs by only flipping `approval_policy`; adjust `sandbox_mode` deliberately.

## Safe edit workflow

1. Read full relevant section of `config.toml` (including nearby `[table]` headers).
2. Place new **root** keys with other top-level keys (model, provider name, approval, sandbox, context) **before** first section that should not own them.
3. Prefer current key names from Codex docs / doctor.
4. Run `codex doctor` (and for context, a short session that emits `model_context_window`).
5. Tell the user to restart open Codex sessions.
6. Do not claim success from `exec` alone when the issue was interactive approvals.

## Anti-patterns

| Wrong | Right |
|-------|--------|
| Put `approval_policy` under `[model_providers.x]` | Top-level before provider tables |
| Rely on `[approval] mode = "full-auto"` | `approval_policy` + `sandbox_mode` |
| Set only `model_context_window` for gpt-5.5-class | Catalog max + window + compact |
| Trust `codex exec` approval banner only | Doctor + interactive + structure |
| Blame doctor when OnRequest after edit | Re-check TOML nesting first |

## One-line memory

**Wrong TOML table = silent no-op. Verify structure, then doctor, then interactive — not file text alone.**
