---
name: ica-llm-gateway
description: >
  Point a project, agent CLI, or app at LLMs hosted on the IBM Consulting
  Advantage (ICA) gateway on Service Essentials. Maps the machine's
  ICA_API_KEY and ICA_BASE_API_URL onto a project's own LLM_API_URL /
  LLM_API_KEY style variables, and covers the API host, the /v1 prefix each
  client appends, the User-Agent the edge requires, model ids, and the Claude
  Code and Codex model pickers. Ships scripts/probe.py, which records this
  key's catalog and per-model behaviour under ~/.ica-llm. Use when the target
  is ICA, Service Essentials, or servicesessentials.ibm.com — including a
  Codex model provider or Claude Code's ANTHROPIC_BASE_URL aimed at that
  gateway — or when choosing a model id or parameter for it. Not for other
  gateways or proxies.
---

# ICA LLM gateway

IBM Consulting Advantage (ICA) is the model gateway. Service Essentials is the platform host. Completions go to the API host below. `https://servicesessentials.ibm.com` is the browser launchpad and does not serve the model API.

## API host

OpenAI-compatible root:

`https://api.servicesessentials.ibm.com/v1`

Catalog, Chat Completions, and Responses are `/models`, `/chat/completions`, and `/responses` under that root. Anthropic Messages is `/v1/messages` on the same host. This host has no `/ica` prefix. A path under `/ica/v1/` returns 404.

`https://api.nextgen-beta.ica.ibm.com/ica/v1` is the previous host. Keys are issued per host. A key accepted on one host is rejected by the other. Point new configuration at Service Essentials.

## Machine credential

One virtual key serves the catalog on every wire. The machine keeps it in the user's shell rc, outside any repo:

```bash
export ICA_API_KEY=...            # Service Essentials virtual key
export ICA_BASE_API_URL=https://api.servicesessentials.ibm.com/v1
```

Never commit, log, or echo the key. When checking it is present, print its length, not its value.

**Access is per key, not per gateway.** Each virtual key belongs to a team with its own model allowlist. `403 team not allowed to access model` means this key's team lacks that id — not that the model is down, and not that another key would fail. That is why probe results live on the machine that holds the key (see *Probe data*).

## Project variables

A project reads its own generic names, such as `LLM_API_URL`, `LLM_API_KEY`, and `LLM_MODEL`, so its code stays gateway-neutral. Map them from the machine variables at launch; the project stores references, never the value.

- Shell or direnv `.envrc` (safe to commit, it holds no secret):

  ```bash
  export LLM_API_URL="$ICA_BASE_API_URL"
  export LLM_API_KEY="$ICA_API_KEY"
  export LLM_MODEL=gpt-5.4
  ```

- `.env` files: commit only a `.env.example` listing the names. `${VAR}` expansion inside `.env` depends on the loader (python-dotenv expands it; Node `dotenv` needs `dotenv-expand`), so confirm the loader before relying on it.
- `LLM_API_URL` includes `/v1`. A client that appends `/v1` itself (Anthropic SDKs, Claude Code) takes the host without it.
- A project that reads only its own names ignores `ICA_*` entirely. Exporting `ICA_*` alone then changes nothing and the project keeps its default provider, silently. Check the project's env loader before assuming the mapping happened.

## Clients

Use the base URL that matches the path the client appends.

| Client | Base URL | Credential |
| --- | --- | --- |
| OpenAI SDK (Chat Completions or Responses) | `https://api.servicesessentials.ibm.com/v1` | Bearer token |
| Codex | same root, `wire_api = "responses"` | `env_key` names the exported variable |
| Anthropic SDK / Claude Code (appends `/v1/messages`) | `https://api.servicesessentials.ibm.com` | Bearer or `x-api-key`; both are accepted |

### Codex

Codex provider (root keys such as `approval_policy` go above the provider table):

```toml
model_provider = "ica"

[model_providers.ica]
name = "ICA"
base_url = "https://api.servicesessentials.ibm.com/v1"
wire_api = "responses"
env_key = "ICA_API_KEY"
```

- **The `/model` picker reads a local file, not the gateway.** `model_catalog_json` (for example `~/.codex/model_catalog.json`) lists what `/model` offers. `codex -m <id>` and `config.toml` `model =` bypass it and pass the id straight through, which is why an id can run yet never appear in the picker, and why a stale entry 404s. Prune entries the gateway catalog no longer lists.
- **Catalog entries carry functional switches** (`use_responses_lite`, `tool_mode`, `apply_patch_tool_type`), not just display text. Wrong values degrade tool calling silently. Build a new entry from a template of the same wire shape and verify it with a real tool-using task, never a text-only reply.
- Observed with `codex-cli 0.150.1` (2026-08-29): inline `[profiles.X]` tables are rejected; put each profile in `~/.codex/X.config.toml`.
- Observed 2026-07-19: Codex multi-agent capped at 6 open subagent threads on this gateway (`agent thread limit reached`). That is a Codex orchestrator limit, not a gateway RPM/TPM figure.
- The Responses wire is not limited to GPT ids: Claude ids answered on `/v1/responses` too (observed 2026-09-21).

### Claude Code

Claude Code reaches this gateway through the environment. Set `ANTHROPIC_BASE_URL` to the host with no `/v1`, and set exactly one of `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`) or `ANTHROPIC_API_KEY` (sent as `x-api-key`) to the virtual key. Setting both makes the CLI warn about conflicting auth.

- **The `/model` picker is compiled into the binary.** It never reads `ANTHROPIC_BASE_URL`, so ids the gateway adds do not appear, and compiled-in ids the gateway lacks still appear and fail. Observed 2026-09-26: a compiled-in `claude-opus-4-7` returned 403 here, and the new `claude-opus-5-5` was absent from the picker. Probe the client's defaults with `probe.py --extra-ids`.
- **Choose the override by what it replaces.**
  - `ANTHROPIC_DEFAULT_OPUS_MODEL` (likewise `_SONNET_`, `_HAIKU_`) swaps the id inside a tier. The picker keeps working and the client still appends its own suffixes: observed 2026-09-26, `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5` ran as `claude-opus-5-5[1m]`.
  - `ANTHROPIC_MODEL` or `--model` replaces the whole resolved id for that session.
  - An id the client does not know logs `[claude-code:unrecognized_model]` and still runs. The client has no metadata card for it, so cost reporting has no rate.
- **Dated ids.** The catalog carries undated Claude ids such as `claude-sonnet-5` and `claude-haiku-4-5`. A dated id such as `claude-haiku-4-5-20251001`, which the client uses for background tasks, returned 403 (checked 2026-09), so set `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5`.
- **Where to set them.** The `env` block of `~/.claude/settings.json` scopes the overrides to Claude Code. The shell rc also changes every other Anthropic SDK consumer on the machine. The resolved model is fixed at session start; restart to pick up a change.

## User-Agent

The edge rejects some default runtime User-Agents with Cloudflare 403 error 1010. Python's `urllib` default (`Python-urllib/3.x`) is rejected; the defaults of curl, `requests`, the OpenAI SDK, and Node were accepted (checked 2026-09). Send a `User-Agent` that names the calling app whenever the client uses a stdlib HTTP stack:

- Python `urllib`: `Request(url, headers={"User-Agent": "<app>/<version>", ...})`.
- OpenAI SDK: `OpenAI(base_url=..., api_key=..., default_headers={"User-Agent": "<app>/<version>"})`.
- Codex: `http_headers = { "User-Agent" = "<app>/<version>" }` in the provider table.
- curl: `-A "<app>/<version>"`.

## Model

**Where each fact lives.** A consuming project records the id it chose and why. What the gateway accepts for each id — catalog membership, reachability, which parameters it rejects — is observed data about this key, not project knowledge and not doctrine. Record it with `scripts/probe.py` under `~/.ica-llm`, never in a repo. A project must not read that data at runtime or in tests; a rule its code depends on belongs in its own code and tests.

Pick an id from the latest `SUMMARY.md`, or from `GET /v1/models` with the same bearer token and User-Agent. Catalog entries report `owned_by: "openai"` and a placeholder `created` for every model, so those fields carry no vendor signal.

**Input modalities come from vendor docs, not the catalog.** Every catalog model outputs text only, so speech synthesis and video generation need a different service. Vendor documentation (checked 2026-07-20) by family: Claude and GPT-5 take text and image (GPT handles PDF through a separate file flow); Gemini Flash takes text, image, audio, and video; Llama 4 Maverick takes text and image; Granite 4 H Small is text only; Gemma 4 26B takes text and image, with audio and video unconfirmed for that size. A documented modality can still be refused on the chat route (see *Advertised is not reachable* below), and video input was not accepted on the OpenAI-compatible route, so send extracted frames as images.

### Known trap classes

These are mechanisms. The examples are dated observations; probe before relying on any of them.

- **Rejected `temperature`.** Several recent models accept only the default. Read who wrote the error: `litellm.UnsupportedParamsError` is the proxy's own rule, while an `OpenAIException` relayed through `litellm.BadRequestError` comes from the vendor, so the limit follows the model to the vendor's direct API too. Observed 2026-09-26: `gpt-5.6-*` rejected `temperature=0` with an upstream `OpenAIException`. Omit the field unless the call site gates it per id.
- **`reasoning_effort` varies by model.** Each model accepts a different subset, and omitting the parameter is the only choice valid everywhere. Observed 2026-09-26 with tools, across 23 ids: some reject `none` (400), others reject `xhigh` (400, or 500 from Gemini Flash), a few reject every value, and `gpt-5.6-*` and `claude-opus-5-5` accepted all five.
- **Reasoning budget.** Reasoning models spend output tokens before answering. A small `max_tokens` returns `finish_reason: "length"` with no text, or 200 with `finish_reason: "stop"` and no tool call. Neither means "unsupported"; retry with a budget near 4000.
- **Transient image 400.** Vision calls occasionally 400 an image and accept the identical request on retry. The wording is per provider (Claude `Could not process image`, Gemini `Unable to process input image. Please retry`). SDKs treat 400 as non-retryable, so a caller that wants the retry must match the wording itself.
- **Advertised is not reachable.** Some catalog models reject non-text input on the chat route (`Use 'watsonx_text' route instead`).
- **Transient 401.** A 401 that says remaining connection slots are reserved is pool exhaustion, not a bad key: retry with backoff. It is intermittent; a 2026-09-26 run of ~70 requests saw none.

## Probe data

`scripts/probe.py` (stdlib Python, next to this file) records what this machine's key can use. Resolve this skill's directory from wherever this `SKILL.md` was loaded, then run:

```bash
python3 <skill-dir>/scripts/probe.py                    # catalog + text / temperature=0 / tools for every id
python3 <skill-dir>/scripts/probe.py --effort           # also the reasoning_effort matrix with tools
python3 <skill-dir>/scripts/probe.py --models a,b       # re-probe some ids; merges into today's file
python3 <skill-dir>/scripts/probe.py --extra-ids x,y    # ids a client uses that the catalog lacks
python3 <skill-dir>/scripts/probe.py --catalog-only     # just the catalog snapshot
```

It writes to `$ICA_LLM_DIR` (default `~/.ica-llm`), mode 700/600:

| Path | Contents |
| --- | --- |
| `catalog/YYYY-MM-DD.json` | ids from `GET /models`, one file per day; history is the file list |
| `probes/YYYY-MM-DD.json` | per-id results; later runs the same day merge in |
| `SUMMARY.md` | catalog diff against the previous snapshot plus the probe table; regenerated every run |

Read `SUMMARY.md` first. Re-probe when it is more than about two weeks old, when a project's recorded model and the gateway disagree, or before depending on a parameter for a new integration. "not probed" in the table means the check was not run, not that it failed. The script never writes the key and trims error bodies to one short line.

## Check

```bash
curl -sS -A "<app>/check" -H "Authorization: Bearer $ICA_API_KEY" "$ICA_BASE_API_URL/models"
```

A working setup returns 200 from the catalog and text from one short completion on the client's wire. A 404 whose path contains `/ica` means the old prefix was added to the Service Essentials host.

`401` with `token_not_found_in_db` means the key is absent from that host's table. `401` that says remaining connection slots are reserved is pool exhaustion, not a bad key: retry with backoff.
