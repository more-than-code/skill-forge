# EXAMPLES — Grok Build harness

Copy-paste sequences. Paths are illustrative; substitute your own.

## 1. Preflight

```bash
grok --version && grok models && grok inspect
```

If `grok models` prompts for login, stop — the user must authenticate.

## 2. Prepare the working directory (outside the sandbox)

```bash
TARGET=/path/to/work
mkdir -p "$TARGET" && git -C "$TARGET" init -q

# Scaffold + install yourself — interactive creators crash headless,
# and package caches live outside the sandbox's writable set.
npx -y sv@latest create --template minimal --types ts --no-install --no-add-ons /tmp/scaffold
cp -R /tmp/scaffold/. "$TARGET"/
cd "$TARGET" && pnpm add -D <deps> && pnpm build     # prove it builds BEFORE delegating

# Pre-install any browser the run needs (reads work inside the sandbox)
npx playwright install chromium
```

Then write `BRIEF.md` into `$TARGET` (see SKILL.md § The brief) and commit it, so
Grok starts from a clean, known baseline.

## 3. Spawn — driver loop

```bash
#!/bin/zsh
cd /path/to/work || exit 1
export npm_config_cache=/tmp/grok-npm-cache
export XDG_CACHE_HOME=/tmp/grok-cache
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

PROMPT='Continue executing BRIEF.md end to end, resuming exactly where you left off.
Do not stop early: every deliverable must exist and be verified. Run the build and
the media checks before you consider yourself done, and write NOTES.md.'

for i in $(seq 1 30); do
  echo "########## ITERATION $i $(date +%H:%M:%S) ##########"
  grok -c -p "$PROMPT" --sandbox workspace --permission-mode auto --max-turns 400 2>&1
  rc=$?
  [ $rc -ne 0 ] && { echo "grok exited $rc; stopping"; break; }
  # Completion markers = artifacts on disk, not the model's word
  if [ -f NOTES.md ] && ls static/video/*.mp4 >/dev/null 2>&1; then
    echo "=== COMPLETE after iteration $i ==="; break
  fi
done
```

## 3b. Reading the output stream

Add `--output-format streaming-json` and tee to a log. Live human-readable narration:

```bash
grok -c -p "$PROMPT" --output-format streaming-json --sandbox workspace \
  | tee -a run.jsonl \
  | python3 -u -c "
import sys, json
for line in sys.stdin:
    try: o = json.loads(line)
    except ValueError: continue
    t = o.get('type')
    if t == 'text':  sys.stdout.write(o.get('data',''))
    elif t == 'end': print('\n[end]', o.get('stopReason'), 'turns=', o.get('num_turns'), 'cost=\$%.4f' % o.get('total_cost_usd', 0))
    elif t == 'error': print('\n[error]', o.get('message'))
"
```

Post-mortem of any completed run, and total spend across a driver loop:

```bash
# Why did each iteration stop, and how much did it do?
grep '"type":"end"' run.jsonl | python3 -c "
import sys, json
tot = 0.0
for i, l in enumerate(sys.stdin, 1):
    o = json.loads(l); c = o.get('total_cost_usd', 0) or 0; tot += c
    print(f\"iter {i}: {o.get('stopReason')} turns={o.get('num_turns')} \${c:.4f}\")
print(f'TOTAL \${tot:.4f}')
"
```

`stopReason: EndTurn` on an unfinished brief = the single-turn stop (SKILL.md Gotcha 1).
`max_turns_reached` = genuinely hit `--max-turns`; raise it or split the work.

There are **no tool-call events**, so pair the stream with filesystem watching to see
what it actually wrote:

```bash
find work/src work/static -type f -newer work/BRIEF.md | sort
```

## 4. First run of a fresh session

The loop's `-c` needs an existing session for that cwd. Either seed one:

```bash
grok -p "Read BRIEF.md and begin executing it." --sandbox workspace --permission-mode auto
```

…then run the loop, or make iteration 1 use the seed prompt and later ones `-c`.

## 5. Verify — independently of Grok's claims

```bash
cd /path/to/work
pnpm build; echo "BUILD EXIT: $?"          # your shell, not the sandboxed one

ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=width,height,r_frame_rate,codec_name \
  -of default=noprint_wrappers=1 static/video/hero.mp4

# Fabrication sweep over generated copy
grep -rioE "app store|[0-9,]+\+? (users|customers)|trusted by|testimonial|★|\\\$[0-9]" build/
```

Then read `NOTES.md` — departures and unverifiable items land there.

## 6. Media recipes

```bash
# Assemble shots losslessly (all must share resolution + fps)
printf "file '%s'\n" shots/*.mp4 > /tmp/shots.txt
ffmpeg -f concat -safe 0 -i /tmp/shots.txt -c copy hero.mp4

# Web encodes from one master
ffmpeg -i hero.mp4 -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4
ffmpeg -i hero.mp4 -c:v libvpx-vp9 -b:v 0 -crf 34 out.webm
ffmpeg -i hero.mp4 -vframes 1 -q:v 3 poster.jpg
```

Note: some ffmpeg builds lack a **libwebp** encoder — check before promising WebP
rasters (`ffmpeg -encoders | grep webp`), and fall back to PNG/JPEG or `sips`.

## 7. Diagnosing a run that "did nothing"

| Symptom | Cause | Action |
|---------|-------|--------|
| Exit 0, truncated narration, few files | single-turn `-p` | driver loop with `-c` |
| Crash in a create/scaffold CLI | cache write outside sandbox | pre-scaffold outside |
| `EACCES`/`EPERM` on a `$HOME` path | sandbox write boundary | redirect to `/tmp` |
| Chromium SIGSEGV | sandbox + keychain/crashpad | native renderer fallback |
| Build segfault only under agent | inherited env | `env -i HOME=… PATH=… <build>` |
| HTTP 429 during generation | parallel Imagine calls | retry sequentially |

## 8. Minimal ACP client (`grok agent stdio`)

Verified against grok 0.2.102. Completes initialize → session/new → session/prompt and
prints every `tool_call` as it happens — the visibility `-p` cannot provide.

```python
import json, subprocess, threading, time, collections

CWD = "/path/to/work"
proc = subprocess.Popen(["grok", "agent", "--always-approve", "stdio"], cwd=CWD,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

results, updates, lock = {}, [], threading.Lock()

def reader():
    for line in proc.stdout:
        line = line.strip()
        if not line: continue
        try: m = json.loads(line)
        except ValueError: continue
        with lock:
            if "id" in m and ("result" in m or "error" in m): results[m["id"]] = m
            elif m.get("method"): updates.append(m)
threading.Thread(target=reader, daemon=True).start()

def send(i, method, params):
    proc.stdin.write(json.dumps(
        {"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n")
    proc.stdin.flush()

def wait(i, secs=300):
    t0 = time.time()
    while time.time() - t0 < secs:
        with lock:
            if i in results: return results[i]
        time.sleep(0.1)

send(1, "initialize", {"protocolVersion": 1,
     "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}}})
wait(1)

send(2, "session/new", {"cwd": CWD, "mcpServers": [], "_meta": {"yoloMode": True}})
sid = wait(2)["result"]["sessionId"]

send(3, "session/prompt", {"sessionId": sid,
     "prompt": [{"type": "text", "text": "Read BRIEF.md and begin executing it."}]})
print("stopReason:", wait(3)["result"]["stopReason"])

# Continue the SAME session — no new process, no `-c`
send(4, "session/prompt", {"sessionId": sid,
     "prompt": [{"type": "text", "text": "Continue until every deliverable exists."}]})
wait(4)

with lock:
    kinds = collections.Counter(
        (u.get("params", {}).get("update") or {}).get("sessionUpdate") for u in updates)
print(dict(kinds))
```

Live tool feed — replace the counter with:

```python
u = upd.get("params", {}).get("update", {})
if u.get("sessionUpdate") in ("tool_call", "tool_call_update"):
    print("TOOL:", u.get("title"), u.get("status"))
```

Watch for `pending_interaction`: the agent is asking permission. Answer it instead of
pre-approving everything with `yoloMode` when the run touches anything destructive.
