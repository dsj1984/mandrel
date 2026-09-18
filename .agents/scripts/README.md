# `.agents/scripts/` — Script Catalog

The orchestration runtime lives under this directory. Most scripts are
invoked indirectly by `npm run …`, slash-command workflows
(`.agents/workflows/*.md`), or Husky / GitHub Actions hooks; you rarely
need to call them by hand.

This file is **not** an exhaustive index of the ~65 top-level entrypoints —
it is the orientation pointer for the directory. Every script documents
its own flags under `--help`, and each is reachable from a real caller:
search `package.json` scripts, `.agents/workflows/`, and the Husky /
GitHub Actions surfaces first.

**Only consumer-facing tooling ships here.** Every top-level CLI in this
directory is named by a consumer surface — a workflow, skill, rule, agent
file, template, `instructions.md`, the package's `bin/` / `lib/`, or a
string `lib/bootstrap/` writes into a consumer's `package.json` or hooks.
Mandrel's own contributor tooling (its lint and verify aggregates, test
diagnostics, CI-only ratchets and baseline-maintenance utilities) lives in
the repository's root `scripts/` directory, which is outside the npm
`files` array and never reaches a consumer. Mandrel's CI enforces that
boundary: a top-level CLI here that no consumer surface names fails it,
and so does any file under `.agents/` importing from outside `.agents/`.

The one script an operator-facing workflow drives **by name, repeatedly**, is
[`deliver-run.js`](deliver-run.js): one beat of a multi-Story
`/mandrel-deliver` run — it ticks the ready set from live state, writes each
ready Story's dispatch prompt under `<tempRoot>/run-<id>/`, keeps the run
ledger that replaces hand-maintained dispatch bookkeeping, and renders the
`single-story-close.js` command for every hand-off. Everything else in the
delivery chain (`resolve-stories.js`, `single-story-init.js`,
`single-story-close.js`, `stories-wave-tick.js`) is reached through it or
through a workflow step.

## See Also

- [`/.agents/README.md`](../README.md) — consumer user guide.
- [`/docs/architecture.md`](../../docs/architecture.md) — system
  architecture; the "Key Scripts" section lists the standard
  orchestration entrypoints.
- [`docs/quality-gates.md`](https://github.com/dsj1984/mandrel/blob/main/docs/quality-gates.md) — coverage,
  CRAP, and maintainability baselines + floors.
- `package.json` `scripts` — the canonical list of standard CLIs
  (`test`, `verify`, `coverage:update`, …).
