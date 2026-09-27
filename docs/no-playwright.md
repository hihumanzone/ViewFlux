---
name: Playwright-Not-Available
description: This project drives UI verification through the browser MCP tools, not Playwright
---

# Playwright is not installed here

This repo has no Playwright dependency and no test runner. `npx playwright` /
`npx @playwright/test` / `playwright.config.ts` are not part of the toolchain and
should not be introduced for verification.

Use the `browser.*` MCP tools against the throwaway preview harness instead —
see [[Temporary-Preview-Harness]] for how to stand it up and the gotchas
(stale React state after `click()`, `tabs.focus` before screenshots, never
`remove()`-ing a React portal).

For DOM/behaviour assertions, `browser.evaluate` with an async page script is the
workhorse; for hover states use `browser.snapshot` to get an element ref, then
`browser.hover`, then read `getComputedStyle`.
