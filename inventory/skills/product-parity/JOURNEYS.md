# Journeys: can the user get back?

## The gap this closes

Every capture opens its route directly. A mirror harness usually gets there by replacing the
navigation stack, so a screen reached by **push** and one reached by **replace** produce the
same capture. No check that reads captures can see how the user **moves** between screens.

Observed 2026-11-13 on one project: an End User pass on the Flutter mirror found nine
back-navigation defects the gate had passed.
- Drill-down screens were opened by replacing the stack, so Back fell back to a fixed path.
  The edge swipe did nothing, and leaving played the push animation.
- One screen's fallback path redirected to itself: Back led nowhere.
- Back from a record skipped the list it was opened from.
- "Chat with …" opened a new empty chat where the source reopens the existing one.

Two checks close most of this:
- **Journeys (check Q):** run-time. Both harnesses walk the same named steps, and the gate
  compares where each lands.
- **Navigation scan (check R):** static and Tier 1. It flags every place the mirror's code
  replaces the stack to reach a drill-down.

## A journey

```json
{
  "id": "record-back-to-completed",
  "start": "practice-hub",
  "steps": [
    { "do": "tap:Completed",    "expect": "practice-completed" },
    { "do": "tap:first-record", "expect": "record-detail" },
    { "do": "back",             "expect": "practice-completed" },
    { "do": "tap-back",         "expect": "practice-hub" }
  ]
}
```

It lives in the manifest's `journeys` array.
- `start` and every `expect` are **capture ids**. Each client's landing is matched against the
  capture's route **for its own column**, so the two clients may spell routes differently.
- Query keys on the capture's route must match too. That is how "reopen chat `c1`" is told
  apart from "open a new chat".

## Rules

1. **Start on a root.** `start` must be a capture whose **mirror** route is in
   `navigation.roots`, which is spelled in the mirror's route scheme. The mirror harness opens
   it the way it opens any capture (`router.go(start)`), which replaces the stack, so a deep
   start has nothing beneath it and `back` would test nothing. Reach drill-downs with steps,
   the way a user does.
2. **Symmetric or nothing.** These are the `prep` rules (`DYNAMIC-STATES.md`).
   - Every step is implemented by both harnesses under the same name.
   - An unknown name is a hard failure, never a skip.
   - Name the intent, not the gesture.
3. **`back` and `tap-back` are different steps.**
   - `back` is the platform's back: browser history on the web, and `Navigator.maybePop()` on
     the mirror, which is what the system back button and the edge swipe do.
   - `tap-back` is the screen's own back control.

   One project broke one and not the other, so a journey that tests only one passes half the
   defects.

   A back that pops nothing, or leaves the user on the same route, fails as a dead end even if
   the manifest's `expect` names that same screen.
4. **Record what happened, not what was meant.** After every step, read the location the router
   actually holds. For `back` and `tap-back`, also record whether anything was popped. A
   harness that writes the expected route back is a mirror of the manifest, not a test.
5. **Settle before reading.** Wait for the navigation to finish (`waitForURL`, `pumpAndSettle`)
   before recording the route. A fixed sleep records a half-finished transition.
6. **Give the mirror every screen's data.** API bags are per capture, so for a journey the
   mirror harness loads the union of the bags of its `start` and `expect` captures. Without the
   data, the mirror shows an empty state that may sit on the right route, and the journey
   passes on the wrong screen.

## The artifact each harness writes

`<out>/journeys/<id>.<column>.json`, one per client:

```json
{ "journey": "record-back-to-completed",
  "steps": [
    { "do": "tap:Completed",    "route": "/practice/completed", "canPop": true },
    { "do": "tap:first-record", "route": "/records/7",          "canPop": true },
    { "do": "back",             "route": "/practice/completed", "popped": true, "canPop": true },
    { "do": "tap-back",         "route": "/practice",           "popped": true, "canPop": false }
  ] }
```

`canPop` is recorded by the mirror only. The web always has browser history, so the check is
one-sided on purpose. Failure ids are in `REFERENCE.md` §Q.

## Harness recipes

**Web, Playwright** (start each journey in a fresh context, so history starts at `start`):

```ts
for (const step of journey.steps) {
  const before = page.url();
  let popped: boolean | undefined;
  if (step.do === 'back') {
    await page.goBack({ waitUntil: 'networkidle' });   // resolves null when there is no history entry
    popped = page.url() !== before;
  } else if (step.do === 'tap-back') {
    await page.getByRole('link', { name: 'Back' }).or(page.getByRole('button', { name: 'Back' })).click();
    await page.waitForLoadState('networkidle');
    popped = page.url() !== before;
  } else {
    await runPrepStep(page, step.do);        // the same name→action map as captures; unknown → throw
    await page.waitForLoadState('networkidle');
  }
  const u = new URL(page.url());
  steps.push({ do: step.do, route: u.pathname + u.search, ...(popped === undefined ? {} : { popped }) });
}
```

**Mirror, Flutter widget test, `go_router`:**

```dart
for (final step in journey.steps) {
  bool? popped;
  if (step.doName == 'back') {
    final nav = Navigator.of(tester.element(find.byType(Scaffold).last));
    popped = await nav.maybePop();                     // what system back and the edge swipe do
  } else if (step.doName == 'tap-back') {
    final before = router.routerDelegate.currentConfiguration.uri.toString();
    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    popped = router.routerDelegate.currentConfiguration.uri.toString() != before;
  } else {
    await runPrepStep(tester, step.doName);            // unknown → fail
  }
  await tester.pumpAndSettle();
  final route = ModalRoute.of(tester.element(find.byType(Scaffold).last))!;
  steps.add({
    'do': step.doName,
    'route': router.routerDelegate.currentConfiguration.uri.toString(),
    if (popped != null) 'popped': popped,
    'canPop': route.canPop,
  });
}
```

Record locations exactly as the router holds them. If the mirror's router drops query strings,
the landing will fail a capture that expects one. That failure is real: it is the
"opens a new chat" defect.

## The navigation scan (check R)

A replace to a drill-down is the single cause behind the dead back button, the dead edge swipe
and the backwards animation. Check R finds it in the code, with no capture:
- It lists every literal replace target that is not in `navigation.roots`, with `file:line`.
- It counts dynamic targets (`go(backPath)`) in a note. Read those call sites by hand.
- Waive a target only with a reason, an owner and `removeWhen`.

The patterns are per stack: `context.go(` for go_router, `pushReplacement` /
`pushAndRemoveUntil` for Navigator 1, `setRoot` and friends elsewhere. Configure them in
`navigation.replace` (`REFERENCE.md` §R).

## Behaviour with no counterpart in the source

These have nothing to compare against, so they get one-sided checks (mirror only):

| Mirror behaviour | Source counterpart | Checked by |
|---|---|---|
| iOS edge swipe back | none | `canPop` (Q), replace scan (R) |
| Pop animation direction | none | `canPop` (Q), replace scan (R). The animation itself is not observable in a widget test |
| Android system back | browser Back, loosely | `back` step (Q) |
| External launch (system browser) where the source has an in-app route | in-app route | not checked; see below |

## Still not caught

Say so in the board's notes rather than letting a green gate imply otherwise. On the
2026-11-13 project:
- **Behaviour that needs writes** (a setting that should hide something later). The mirror harness fakes writes.
- **An external launch** where the source navigates in-app. The landing is never recorded unless the platform channel is mocked to record it.
- **Font rendering** on a real device.
- **State leaking between screens** (a draft pre-filling a "new" screen). That is screenshot review, not navigation.

**Deferred: per-step API calls.** Recording the endpoints each step calls, and diffing them,
would catch "creates new" against "reuses existing" directly. It is not in this check yet for
two reasons:
- **Web:** a source app with server-side loads makes calls the browser never sees.
- **Mirror:** a harness fed fixture bags records a deduplicated set of reads, not each step's
  calls.

The query-aware landing match catches the case that prompted it. Revisit when the mirror
records writes per step.
