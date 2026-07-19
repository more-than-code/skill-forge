# Optional runtime bundle: Svelte 5 → custom elements → React wrappers

Only take this path when the user explicitly wants real component code in the Claude
Design runtime AND the component set suits it. It ships `_ds_bundle.js` (and per-
component `.d.ts` files) so the design agent renders the actual compiled Svelte code
instead of generic React.

## When it fits — and when it doesn't

Good fit: leaf components driven by props and simple text/element children — buttons,
badges, inputs, avatars, progress, cards with a single content area.

Poor fit (be honest, keep these spec-style):

- **Composition-heavy APIs** — multi-part components (`Dialog.Root`/`Trigger`/
  `Content`, menus, selects built from bits-ui parts). Their contract is Svelte
  snippets and context between parts; custom-element boundaries break that.
- **Global-utility styling with shadow DOM** — Tailwind classes on elements inside a
  shadow root get no styling unless the sheet is adopted into every root (handled
  below, but it bloats and can drift).
- **Portal/floating components** (tooltips, popovers) — they portal to `document.body`,
  outside the element.

A mixed sync is normal and correct: bundle the leaf components, spec-style the rest.
Per-component fallback, not all-or-nothing.

## Build steps

1. **Wrapper elements.** Components are rarely authored with `<svelte:options
   customElement>`. Generate a thin wrapper per component in a scratch dir:

   ```svelte
   <svelte:options customElement={{ tag: "ds-button", shadow: "open" }} />
   <script>
     import Button from "$lib/components/ui/button/button.svelte";
     let { ...props } = $props();
   </script>
   <Button {...props}>{@render props.children?.()}<slot /></Button>
   ```

   `shadow: "open"` keeps `<slot>` working (with `shadow: "none"` Svelte custom
   elements do not support slots). That means global CSS must be adopted into each
   shadow root — see step 3.

2. **Compile** the wrappers with Vite + `@sveltejs/vite-plugin-svelte`,
   `compilerOptions: { customElement: true }`, `build.lib` with `formats: ["iife"]`,
   `name` = the global. The IIFE must, on load: register every custom element and
   assign a namespace object to `window.<globalName>`.

3. **Adopt styles into shadow roots.** In the bundle entry, fetch/inline the built app
   CSS into a `CSSStyleSheet` and push it onto `shadowRoot.adoptedStyleSheets` for
   every registered element (a small base-class patch or a registry loop at
   define-time). Without this, every Tailwind-styled element renders unstyled inside
   the shadow root.

4. **React wrappers on the global.** The design agent codes against React components,
   not tags. Ship a tiny factory in the same bundle:

   ```js
   function reactify(React, tag, propNames) {
     return React.forwardRef(function CE(props, ref) {
       const innerRef = React.useRef(null);
       React.useImperativeHandle(ref, () => innerRef.current);
       React.useEffect(() => {
         const el = innerRef.current;
         for (const name of propNames) if (name in props) el[name] = props[name];
       });
       const { children, className, style } = props;
       return React.createElement(tag, { ref: innerRef, class: className, style }, children);
     });
   }
   ```

   Set props as **properties in an effect**, not attributes — React 18 sets unknown
   attributes as strings, which corrupts non-string props. Events: Svelte 5 callback
   props (`onclick`, `onOpenChange`) pass through as properties with the same
   mechanism. Expose `window.<Global>.Button = reactify(window.React, "ds-button",
   [...])` — resolve React from the host runtime (`window.React`), never bundle a
   second copy.

5. **Header + layout.** First line of `_ds_bundle.js`: `/* @ds-bundle: {"global":
   "<Global>"} */`. Emit `<Name>.d.ts` per bundled component with a `<Name>Props`
   interface describing the *wrapper's* React-visible props (derive from the Svelte
   `$props()` types). Spec-style components in the same sync get no `.d.ts`.

## Verification (stricter than spec-style)

The preview card for a bundled component must exercise the bundle, not SSR: the card
loads `_ds_bundle.js` and instantiates the custom element. Playwright-check each card
for console errors, blank render, and unstyled render (screenshot; compare against the
repo's own render of the same component — Storybook or an app route). A bundled
component that fails verification drops back to a spec-style card and its `.d.ts` is
removed — never ship an API contract for a component the runtime can't render
faithfully.

Record in NOTES.md which components shipped bundled vs spec-style, and why, so
re-syncs don't re-litigate.
