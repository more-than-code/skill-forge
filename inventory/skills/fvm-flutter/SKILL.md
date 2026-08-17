---
name: fvm-flutter
description: >
  Use Flutter Version Management (FVM) as the only Flutter SDK entrypoint for
  projects that pin a version. Covers pin discovery (.fvmrc / .fvm/), fvm flutter
  and fvm dart commands, install/use, agent sandboxes (HOME/PUB_CACHE redirects, and the FLUTTER_ROOT/bin/cache writes
  that force a cloned SDK when the pin is read-only), and avoiding bare flutter /
  Source Control noise from SDK checkouts. Activate when working in a Flutter/Dart repo, running
  analyze/test/build, writing parity or CI scripts, or when tempted to copy the
  SDK into the workspace.
---

# FVM Flutter (toolchain)

Pin once with FVM; run everything through `fvm flutter` / `fvm dart`. Do **not**
vendor a second Flutter tree under the workspace.

## Activate when

- Repo has `.fvmrc`, `.fvm/fvm_config.json`, or `.fvm/flutter_sdk`
- User or scripts run Flutter/Dart (analyze, test, build, pub get, goldens)
- Parity/CI/agent sandboxes need a Flutter binary
- Someone proposes cloning Flutter under `.tooling/`, `vendor/`, or the monorepo root
- An agent runs under a sandbox that confines writes (it will need a provisioned SDK)

## Start here

From the **Flutter app package root** (directory with `pubspec.yaml` + pin):

```bash
# Pin (committed)
cat .fvmrc 2>/dev/null || cat .fvm/fvm_config.json 2>/dev/null

# Resolve
fvm list
fvm flutter --version
readlink .fvm/flutter_sdk   # SDK path — NOT `fvm flutter sdk-path` (no such command)
```

If FVM is missing: install FVM first, then `fvm install` in the project — do **not**
download Flutter into the repo by hand.

## Hard rules

1. **Prefer `fvm flutter` / `fvm dart`** whenever a pin exists. Bare `flutter` is often a
   different global SDK and causes `requires SDK version ^x` resolution failures.
2. **One SDK cache** — FVM’s versions directory (e.g. `~/fvm/versions/<ver>`). Never maintain
   a parallel tree such as `.tooling/flutter-<ver>/` for day-to-day work. **One exception:** a
   write-confined sandbox that cannot write `$FLUTTER_ROOT/bin/cache` — there a *clone* of the
   pinned SDK is required and correct (see *Agent sandboxes*). A hand-built **symlink overlay**
   is never correct.
3. **Do not commit** the SDK, `.fvm/flutter_sdk` target contents, or nested Flutter `.git`
   checkouts. Commit only the pin (`.fvmrc` / `.fvm/fvm_config.json`) and project code.
4. **Do not open the FVM SDK folder as a VS Code / multi-root workspace root** — Source Control
   will show thousands of noise diffs. If it appears, remove it from the workspace or add it to
   `git.ignoredRepositories`.
5. **Run commands from the pinned package root** so FVM picks up `.fvmrc` (e.g. `cd ttd-mobileapp && fvm flutter test`).

## Common commands

```bash
fvm install                 # ensure pinned version is present
fvm use <version> --force   # change pin (user-approved)
fvm flutter pub get
fvm flutter analyze
fvm flutter test
fvm flutter test path/to_test.dart
fvm flutter test path/to_test.dart --update-goldens
fvm dart format .
fvm dart run <package:script>
```

Record the exact `fvm flutter …` line in scripts and NOTES so agents do not invent a second path.

## Scripts and CI

Prefer invoking FVM explicitly:

```bash
# Good
(cd path/to/flutter_app && fvm flutter test)

# Bad — second SDK overlay
export FLUTTER_ROOT="$REPO/.tooling/flutter-3.x.y"
```

Resolver order for harness scripts:

1. `fvm` available → `fvm flutter` with pin from the app package  
2. else `flutter` on PATH (warn if pin exists but fvm missing)  
3. **never** prefer a workspace-vendored Flutter clone over FVM — except a clone of the
   pinned SDK provisioned for a write-confined sandbox (*Agent sandboxes*, Case B)

## Agent sandboxes (write restrictions)

**Flutter writes as it runs.** Three separate locations, and a sandbox usually
blocks all three:

| What writes | Where | Redirectable by env? |
|---|---|---|
| pub packages | `$PUB_CACHE` (default `~/.pub-cache`) | yes — `PUB_CACHE` |
| tool state, config, analytics | `$HOME/.dart-tool`, `$HOME/.flutter*` | yes — `HOME` |
| **SDK artifacts, snapshots, stamps** | **`$FLUTTER_ROOT/bin/cache`** | **no** |

That third row is the one that breaks naive recipes: there is no env var for it,
so if `$FLUTTER_ROOT` is not writable, `flutter` cannot run at all — no matter
how carefully you redirect `HOME` and `PUB_CACHE`.

**Resolving the SDK path:** read the symlink FVM maintains. Do **not** use
`fvm flutter sdk-path` — that subcommand does not exist (Flutter 3.44.6 prints
`Could not find a command named "sdk-path"`), so probes built on it fall through
to a bare `flutter` on PATH, silently using a different SDK than the pin.

```bash
SDK="$(cd app && readlink .fvm/flutter_sdk)"   # e.g. /Users/me/fvm/versions/3.44.6
```

### Case A — SDK path IS writable (normal dev, most CI)

Redirect only the writable state; keep using FVM:

```bash
export HOME="${HOME_OVERRIDE:-$REPO/.tooling/home}"
export PUB_CACHE="${PUB_CACHE:-$REPO/.tooling/pub-cache}"
mkdir -p "$HOME" "$PUB_CACHE"
fvm flutter test …
```

### Case B — SDK path is NOT writable (write-confined agent sandbox)

Then you need a writable SDK, and **cloning the pinned SDK is the sanctioned
move** — the anti-pattern this skill forbids is a *symlink overlay* pointed back
at `~/fvm` (writes escape to the shared SDK, or fail), not an honest copy.

On macOS/APFS use a copy-on-write clone: ~10s for a 2 GB SDK and near-zero disk
until something diverges. It inherits the source's populated `bin/cache`, so no
precache or download is needed.

```bash
cp -Rc "$SDK" "$WORK/.tooling/flutter-sdk"     # -c = clonefile(2); falls back to full copy off-APFS
mkdir -p "$WORK/.tooling/"{home,pub-cache}
```

Then invoke through a shim so the redirect is scoped to Flutter and does not
disturb the agent's own `$HOME`:

```sh
#!/bin/sh
export FLUTTER_ROOT="$WORK/.tooling/flutter-sdk"
export PUB_CACHE="$WORK/.tooling/pub-cache"
export HOME="$WORK/.tooling/home"
export FLUTTER_SUPPRESS_ANALYTICS=true
exec "$FLUTTER_ROOT/bin/flutter" "$@"
```

Prove it before trusting it: `flutter --version` through the shim must report the
**pinned** version. A clone that silently resolves elsewhere is worse than no SDK.

Provision this **before** the sandboxed process starts — a write-confined agent
cannot create it for itself, and one that improvises will hand you weaker
evidence (widget renders instead of the project's real test suite).

## Gotchas

- **Wrong Dart from bare `flutter`:** symptom is pub get / analyze failing on SDK constraint;
  fix is FVM pin, not editing `pubspec` constraints ad hoc.
- **Symlink “overlay” SDKs:** a directory of symlinks into `~/fvm/versions/...` that still
  points `.git` at the real Flutter repo will show up as a huge dirty git status — delete the
  overlay; keep FVM. Agents build these when a sandbox blocks SDK writes; the fix is a real
  clone (*Agent sandboxes*, Case B), not a lattice of links back to the shared SDK.
- **Multi-package monorepos:** each Flutter package may have its own pin; run FVM from that
  package root, not the umbrella root (unless the umbrella documents a single pin).
- **iOS CocoaPods vs SPM:** FVM does not replace Xcode project hygiene; after plugin changes
  run the project’s documented iOS setup (`fvm flutter precache`, pods/SPM as the app uses).

## Verification

```bash
fvm flutter --version          # matches .fvmrc
which -a flutter               # show globals; do not prefer them when pin exists
fvm flutter analyze
fvm flutter test
```

Success: pinned version in use, no second SDK tree under the product workspace, analyze/test
exit codes reported from `fvm flutter …`.
