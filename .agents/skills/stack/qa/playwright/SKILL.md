---
name: playwright
description:
  Robust E2E browser testing with Playwright. Use when writing browser-driven
  tests — leverage auto-waiting (no `waitForTimeout`), prefer user-visible
  locators (`getByRole`, `getByText`, `getByLabel`) over CSS/XPath, reuse
  `storageState` for auth, and enable trace-on-first-retry for CI debugging.
vendor: playwright
---

# Skill: Playwright

## Policy Capsule

- Rely on Playwright's auto-waiting; never use `waitForTimeout` or hardcoded sleeps to paper over flakes.
- Prefer user-visible locators (`getByRole`, `getByText`, `getByLabel`) over CSS selectors or XPath.
- Reuse `storageState` to seed authenticated scenarios; do not repeat login flows in every test.
- Use `toHaveScreenshot()` for critical visual surfaces; treat snapshot diffs as intentional reviews, not auto-refreshes.
- Write tests independent of one another so they run in parallel; clean up shared state in fixtures, not afterwards.
- Enable `trace: 'on-first-retry'` (or `'retain-on-failure'`) so CI failures are debuggable in the Trace Viewer.
- Use a unique data set per test run, or tear down state explicitly, to prevent cross-test contamination.
