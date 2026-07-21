# Injectable Test Seams

This rule applies when writing or modifying scripts under
`.agents/scripts/lib/` that perform filesystem I/O or spawn child processes.

## Motivation

Functions that hard-bind `fs` or `spawnSync` at module scope cannot be unit-
tested without side-effecting the real filesystem or spawning real processes.
The injectable-seam pattern threads replaceable implementations through a
default-param `deps` object so tests substitute stubs while production code
continues to call the real Node built-ins with zero configuration change.

## The Pattern

Each function that performs I/O accepts an optional final parameter named
`deps` (or named individual dep params such as `fsImpl`, `spawnImpl`) that
defaults to the real implementation:

```js
import fs from 'node:fs';
import { spawnSync as defaultSpawnSync } from 'node:child_process';

export function ensureSomething(ctx, { fsImpl = fs, spawnImpl = defaultSpawnSync } = {}) {
  if (fsImpl.existsSync(ctx.target)) return { action: 'already-present' };
  fsImpl.writeFileSync(ctx.target, ctx.body, 'utf8');
  return { action: 'created' };
}
```

### Canonical In-Repo Reference

`.agents/scripts/lib/bootstrap/project-bootstrap.js` (its exported step
functions) is the established in-repo baseline for this pattern.

## Rules

1. **Default to the real impl.** The default value MUST be the real built-in so
   callers (bootstrap CLI, integration tests) require no change.
2. **One seam per I/O surface.** Filesystem access uses `fsImpl`; child-process
   spawning uses `spawnImpl`. Do not bundle them into a single opaque deps
   object unless the function is exclusively internal (not exported).
3. **No module-level seam state.** Seam parameters live on individual functions,
   not on a shared module-level variable. Module-level variables are reset only
   on re-import, which makes parallel test isolation impossible.
4. **Re-export the real impl when a helper wraps it.** If a private helper
   (`readJsonIfExists`, `writeJson`) receives `fsImpl`, it must accept and
   forward the seam — not re-acquire `fs` at call time.
5. **Tests inject stubs via the parameter, never via module mocking.** Prefer
   passing a plain object `{ existsSync: () => false, readFileSync: () => '' }`
   over `mock.module()` / `jest.mock()` so tests remain isolated and
   parallelizable.

## Where It Applies

- `.agents/scripts/lib/bootstrap/project-bootstrap.js` (primary consumer of
  this rule — every exported step function).
- Any new helper in `.agents/scripts/lib/` that touches the filesystem or
  spawns a process.
