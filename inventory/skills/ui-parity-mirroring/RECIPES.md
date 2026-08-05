# RECIPES — parity harness implementation

Concrete patterns behind `SKILL.md`. Stack shown is Playwright (source, web) +
Flutter golden (mirror), but the shapes transfer to RNTL, Compose, XCUITest-free
snapshot suites, etc.

## Manifest shape

```jsonc
{
  "viewport": { "width": 390, "height": 844, "deviceScaleFactor": 2 },
  "colorScheme": "light",
  "locale": "en",
  "seedUser": { "email": "seed@test.com", "password": "…" },
  "captures": [
    {
      "id": "practice-hub-populated",
      "web":    { "route": "/practice", "auth": "user", "ready": "header h1" },
      "mobile": { "route": "/practice", "auth": "user" },
      // Endpoints the screen renders from. REQUIRED when the source app is SSR.
      "api": ["GET /api/me", "GET /api/chats", "GET /api/practice/overview"],
      "checklist": {
        "jobs": ["see what is due", "resume a session"],
        "actions": ["start practice", "switch tab"],
        "states": ["populated"],
        "openQuestion": "Optional: a question this pair must answer."
      }
    }
  ]
}
```

**Deriving the `api` list:** read the source app's server load functions
(`+page.server.ts`, loaders, controllers) — not the client code. That is the
authoritative list for an SSR app.

**Readiness selectors:** use a real element, never a sleep. Beware selectors that
are conditionally rendered — e.g. a header `<h1>` gated on a title will not exist
on an empty screen, so that route needs a different selector.

## Source capture (Playwright)

```ts
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor, colorScheme, locale,
  baseURL: BASE_URL,
  ignoreHTTPSErrors: true,   // dev servers often use self-signed certs
});

// 1. passive: catches genuinely client-initiated calls
page.on('response', async (res) => { /* record /api/* JSON into bag */ });

// 2. active: the one that works under SSR — shares the context cookie jar
for (const entry of capture.api ?? []) {
  const [method, pathWithQuery] = splitOnce(entry, ' ');
  const res = await page.request.fetch(pathWithQuery, { method });
  bag[entry] = res.ok()
    ? await res.json()
    : { __status: res.status() };   // never silently drop a non-2xx
}
```

Record non-2xx as an explicit stub so "guest got 401" is distinguishable from
"never captured".

## Mirror capture (Flutter golden, headless)

Compose two patterns: a full-app pump with dependency overrides, plus a golden
write.

```dart
setUpAll(() async {
  await _loadInter();       // bundled text font
  await _loadLucide();      // icon font — resolve via .dart_tool/package_config.json
  await _loadSdkFonts();    // MaterialIcons + framework fallback font
});

await tester.binding.setSurfaceSize(Size(vp.width, vp.height));
await tester.pumpWidget(ProviderScope(
  overrides: [ /* EVERY repository the screen touches, fixture-backed */ ],
  child: const RepaintBoundary(key: _rootKey, child: App()),
));
router.go(capture.route);
await tester.pumpAndSettle();

final boundary = tester.renderObject(find.byKey(_rootKey)) as RenderRepaintBoundary;
final image = await tester.runAsync(() => boundary.toImage(pixelRatio: vp.dpr));
```

Resolve package asset paths from the dependency manifest so the harness is not
tied to one machine's cache layout:

```dart
Directory? _packageRoot(String name) {
  final cfg = File('.dart_tool/package_config.json');
  // find package by name, resolve rootUri relative to .dart_tool/
}
```

### Non-blank assertions (mandatory)

```dart
expect(bytes.length, greaterThan(_minPngBytes));   // byte floor
switch (id) {                                       // + content assertion
  case 'practice-hub-populated':
    expect(find.text('In progress'), findsWidgets);
    expect(find.text('Resume 0/10'), findsWidgets);  // proves DATA, not just chrome
}
```

The byte floor alone is not enough — a screen can render full chrome with an
empty list and clear it. Assert something only present when data loaded.

### Unmocked platform channels

Screens that construct plugin objects (audio recorder, camera) throw
`MissingPluginException`. Mock the channel in setup:

```dart
TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
  .setMockMethodCallHandler(const MethodChannel('com.example/plugin'),
    (call) async => null);
```

### Screens that fall through to the real network

If a provider is not overridden, the screen uses the real HTTP repository, the
test hangs on a pending timer, and **that screen quietly never gets captured**.
Audit overrides against the screen's dependency list — a missing one is a
coverage hole, not just a failure.

## Data handoff with a safe merge

```dart
// live (captured) wins per key; checked-in seed fills holes
final merged = {...seed};
for (final e in live.entries) {
  final seedIsRealBody = seed[e.key] != null && !isStatusStub(seed[e.key]);
  if (isStatusStub(e.value) && seedIsRealBody) continue;  // don't let a failed
  merged[e.key] = e.value;                                 // fetch empty a screen
}
```

Committing a seed fixture per capture keeps the mirror half runnable before the
browser half has ever run, and makes a partial capture degrade instead of
producing false gaps.

## Board generator

Plain Node, zero dependencies, images inlined as base64 so the file is portable:

- one row per capture: source image | mirror image
- that row's checklist and `openQuestion` rendered beside them
- a header stating the comparison rule (compare jobs/IA/actions/states/copy;
  ignore layout/spacing/type-scale)
- a visible slot for the reviewer's verdict

## Runner

```bash
run.sh [--mirror-only]
# 1 check source server reachable (curl -k for self-signed)
# 2 source capture (browser)      ← often must run outside a sandbox
# 3 mirror capture (headless)     ← sandbox-safe
# 4 build board
```

`--mirror-only` matters: it is the mode a sandboxed agent can actually execute.

## Copy-drift check (cheap, high yield)

Diff every shared i18n key between the source and mirror, rather than eyeballing
screens:

```python
shared = [k for k in web if k in mob]
diff   = [(k, web[k], mob[k]) for k in shared if web[k] != mob[k]]
```

Two traps:
- Compare the **generated** artifact, not only the source `.arb`/`.json` — an ARB edit is inert until regeneration.
- Beware regex extraction over source files: wrapped/multi-line values silently fail to match and produce fake "missing key" counts. Verify any surprising count with a direct `grep` for a specific key before reporting it.

## Anti-patterns

| Wrong | Right |
|---|---|
| Pixel/SSIM diff against a non-pixel bar | Checklist-based semantic review |
| `page.on('response')` alone on an SSR app | Declared `api` list + `page.request` |
| Fake repos returning `const []` | Fixture-backed fakes, wired per screen |
| Byte-floor as the only blank check | Byte floor **plus** data-bearing content assertion |
| "20/20 green" as a parity claim | "20 captured, N green; these routes are uncovered" |
| Capturing an entity with no optional data | Capture the entity that has it |
| N more captures for a catalog invariant | One test that enumerates the catalog |
| Trusting a delegate's completion claim | Re-run gates yourself and look at the images |
