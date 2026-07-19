---
name: audio-webkit-cleanup
description: >
  Portable WebKit/iOS rules for tearing down HTMLAudioElement, AudioContext, getUserMedia,
  and MediaRecorder so audio does not die mid-session. Use when adding browser audio playback
  or recording, debugging silent audio until tab kill on iOS Safari, or reviewing mic/TTS loops.
---

# Audio WebKit cleanup (portable)

iOS Safari / WebKit does **not** promptly release decoder and `AVAudioSession` resources when a JS reference to `HTMLAudioElement` or `AudioContext` is dropped. In loops that create many players or meters (TTS drills, voice input), incomplete teardown exhausts the budget — audio **silently stops** until the tab/app is force-killed.

This is an **implementation quirk**, not a WHATWG requirement. Chrome/Blink is usually fine with GC alone; still follow these rules everywhere — they are correct hygiene on every engine.

## Rule 1 — release `<audio>` on every exit path

`URL.revokeObjectURL(url)` frees the blob; it does **not** release WebKit's decoder. Every end of playback must also detach the source:

```ts
function release(audio: HTMLAudioElement, url: string): void {
  audio.pause();
  URL.revokeObjectURL(url);
  audio.removeAttribute('src');
  audio.load();
}
```

Call from **all** of: `ended`, `error`, `play()` rejection, and any manual `stop()` / interrupt. Missing one path leaves a live decoder.

## Rule 2 — close `AudioContext` before stopping tracks

For mic level meters (`AudioContext` + `createMediaStreamSource`):

1. `await audioContext.close()` (or equivalent teardown)
2. **then** `track.stop()` on the `MediaStreamTrack`s

Use the **same order** on success, cancel, error, and unmount. Capture `const rec = mediaRecorder` before async `onstop` so the closure does not null-deref after reassignment.

## Checklist

- [ ] Every `new Audio(objectUrl)` has paired `release()` on ended/error/play-reject/stop
- [ ] Every meter `AudioContext` closes **before** tracks stop, on every path
- [ ] Per-item/per-turn resources actually tear down every cycle (churn is what kills long sessions)
- [ ] Duplicated copy-paste release helpers are noted so fixes land in all copies

## Non-goals

- Server-side audio / FFmpeg pipelines
- Native mobile (iOS/Android) audio session APIs — different stack; apply platform-specific teardown there
- Pure `getUserMedia` + `MediaRecorder` **without** playback or `AudioContext` — Rule 1/2 may not apply; still stop tracks on unmount

## Project overlays

This skill reaches consumer repos as a registry dependency, vendored by `skf sync`. For app-specific file paths and helper names, add a thin companion skill under a **different name** (e.g. `audio-resource-cleanup`) declared in `skill-forge.json` `skills.local`, holding the local references and pointing back to this skill for the rules. Same-name shadowing is not possible — a name cannot be both a dependency and a local skill.
