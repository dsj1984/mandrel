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

Standard operating procedures for robust, end-to-end (E2E) browser testing.

## 1. Core Principles

- **End-to-End focus:** Test the application as a user would, through the
  browser.
- **Auto-waiting:** Leverage Playwright's built-in auto-waiting instead of
  hardcoded `waitForTimeout` calls.
- **Resilience:** Write tests that survive minor UI changes (e.g., color tweaks)
  by using robust selectors.

## 2. Technical Standards

- **Locators:** Use user-visible locators (e.g., `getByRole`, `getByText`,
  `getByLabel`) over brittle CSS selectors or XPath.
- **State Management:** Use `storageState` to reuse authentication between
  tests, avoiding repetitive login flows.
- **Visual Testing:** Use `toHaveScreenshot()` for critical UI layouts to detect
  visual regressions.

## 3. Best Practices

- **Parallelism:** Ensure tests are independent so they can run concurrently to
  reduce CI time.
- **Tracing:** Enable trace recording on failure to quickly debug CI issues with
  the Playwright Trace Viewer.
- **Test Data:** Use a unique data set per test run or clean up state to prevent
  cross-contamination.
