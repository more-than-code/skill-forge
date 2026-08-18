---
name: grok-build-harness
description: >
  Harness for delegating a build to the locally installed Grok Build CLI (`grok`):
  capturing its output with streaming-json, the single-turn `-p` trap and driver
  loop, sandbox write boundaries that crash scaffolders and package installs,
  Imagine image/video tool usage, and self-contained brief structure. Activate when
  handing work to Grok, spawning `grok` headlessly, streaming or parsing grok
  output, tracking its cost, debugging a grok run that exits 0 having done nothing,
  generating images/video with image_gen / image_edit / image_to_video, or
  driving grok over ACP (`grok agent stdio` / `serve`).
---

# Grok Build Harness

Delegating a substantial build to the local **Grok Build** CLI (`grok`). Grok is a
capable agentic coder with image and video generation the host agent may lack — but
headless runs fail in specific, repeatable ways. This skill is that harness.

**Hard rule:** a `grok` run that exits **0 having written nothing is the normal
failure mode**, not a success. Verify artifacts, never the exit code.

This skill is the **transport** layer: how to spawn, observe, and resume `grok`. For the
surrounding method — when to hand a task to an external worker at all, how to brief it per
phase, and how to accept what comes back — activate `external-worker-delegation`.

## Preflight (always)

```bash
grok --version            # e.g. 0.2.102
grok models               # confirms login + available models
grok inspect              # skills, agents, permissions for THIS directory
```

`grok models` failing or printing a login prompt means the delegation cannot run —
the user must `grok login` themselves.

## Observing the run — always use `--output-format streaming-json`

Plain `-p` prints only the model's prose, **at exit**. It is not a progress signal and
it hides why the run stopped. Headless supports three formats; use the streaming one:

| Format | Emits | Use |
|--------|-------|-----|
| `plain` (default) | prose at exit | never, for delegation |
| `json` | one object at exit | scripted single-shot calls |
| `streaming-json` | newline-delimited events, live | **delegation** |

```bash
grok -p "…" --output-format streaming-json | tee run.jsonl
```

Event `type` values: `text` (response chunks), `thought` (reasoning), `end` (final),
`error`. Also `max_turns_reached` and `auto_compact_*` — the list is **not
exhaustive**, so switch on `type` and ignore unknowns.

The `end` event is the run's post-mortem, verified shape:

```json
{"type":"end","stopReason":"EndTurn","sessionId":"…","requestId":"…",
 "usage":{…},"num_turns":1,"total_cost_usd":0.039954,"modelUsage":{…}}
```

Read three fields every time:

- **`stopReason`** — why it stopped. This is the diagnosis (see Gotcha 1).
- **`num_turns`** — how much it actually did. `1` on a large brief means it barely started.
- **`total_cost_usd`** — accumulate across iterations; a driver loop spends real money.

**Caveat:** streaming-json has **no tool-call events** — you see narration and
reasoning, not file writes. (The ACP transport below *does* emit them; this is a
limitation of the headless format, not of Grok.) With `-p`, watch the filesystem:

```bash
find work/src work/static -type f -newer work/BRIEF.md | sort
```

## Gotcha 1 — `-p` is single-turn (the big one)

`grok -p "<prompt>"` runs **one** assistant turn. The model does a batch of tool
calls, ends its response intending to continue, and the process **exits 0 mid-plan**.
`--max-turns` does *not* change this — it bounds turns *within* a run.

**Failure mode:** run after run ends after a few minutes with a truncated narration
("Scaffolding next…", "Building the design system next…") and little or nothing on disk.
**Root cause:** single-turn semantics, misread as a crash or a permissions problem.

**The tell:** the `end` event reads `"stopReason":"EndTurn"` with a low `num_turns`
while the brief is plainly unfinished. That is a *clean, deliberate* stop — not a
crash, not a permission block, not a turn-limit hit (`max_turns_reached`). Check this
before debugging anything else; it collapses hours of misdiagnosis into one line.

**Fix — drive it with `--continue` until the deliverables exist:**

```bash
for i in $(seq 1 30); do
  grok -c -p "Continue executing BRIEF.md, resuming where you left off. \
Do not stop early; every deliverable must exist and be verified." \
    --sandbox workspace --permission-mode auto --max-turns 400 \
    --output-format streaming-json | tee -a run.jsonl
  [ ${pipestatus[1]:-${PIPESTATUS[0]}} -ne 0 ] && break
  [ -f NOTES.md ] && ls dist/*.out >/dev/null 2>&1 && break   # real completion markers
done
```

Rules for the loop:
- Break on **non-zero exit** so a broken run cannot spin.
- Test **artifacts on disk**, never the model's claim of doneness.
- `grok -c` resumes the most recent session *for that cwd*, so context carries over.
- One resumed iteration commonly runs 15–25 min and does enormous work. Budget for it.

## Gotcha 2 — the sandbox write boundary breaks package tooling

| Profile | FS read | FS write | Use |
|---------|---------|----------|-----|
| `workspace` | everywhere | CWD + `~/.grok` + `/tmp` + `/var/tmp` | default; recommended |
| `read-only` | everywhere | `~/.grok` + temp | exploration/review |
| `devbox` | everywhere | everywhere except `/data`, virtual fs | disposable VMs only |

`workspace` is kernel-enforced and makes auto-approval safe. But common toolchain
paths sit **outside** the writable set:

| Tool | Writes to | Result inside sandbox |
|------|-----------|-----------------------|
| npm / `npx` | `~/.npm` | cache write fails → scaffolder crashes |
| pnpm | `~/Library/pnpm` (macOS) | install fails |
| Playwright | `~/Library/Caches/ms-playwright` | browser download fails |

**Fix — do the environment work yourself, outside the sandbox, before spawning:**

1. Scaffold the project and install dependencies (also avoids interactive creators,
   which hang or crash headless).
2. Pre-install any browser/binary the run needs. Reads work everywhere, so Grok can
   execute what you installed.
3. Redirect caches on the spawn: `npm_config_cache=/tmp/... XDG_CACHE_HOME=/tmp/...`.
4. Tell Grok in the brief that this is done and it must not re-scaffold.

## Gotcha 3 — headless Chromium segfaults inside the sandbox

Playwright/Chromium crashes under the sandbox (keychain `SecItemCopyMatching` /
crashpad). Anything depending on headless capture — screenshots, HTML→PNG, frame
rendering for video — needs a fallback. Native rendering (e.g. Swift/AppKit on macOS)
works. State the fallback in the brief so Grok doesn't silently drop the deliverable.

## Gotcha 4 — native-toolchain builds may need a clean env

Rolldown/Vite-class native binaries can segfault under the agent's inherited
environment. Workaround Grok can use, and worth pre-authorizing in the brief:

```bash
env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/bin:/bin" pnpm build
```

Verify the build yourself afterwards in a normal shell — it usually passes there.

## Imagine — image and video generation

Grok exposes `image_gen`, `image_edit`, and (verify — the bundled `imagine` skill
warns it may be absent) `image_to_video` / `reference_to_video`. Instruct Grok to
**load the bundled `imagine` skill before its first generation**.

**The split that decides output quality:**

| Needs | Use |
|-------|-----|
| Only the *look* — scenes, characters, textures, atmosphere | `image_gen` / `image_edit` |
| Exact text, data, structure — UI mockups, wordmarks, charts, share images with copy | **code** (HTML/CSS rendered, or SVG) |

Image models garble words, invent numbers, and break layout; a longer prompt does not
fix it and an edit pass rarely does.

**Consistency:** for a recurring character or object, generate/choose **one base image**
and `image_edit` every variation from it. Never `image_gen` the same subject twice.
If production art already exists in the repo, **reuse it** — it beats generation for
identity fidelity.

**Video:** starts from an image (no text-to-video). Plan as **short shots** (6s or 10s),
stage frame 1 with `image_gen`/`image_edit`, animate with `image_to_video`, one simple
camera move per shot. Lock **every** shot — generated and code-rendered — to one
resolution and frame rate so assembly is lossless:

```bash
ffmpeg -f concat -safe 0 -i shots.txt -c copy out.mp4    # never re-encode
```

Expect transient **HTTP 429** on parallel generation calls; retry sequentially.

## Interactive delegation — `grok agent stdio` (ACP)

`-p` is fire-and-forget. For a back-channel, Grok also speaks **ACP** (Agent Client
Protocol) — JSON-RPC 2.0, newline-delimited, over stdio or WebSocket:

```bash
grok agent --always-approve stdio                                  # local
grok agent --always-approve serve --bind 127.0.0.1:2419 --secret X # WebSocket
```

**Verified handshake** (probed against 0.2.102, not merely read from docs):

1. `initialize` -> `{"protocolVersion":1}`
2. `session/new` `{cwd, mcpServers:[], _meta:{yoloMode:true}}` -> `sessionId`
3. `session/prompt` `{sessionId, prompt:[{type:"text",text:"..."}]}` -> `{stopReason:"end_turn"}`
4. Agent pushes `session/update` notifications throughout.

A trivial one-tool prompt produced **104** `session/update` notifications. Observed
`sessionUpdate` kinds:

| Kind | Why it matters |
|------|----------------|
| `tool_call`, `tool_call_update`, `tool_call_delta_chunk` | **what `-p` cannot give you** — live tool name, status, result |
| `agent_thought_chunk`, `agent_message_chunk` | reasoning + response text |
| `pending_interaction`, `interaction_resolved` | the **permission back-channel** |
| `turn_completed`, `response_completed`, `session_summary_generated` | turn lifecycle |
| `available_commands_update`, `model_changed`, `session_info_update` | session state |

Side-channel notifications arrive as `_x.ai/*` methods (`_x.ai/session_notification`,
`_x.ai/queue/changed`, `_x.ai/models/update`, ...). **Note:** the docs spell these
`x.ai/*`; the wire uses a leading underscore. Discover from `initialize`, don't hardcode.

### Why this can beat the driver loop

Continuation is **another `session/prompt` on the same session** — no new process, no
`-c`, no context reload. The single-turn stop (Gotcha 1) stops being a process-lifecycle
problem and becomes an ordinary "send the next prompt" decision, made by *your* code
with full visibility into what the last turn actually did.

**Choose:**

| Want | Use |
|------|-----|
| One batch job, minimal client code | `-p` + driver loop + `streaming-json` |
| Live tool visibility, permission prompts, mid-run steering | `agent stdio` (ACP) |
| Remote / multi-client | `agent serve` (WebSocket + `--secret`) |

Official ACP SDKs exist for TypeScript, Rust, Python, Go and Kotlin, and Zed / Neovim /
Emacs are working clients — prefer one over hand-rolling. `EXAMPLES.md` carries a
~40-line Python client that completes the handshake above.


## The brief

Grok starts **cold** — it cannot see the delegating conversation. Write a
self-contained `BRIEF.md` in the working directory and point the prompt at it.

Required sections:

1. **Facts** — what the product/system actually is; never assume shared context.
2. **Decisions already made** — as a table, marked do-not-relitigate, so it does not
   re-open settled questions.
3. **Environment** — Gotcha 2/3/4 constraints, what is pre-installed, what not to run.
4. **Deliverables** — concrete, with the code-vs-generate split spelled out.
5. **Honesty constraints** — what it must not claim or invent. Agents fill gaps with
   plausible fabrication (testimonials, metrics, unshipped features) unless forbidden.
6. **`NOTES.md` requirement** — decisions it made, departures from the brief and why,
   what it could not verify, what a human must do next. This is where the real
   signal lands; read it first when the run ends.

## Verify independently

Never accept the agent's completion claim. Re-run the gates yourself:

- Build/test commands, in your own shell (not the sandboxed one).
- `ffprobe` on media: codec, dimensions, frame rate, duration, size.
- Grep generated copy for fabrication — invented metrics, testimonials, claims about
  features that do not exist.
- Render the result and look at it.

Grok's `NOTES.md` departures are usually honest and sometimes better than the brief
(e.g. reusing production art instead of generating portraits). Read them, judge them
on merit, and record accepted departures upstream.

## Permission note

The host agent may be blocked from spawning an unattended `grok` process by its own
permission classifier, regardless of flags. That is a host-side control: explain what
you are trying to run and let the user launch it or add a permission rule. Do not
paper over it with flag variations.

## Anti-patterns

| Wrong | Right |
|-------|-------|
| Treat `grok -p` exit 0 as success | Check artifacts; read `stopReason` |
| Run with default `plain` output and guess at progress | `--output-format streaming-json` + watch the filesystem |
| Raise `--max-turns` to stop early exits | Driver loop with `grok -c` |
| Assume batch (`-p`) is the only mode | `grok agent stdio` (ACP) for tool visibility + steering |
| Let Grok scaffold and `pnpm install` in-sandbox | Pre-build the environment outside it |
| `--sandbox devbox` / no sandbox to dodge write errors | `workspace` + redirect caches to `/tmp` |
| `image_gen` a UI mockup or anything with real copy | Build it in code |
| Re-`image_gen` a recurring character | `image_edit` from one base image |
| Re-encode when joining shots | `-c copy` with matched res/fps |
| A prompt that references "the plan above" | Self-contained `BRIEF.md` |
