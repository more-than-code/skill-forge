# Capturing dynamic states — prep sequences

## The gap this closes

A capture is one screenshot of one static state. Everything reached by *doing* something is
invisible to the harness: dropdowns, context menus, sheets, confirmation dialogs, the result
of a tap that fires an API call, empty-vs-populated states that depend on interaction.

That is not a small slice. Measured in `tutored` on 2026-08-16, with 29 captures and a
green-except-ratchet gate:

- the chat message context menu could not be asserted at all — it exists only after a
  long-press, and no capture reaches that state;
- the composer send control could not be asserted — the captured composer is empty, so the
  control is disabled and Flutter omits a disabled control's name from the semantics tree;
- the pronunciation play control could not be asserted — no capture contains a marker that
  produces one.

Three declared affordances, three "cannot verify". The checks were fine; the *state space*
was one state deep.

## The mechanism

`prep` — a NAMED step performed between "ready" and the screenshot, already shipped for
`open-drawer`. Extend it from a single step to an ordered sequence:

```json
{
  "id": "chat-message-menu",
  "web":    { "route": "/", "auth": "user", "ready": "header" },
  "mobile": { "route": "/", "auth": "user" },
  "prep": ["focus-composer", "type-text:hello", "long-press-message"]
}
```

Steps are named, never selectors. A selector in the manifest can only mean something on one
client; a name means the same thing on both, and each harness implements it with its own
finder. Arguments follow a colon.

### Starting vocabulary

Keep it small. Every name costs two implementations, and an unimplemented name must fail
loudly rather than be skipped.

| Step | Meaning |
|---|---|
| `open-drawer` | open the navigation drawer |
| `focus-composer` | put focus in the primary text input |
| `type-text:<s>` | type into the focused input |
| `long-press-message` | long-press the last transcript message |
| `open-message-menu` | open the surface's overflow / more-actions menu |
| `tap:<name>` | activate the control with that accessible name |

Name the INTENT, not the gesture. `open-message-menu` is a tap on a "More" button on both
clients here — an earlier version called it `long-press-message` and the mobile harness
duly long-pressed, which opened an image-preview dialog instead. The capture succeeded, the
byte floor passed, and it photographed the unchanged canvas. A gesture-named step invites
each client to implement a different feature.

## Non-negotiable rules

1. **Symmetric or nothing.** A capture declaring `prep` must have every step implemented on
   BOTH clients. A prep applied on one side only makes the two columns photograph different
   screens — the columns stop being comparable, and every finding afterwards is an artefact.
   This is worse than the duplicate captures the harness already fails on, because it looks
   like signal. (Rejected exactly this in `tutored` on 2026-08-16: a mobile-only drawer tap
   would have passed `duplicate-captures` by making the two sides incomparable.)
2. **An unknown step is a hard failure**, never a skip. A silently skipped prep produces a
   capture of the wrong state that still clears the byte floor — indistinguishable from
   success.
3. **Dynamic states are their own capture entries**, not variations of an existing one. The
   closed and open states of a menu are different screens with different jobs; collapsing
   them loses the closed state's coverage.
4. **Declare against the state you reached, not the control you pressed.** Opening a menu
   REPLACES the surface: after `open-message-menu` the opener is gone from the tree, so an
   affordance declared on the opener fails on the very capture that proves the menu works.
   Assert a menu ITEM.
5. **Settle before shooting.** A half-open menu differs run to run; a capture that is
   non-deterministic will be "fixed" by widening a tolerance, and the tolerance is what gets
   remembered.

## API-call parity

The web capture already records the endpoints a capture exercised
(`parity-out/api/<id>.json`). Once a `prep` step performs an *action*, that bag becomes the
record of what the action did — so a capture can assert not only "the menu opened" but
"activating this item called this endpoint".

The mirror client must emit an equivalent bag for this to be a comparison rather than a
one-sided note. Until it does, say so in the check's own output: a check that overstates
what it verified is worse than no check.

## Order of work

1. `prep` accepts an array; both harnesses iterate it. Unknown step → fail.
2. Add `focus-composer`, `type-text`, `long-press-message` to both.
3. Add capture entries for the states those unlock; declare their affordances in
   `interactive.affordances` and remove the corresponding waivers.
4. Only then `tap:` and API-bag assertions — those need the mirror client to record calls.
