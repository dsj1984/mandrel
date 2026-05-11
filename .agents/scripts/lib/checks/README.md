# `lib/checks/` — Self-Healing Checks Registry

This directory is the single discovery-based registry of named checks
consumed by every preflight guard, the `/diagnose` CLI, and the
`/epic-deliver` Phase 5 retro hook. One check per file. The runner
(`index.js`) loads them at process start and filters by scope at each
call site.

This README is the **authoritative contract**. New checks must conform to
the shape and the rules documented below. The runner enforces the two
load-bearing invariants in code (`retro` read-only, `refuse-and-print`
hard-refusal) — this document codifies the surrounding policy that the
runner cannot mechanically enforce.

## Contract

Each check module default-exports an object with this shape:

```js
// .agents/scripts/lib/checks/<id>.js
export default {
  id: 'stale-origin-epic',                            // unique kebab-case
  severity: 'blocker',                                // 'blocker' | 'warning' | 'info'
  scope: ['epic-close', 'story-close', 'retro'],      // surfaces this check runs on
  autoCorrect: 'refuse-and-print',                    // 'auto' | 'refuse-and-print'
  detect(state) {
    // returns a Finding object, or null when nothing is wrong.
    // state is the projection produced by assembleState({ scope }) in state.js
    // — read git/fs/env keys only; never re-probe the environment.
    return null;
  },
  async fix(state) {
    // OPTIONAL. Only invoked when autoCorrect === 'auto' AND scope !== 'retro'.
    // Must be local-bounded-reversible (see "Disallowed Fix Operations" below).
    return { ok: true, message: 'what was changed' };
  },
};
```

### `Finding` shape

```ts
type Finding = {
  id: string;              // mirrors the check id
  severity: 'blocker' | 'warning' | 'info';
  scope: string;           // the active scope that surfaced this finding
  summary: string;         // one-line human description
  detail?: string;         // multi-line context (paths, ref names, etc.)
  fixCommand: string;      // literal shell command the operator can copy-paste
  autoCorrectable: boolean;  // mirror of `autoCorrect === 'auto'`
};
```

The `fixCommand` field is mandatory even for `autoCorrect: 'auto'` checks
— the operator should always be able to read what the auto-fix would do
and run it themselves.

### Severity semantics

| Severity   | Effect at preflight guard | Effect at `/diagnose` | Effect at retro |
| ---------- | ------------------------- | --------------------- | ---------------- |
| `blocker`  | exits with code `2`       | listed; `--fail-on-blocker` exits `2` | listed in retro section |
| `warning`  | logged, does not block    | listed                | listed |
| `info`     | logged at high verbosity  | listed with `--verbose` | usually omitted |

## AutoCorrect Scope Rule

A check declaring `autoCorrect: 'auto'` is asserting that its `fix()` is
**local-bounded-reversible** — the operator can roll back the change with
a single obvious git/fs command, and the change does not leave any remote
or default-branch side effects.

The runner enforces three layers of defense around this:

1. `fix()` is never invoked unless `autoCorrect === 'auto'`. A check whose
   author adds a `fix` body later without flipping the flag is harmless.
2. `fix()` is never invoked when `scope === 'retro'` — the runner throws
   on `{ scope: 'retro', autoFix: true }` before any check runs.
3. The disallowed fix-operations list below codifies what `auto` may NOT
   do. New checks that violate it must be rewritten as `refuse-and-print`
   with a `fixCommand` the operator runs by hand.

### Disallowed Fix Operations

A check with `autoCorrect: 'auto'` and a `fix()` body MUST NOT:

- **No `git push`** to any remote, ever. The fix may write commits to a
  Story branch but never publish them. Publishing is the
  `story-close`/`epic-close` writer's job, and the auto-correct boundary
  is the local worktree.
- **No commits to `epic/*` or `main`**. The fix may touch the working
  tree on a Story branch, but it must not `git commit` against an
  integration branch. Cross-Story Stories share `epic/<id>`; an auto-fix
  there would race other writers.
- **No `git commit --amend`**. The fix may write a new commit; rewriting
  history is the operator's call. Amending hides the fix from `git log`
  and breaks `bisect`.
- **No `rm -rf` outside `.worktrees/<id>/` paths**. Cleaning up reaped
  worktree residue is the only blessed destructive operation. Any other
  recursive delete must be rewritten as a refusal with the destructive
  command in `fixCommand`.
- **No writes to remote GitHub state**. No `gh issue close`, no
  `gh pr merge`, no label transitions. The orchestration writers
  (`story-close.js`, `epic-close.js`) own that surface.
- **No reading of secret values**. State assembly returns `env`
  projections as `'set' | 'missing'` strings; checks must never read raw
  `process.env.X` for any name that could be a secret.

A check that needs any of the above must declare `autoCorrect:
'refuse-and-print'` and put the destructive command in `fixCommand`. The
operator runs it deliberately, and the audit trail lives in their shell
history rather than in the runner log.

## Retro Read-Only Invariant

The literal phrase: **retro scope is read-only**.

The `retro` scope is reserved. A check that opts into `scope: ['retro',
...]` is asserting it surfaces useful information at Epic retro time —
typically a probe of "did this failure mode resurface during the sprint?"
— and that surfacing happens with `autoFix: false`. The runner enforces:

```js
runChecks({ scope: 'retro', autoFix: true })  // throws synchronously
// Error: retro scope is read-only: autoFix must be false
```

The retro consumer in
[retro-runner.js](../orchestration/retro-runner.js) always passes
`autoFix: false`; the runner-side throw is defense-in-depth against a
future caller flipping the flag.

Retro-scoped checks SHOULD omit `fix()` entirely. If a check has a `fix()`
that is safe at preflight time but unsafe at retro time, declare the
check `autoCorrect: 'refuse-and-print'` so the flag-gate refuses to call
it everywhere, not just at retro.

## Adding a New Check — Worked Example

Suppose you want to add a check that fires when `origin/epic/<id>` is
stale relative to the local `epic/<id>` ref (the
`feedback_close_push_epic_first.md` failure mode).

1. Create `.agents/scripts/lib/checks/stale-origin-epic.js` with the
   contract shape:

   ```js
   /**
    * stale-origin-epic — refuse-and-print check.
    *
    * Detects the case where the local epic/<id> ref is ahead of
    * origin/epic/<id>. Surfacing this at story-close prevents the
    * close script from re-running its rebase against a stale base.
    */
   export default {
     id: 'stale-origin-epic',
     severity: 'blocker',
     scope: ['story-close', 'retro'],
     autoCorrect: 'refuse-and-print',
     async detect(state) {
       const local = state.git.epicBranches ?? [];
       if (local.length === 0) return null;
       // probe origin via state.git.* keys assembled by state.js
       // (omitted here — state.js owns the actual probe)
       const ahead = false;
       if (!ahead) return null;
       return {
         id: 'stale-origin-epic',
         severity: 'blocker',
         scope: state.scope,
         summary: 'Local epic/<id> is ahead of origin/epic/<id>',
         detail: 'Push the epic branch before re-running story-close.',
         fixCommand: 'git push origin epic/<id>',
         autoCorrectable: false,
       };
     },
   };
   ```

2. If the check needs new state, extend `state.js`'s scope key list (do
   NOT probe inside `detect()` — probes belong in `state.js` so they are
   memoized and scope-bounded).

3. Add a unit test at `tests/lib/checks/stale-origin-epic.test.js`. Drive
   `detect(state)` directly with a fixture state. Do NOT spin up a
   worktree.

4. If the check declares `autoCorrect: 'auto'`, add a `fix()` body and an
   integration test that asserts the fix is reversible. The runner-level
   integration tests (`tests/lib/checks/runner-integration.test.js`)
   cover the scope/refusal/retro invariants generically — new checks
   only need to test their own `detect` and `fix` behavior.

5. No registry edit required. `loadRegistry()` discovers the new file at
   process start.

## Module Boundary Rules

- One check per file. The filename should match the check id, kebab-case
  with a `.js` extension.
- `index.js` and `state.js` are runner infrastructure and are excluded
  from the discovery scan.
- Checks must not `import` from other check modules. Shared helpers
  belong in `state.js` (probes) or in a sibling `_helpers.js` if the
  helper is purely formatting (no probes).
- Checks must not maintain module-level mutable state. They share a
  `state` object passed by the runner; that is the only allowed input.

## Failure Modes the Runner Owns

These are enforced in `index.js` so check authors cannot accidentally
violate them:

| Invariant                                        | Where enforced            |
| ------------------------------------------------ | ------------------------- |
| `retro` scope is read-only (throws on autoFix)  | `runChecks` entry guard   |
| `refuse-and-print` never invokes `fix()`        | `runChecks` loop body     |
| Checks run serialized (no `Promise.all`)        | `runChecks` loop body     |
| Discovery filters out `index.js` / `state.js`   | `loadRegistry`            |
| Malformed checks fail loudly at load time       | `loadRegistry` validation |

If you are tempted to relax any of these in a new check, write a comment
on the parent Epic instead — the rule exists for a reason and the
runner-level enforcement is what makes the contract trustworthy across
many future check authors.
