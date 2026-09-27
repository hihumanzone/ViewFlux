---
name: Temporary-Preview-Harness
description: How to stand up a throwaway visual-verification harness for this Electron renderer
---

# Temporary preview harness

The renderer has **no router library** (it uses its own hash router in
`lib/router.ts`), so `MemoryRouter` is not available — import pages directly.

## Files (both are temporary; delete before finishing)

- `src/renderer/preview.html` → `<div id="root">` + `<script type="module" src="/src/preview.tsx">`
- `src/renderer/src/preview.tsx` → stubs `window.api`, wraps a page in
  `<AppProvider>`, switches on `?page=`, then `createRoot(...).render(...)`

`AppProvider`'s mount does a `Promise.all` over `getSettings`, `getPlaylists`,
`getHistory`, `getSearchHistory`, `getSavedChannels`, `getChannelFolders` — **all
of them must be stubbed** or nothing renders.

## Run

```
npm run dev        # background; renderer dev server on :5173
```

Open `http://localhost:5173/preview.html?page=<key>`.

## Gotchas learned the hard way

- `setTimeout` is unavailable in the outer Code Mode runtime; only inside page scripts.
- After `element.click()`, a synchronous `document.querySelector` reads **stale
  React state**. Either `await new Promise(r => setTimeout(r, 200))` inside an
  async page script, or use `browser.click` (a separate round trip).
- `browser.wait` `text` matches visible text only — not placeholders or aria-labels.
- Call `browser.tabs.focus` before `browser.screenshot` or it fails with
  "Screenshot needs a visible tab".
- Vite sometimes serves a stale stylesheet to an open tab — `location.reload()`.
- Get an element's own ref for hover tests with
  `browser.snapshot({ tabID, ref: <parent ref>, depth: 4 })`.
- **Never** manually `remove()` a `.popover` node. It is a React portal; doing so
  throws `NotFoundError: Failed to execute 'removeChild'` and blanks the app.
  Press Escape instead.
- `browser.evaluate` cannot fake `:hover`. Use `browser.hover({ tabID, ref })` and
  read `getComputedStyle` afterwards.
