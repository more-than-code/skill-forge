---
name: fvm-flutter
description: >
  Use Flutter Version Management (FVM) as the only Flutter SDK entrypoint for
  projects that pin a version. Covers pin discovery (.fvmrc / .fvm/), fvm flutter
  and fvm dart commands, install/use, agent sandboxes (HOME/PUB_CACHE only — never
  a second SDK under .tooling/), and avoiding bare flutter / Source Control noise
  from SDK checkouts. Activate when working in a Flutter/Dart repo, running
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

## Start here

From the **Flutter app package root** (directory with `pubspec.yaml` + pin):

```bash
# Pin (committed)
cat .fvmrc 2>/dev/null || cat .fvm/fvm_config.json 2>/dev/null

# Resolve
fvm list
fvm flutter --version
fvm flutter sdk-path
```

If FVM is missing: install FVM first, then `fvm install` in the project — do **not**
download Flutter into the repo by hand.

## Hard rules

1. **Prefer `fvm flutter` / `fvm dart`** whenever a pin exists. Bare `flutter` is often a
   different global SDK and causes `requires SDK version ^x` resolution failures.
2. **One SDK cache** — FVM’s versions directory (e.g. `~/fvm/versions/<ver>`). Never maintain
   a parallel tree such as `.tooling/flutter-<ver>/` for day-to-day or agent work.
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
3. **never** prefer a workspace-vendored Flutter clone over FVM

## Agent sandboxes (write restrictions)

If the environment cannot write under `~/fvm/...` or `~/.dart-tool`:

- **Still use FVM’s SDK path** (`fvm flutter sdk-path` / `FLUTTER_ROOT` pointing at that path).
- Redirect only **writable state**:
  - `HOME` → workspace-local dir (e.g. `.tooling/home`)
  - `PUB_CACHE` → workspace-local dir (e.g. `.tooling/pub-cache`)
- Do **not** copy or symlink the full SDK into the workspace to “fix” permissions.

```bash
export FLUTTER_ROOT="$(cd app && fvm flutter sdk-path)"
export HOME="${HOME_OVERRIDE:-$REPO/.tooling/home}"
export PUB_CACHE="${PUB_CACHE:-$REPO/.tooling/pub-cache}"
mkdir -p "$HOME" "$PUB_CACHE"
# then: fvm flutter test …
```

## Gotchas

- **Wrong Dart from bare `flutter`:** symptom is pub get / analyze failing on SDK constraint;
  fix is FVM pin, not editing `pubspec` constraints ad hoc.
- **Symlink “overlay” SDKs:** a directory of symlinks into `~/fvm/versions/...` that still
  points `.git` at the real Flutter repo will show up as a huge dirty git status — delete the
  overlay; keep FVM.
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
