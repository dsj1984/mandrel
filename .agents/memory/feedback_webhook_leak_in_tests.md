---
name: Notifier/NotificationHook leak real webhook in tests
description: Tests that call any sprint-* entry point or runEpic with flat args can POST to the operator's real Slack webhook unless cwd + fetchImpl are stubbed OR notifications.level is set to off
type: feedback
originSessionId: 62cda403-5cc4-4d46-9117-6458f9377d85
---

# Notifier/NotificationHook leak real webhook in tests

The Notifier and NotificationHook constructors both call
`resolveWebhookUrl({ cwd })`, which falls back to reading `.mcp.json` at
`process.cwd()` when `cwd` is not passed. In this repo the root `.mcp.json`
contains a real `NOTIFICATION_WEBHOOK_URL` pointing at the operator's Slack.
Tests running from the repo root that reach Notifier construction *without*
overriding both `cwd` AND `fetchImpl` — OR without setting
`orchestration.notifications.level: 'off'` in the config — will POST to real
Slack on every emit.

**Why:** This is a recurring class of bug. Commit 59cc812 (2026-04-24) fixed
a first wave of leaks in `_build-ctx.js`. Two weeks later, leaks reappeared
from three additional surfaces and the operator saw Slack noise during
`/epic-execute` and `/git-push`:

1. `runEpic({ flatArgs })` with no `ctx` — constructs an `EpicRunnerContext`
   internally with `cwd: null` / `fetchImpl: null`. Fired for fantasy epics
   from `tests/epic-runner/parity.test.js`,
   `tests/epic-runner/dependency-source.test.js`, and
   `tests/epic-runner/epic-runner.integration.test.js`.
2. `runStoryInit({ injectedConfig })` without a sandboxed `cwd` —
   `story-init.js` defaults `cwd` to `PROJECT_ROOT` and constructs its own
   Notifier from there. Fired for fantasy tasks from
   `tests/story-orchestration.test.js`.
3. Historically: `_build-ctx.js` itself, when it didn't pre-stub the fields.

**How to apply:** When writing or reviewing any test that exercises
`runEpic`, `runStoryInit`, `runStoryClose`, or any `epic-*` / `story-*` /
`wave-*` CLI entry point under `.agents/scripts/` — not just code that
directly calls `createNotifier` / `new Notifier` / `new NotificationHook`:

1. **Preferred for epic-runner tests:** route through `buildCtx()` from
   `tests/epic-runner/_build-ctx.js`, which presets
   `cwd: '/nonexistent-epic-runner-test-cwd'` and a stub `fetchImpl`. Always
   use `runEpic({ ctx: buildCtx({ ... }), smokeTest })` — never
   `runEpic({ epicId, provider, config, spawn, ... })` with flat args.
2. **Preferred for sprint-story-init/close tests:** pass a sandboxed `cwd`
   (tmpdir) OR set `orchestration.notifications: { level: 'off' }` in the
   injected config. The `level: 'off'` shortcut is a one-line fix that
   covers every call site using a shared mockConfig.
3. For direct Notifier construction: inject both `cwd` (nonexistent path)
   and a stub `fetchImpl`.

`tests/epic-runner/_build-ctx.js` is the canonical safe-default factory for
epic-runner tests. `tests/lib/notifications/notifier.test.js` documents the
SAFE_CWD pattern — read it before writing new Notifier tests.

**Grep signal:** any of these patterns in test code is a probable leak:

- `runEpic({` with `epicId:` as a direct property (not `ctx:`)
- `runStoryInit(` / `runStoryClose(` without a `cwd:` override
- `new Notifier(` / `createNotifier(` / `new NotificationHook(` without a
  nearby `fetchImpl:` and `cwd:` line

Verify the test paths above before relying on them — the test layout has
moved into `tests/epic-runner/`, `tests/epic-execute/`, `tests/wave-execute/`,
`tests/story-execute/`, and `tests/story-close/` since the original incident.
