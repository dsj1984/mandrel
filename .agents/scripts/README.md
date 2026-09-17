# `.agents/scripts/` — Script Catalog

The orchestration runtime lives under this directory. Most scripts are
invoked indirectly by `npm run …`, slash-command workflows
(`.agents/workflows/*.md`), or Husky / GitHub Actions hooks; you rarely
need to call them by hand.

This file is **not** an exhaustive index of the ~90 top-level entrypoints —
it is the orientation pointer for the directory. Every script documents
its own flags under `--help`, and each is reachable from a real caller:
search `package.json` scripts, `.agents/workflows/`, and the Husky /
GitHub Actions surfaces first. `check-knip-entries.js` derives that
caller set mechanically, so a CLI no invoker names is dead, not
operator-only.

The one script an operator-facing workflow drives **by name, repeatedly**, is
[`deliver-run.js`](deliver-run.js): one beat of a multi-Story
`/mandrel-deliver` run — it ticks the ready set from live state, writes each
ready Story's dispatch prompt under `<tempRoot>/run-<id>/`, keeps the run
ledger that replaces hand-maintained dispatch bookkeeping, and renders the
`single-story-close.js` command for every hand-off. Everything else in the
delivery chain (`resolve-stories.js`, `single-story-init.js`,
`single-story-close.js`, `stories-wave-tick.js`) is reached through it or
through a workflow step.

`check-knip-entries.js` reads the entry list from whatever configuration knip itself would
load — `knip.json`, `knip.jsonc`, `.knip.json(c)`, `knip.ts`, `knip.js`,
`knip.config.ts`, `knip.config.js`, or `package.json#knip` — evaluating
TS/JS modules rather than parsing them, and counting entries declared
per-workspace as well as at the top level. A project with no knip
configuration at all exits 0 with a skip line, so the gate is safe to
wire everywhere; a configuration that exists but cannot be resolved
still exits 2.

## See Also

- [`/.agents/README.md`](../README.md) — consumer user guide.
- [`/docs/architecture.md`](../../docs/architecture.md) — system
  architecture; the "Key Scripts" section lists the standard
  orchestration entrypoints.
- [`.agents/docs/quality-gates.md`](../docs/quality-gates.md) — coverage,
  CRAP, and maintainability baselines + floors.
- `package.json` `scripts` — the canonical list of standard CLIs
  (`test`, `verify`, `coverage:update`, …).
