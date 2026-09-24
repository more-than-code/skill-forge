---
name: disk-cleanup
description: >
  Free disk space on a developer Mac: regenerable caches, unused container
  images, old simulator runtimes, extra simulator devices, and unused or
  older Android SDK packages. Keeps running containers, named volumes,
  pinned toolchains, and the booted simulator. Use when the user says
  clean up disk, free disk space, disk full, prune simulators, remove an
  old NDK or SDK package, or runs /disk-cleanup.
---

# Disk cleanup

Free space on a macOS developer machine. Measure first, delete regenerable or explicitly unused packages, and report free space before and after.

## Measure

Record free space on the data volume before deleting anything.

```bash
df -h / /System/Volumes/Data
```

On a nearly full disk, size the known large roots. A walk of the whole home directory is slow and contends with the deletes. Typical roots: package-manager caches, the Gradle user home, Xcode DerivedData and iOS DeviceSupport, CoreSimulator devices, the Android SDK, and the Podman or Docker machine disk.

`podman system df` reports usage inside the guest. Host free space comes from `df` and from the size of the machine disk image on the host. The image is a sparse file, so size it with `du -h`; `ls -l` shows the apparent size, which does not shrink.

## Confirm before costly deletes

Caches regenerate on next use and need no further confirmation once the user asked to clean the disk. Simulator runtimes, simulator devices, and SDK packages take a download or lose data to restore. After measuring, list each one you plan to remove with its size, plus the devices that live on each runtime, and wait for the user to confirm.

## Regenerable caches

When the user asked to clean the disk, remove these. They are recreated on next use. Stop Gradle daemons with `gradle --stop` first, and ask the user to close Android Studio and Xcode, so no running build loses its files mid-use.

- Homebrew: `brew cleanup -s --prune=all`. When cleanup autoremoves formulae, name any language runtime it uninstalled.
- npm: `npm cache clean --force`. Go: `go clean -cache`. pnpm: `pnpm store prune`.
- Gradle user-home `caches`, `daemon`, and `.tmp`. Under `wrapper/dists`, keep the newest distribution and delete the older ones.
- Xcode DerivedData and iOS DeviceSupport.

## Containers

Prune unused images. Leave named volumes and running containers in place. `podman image prune -a` keeps every image a container still references, including stopped containers. Deleting volume data requires the user to ask for that data to be deleted. Detect which runtime is present per `podman-utilization`; with Docker, `docker image prune -a -f` is the equivalent.

```bash
podman image prune -a -f
```

On a macOS Podman machine, image prune frees blocks inside the VM. The host sparse disk stays large until trim. Trim while the machine is running so current containers stay up, then measure the disk image on the host with `du -h`:

```bash
podman machine ssh -- sudo fstrim -av
```

## Apple simulators

A runtime is the shared OS image. A device is one virtual phone or tablet and its app data.

Remove an older runtime when a newer runtime is already installed and no booted device uses the older one. Deleting a runtime makes every device on it unavailable, and `simctl delete unavailable` then removes those devices and their app data, so name them in the confirmation.

```bash
xcrun simctl runtime list
xcrun simctl runtime delete <identifier>
```

`runtime delete` unregisters and unmounts the image. The downloaded MobileAsset disk image can remain on disk with the restricted flag. While System Integrity Protection is enabled, removing that file fails with "Operation not permitted", including as root. Report the asset path. Free space does not include that file. Describe turning SIP off only when the user asks how to reclaim that file.

`xcrun simctl delete unavailable` removes devices whose runtime is already gone.

When the user asks to keep the minimum number of devices, keep the booted device. If none is booted, keep one phone on the current runtime. Delete the other device instances with `xcrun simctl delete`. A `.simdevicetype` bundle is the menu entry for creating that model. Leave it unless the user asks to remove the model from the create list.

## Android SDK

An AVD is a virtual device. A system image is the OS that device boots. An SDK package (NDK, platform, build-tools, sources, emulator) is a compile toolchain. An empty AVD directory means there is no device to delete.

List installed packages, then read the NDK, `compileSdk`, and build-tools versions pinned by the active toolchain and by project build files. Only the current workspace's pins are visible; another project on the machine that pins a removed package downloads it again on its next build. `sdkmanager` is often not on `PATH`; it lives at `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager`.

```bash
sdkmanager --list_installed
```

Uninstall side-by-side copies older than those pins, and packages nothing references: extra platforms, old build-tools, framework sources, and the emulator package when no AVD exists. Keep platform-tools, the current cmdline-tools, and the single CMake native builds use.

```bash
sdkmanager --uninstall "ndk;<version>" "platforms;android-<api>" "build-tools;<version>"
```

Use `sdkmanager --uninstall` so the package index matches the directories. When the user explicitly says to remove a version a project still pins, uninstall it and name that pin in the report. The next build downloads it again unless the pin changes.

## Still on disk

Agent session transcripts, chat-app data, project source, named container volumes, the current simulator runtime, and SDK packages a current build still pins stay. When those are the largest remaining paths, list them with sizes and wait for the user to name which one to remove.

## Report

State free space before and after, what was removed, what was kept because a toolchain or project still pins it, and any SIP-restricted file that remained.
