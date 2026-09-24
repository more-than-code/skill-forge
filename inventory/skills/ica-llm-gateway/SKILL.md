---
name: ica-llm-gateway
description: >
  Point a project, agent CLI, or app at LLMs hosted on the IBM Consulting
  Advantage (ICA) gateway on Service Essentials. Maps the machine's
  ICA_API_KEY and ICA_BASE_API_URL onto a project's own LLM_API_URL /
  LLM_API_KEY style variables, and covers the API host, the /v1 prefix each
  client appends, the User-Agent the edge requires, and model ids. Use when
  the target is ICA, Service Essentials, or servicesessentials.ibm.com —
  including a Codex model provider or Claude Code's ANTHROPIC_BASE_URL aimed
  at that gateway. Not for other gateways or proxies.
---

# ICA LLM gateway

IBM Consulting Advantage (ICA) is the model gateway. Service Essentials is the platform host. Completions go to the API host below. `https://servicesessentials.ibm.com` is the browser launchpad and does not serve the model API.

## API host

OpenAI-compatible root:

`https://api.servicesessentials.ibm.com/v1`

Catalog, Chat Completions, and Responses are `/models`, `/chat/completions`, and `/responses` under that root. Anthropic Messages is `/v1/messages` on the same host. This host has no `/ica` prefix. A path under `/ica/v1/` returns 404.

`https://api.nextgen-beta.ica.ibm.com/ica/v1` is the previous host. Keys are issued per host. A key accepted on one host is rejected by the other. Point new configuration at Service Essentials.

## Machine credential

One virtual key serves every model in the catalog (Claude, GPT, Gemini, Granite, Llama, Mistral, and the rest) on every wire. The machine keeps it in the user's shell rc, outside any repo:

```bash
export ICA_API_KEY=...            # Service Essentials virtual key
export ICA_BASE_API_URL=https://api.servicesessentials.ibm.com/v1
```

Never commit, log, or echo the key. When checking it is present, print its length, not its value.

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

## Clients

Use the base URL that matches the path the client appends.

| Client | Base URL | Credential |
| --- | --- | --- |
| OpenAI SDK (Chat Completions or Responses) | `https://api.servicesessentials.ibm.com/v1` | Bearer token |
| Codex | same root, `wire_api = "responses"` | `env_key` names the exported variable |
| Anthropic SDK / Claude Code (appends `/v1/messages`) | `https://api.servicesessentials.ibm.com` | Bearer or `x-api-key`; both are accepted |

Codex provider (root keys such as `approval_policy` go above the table; see `codex-config-toml`):

```toml
model_provider = "ica"

[model_providers.ica]
name = "ICA"
base_url = "https://api.servicesessentials.ibm.com/v1"
wire_api = "responses"
env_key = "ICA_API_KEY"
```

Claude Code reaches this gateway through the environment. Set `ANTHROPIC_BASE_URL` to the host with no `/v1`, and set exactly one of `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`) or `ANTHROPIC_API_KEY` (sent as `x-api-key`) to the virtual key. Setting both makes the CLI warn about conflicting auth. The catalog carries undated Claude ids such as `claude-sonnet-5`, `claude-opus-5-5`, and `claude-haiku-4-5`. A dated id such as `claude-haiku-4-5-20251001` returns 403 (checked 2026-09), so set `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5`, and pin `ANTHROPIC_MODEL` or `ANTHROPIC_DEFAULT_{OPUS,SONNET}_MODEL` whenever a default id is missing from the catalog.

## User-Agent

The edge rejects some default runtime User-Agents with Cloudflare 403 error 1010. Python's `urllib` default (`Python-urllib/3.x`) is rejected; the defaults of curl, `requests`, the OpenAI SDK, and Node were accepted (checked 2026-09). Send a `User-Agent` that names the calling app whenever the client uses a stdlib HTTP stack:

- Python `urllib`: `Request(url, headers={"User-Agent": "<app>/<version>", ...})`.
- OpenAI SDK: `OpenAI(base_url=..., api_key=..., default_headers={"User-Agent": "<app>/<version>"})`.
- Codex: `http_headers = { "User-Agent" = "<app>/<version>" }` in the provider table.
- curl: `-A "<app>/<version>"`.

## Model

Pick the id from `GET /v1/models`, with the same bearer token and User-Agent. When the consuming repo has a model doc, that doc owns the id. Re-read the catalog when the doc and the gateway disagree. Record a rejected optional field, such as `temperature` or `reasoning_effort`, in that doc.

Reasoning models (for example Gemini flash and Nemotron) spend output tokens before answering. A small `max_tokens` returns `finish_reason: "length"` with no text; give them more room.

## Check

```bash
curl -sS -A "<app>/check" -H "Authorization: Bearer $ICA_API_KEY" "$ICA_BASE_API_URL/models"
```

A working setup returns 200 from the catalog and text from one short completion on the client's wire. A 404 whose path contains `/ica` means the old prefix was added to the Service Essentials host.

`401` with `token_not_found_in_db` means the key is absent from that host's table. `401` that says remaining connection slots are reserved is pool exhaustion, not a bad key: retry with backoff.
