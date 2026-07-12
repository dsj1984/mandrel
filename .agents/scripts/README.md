# `.agents/scripts/` — Script Catalog

The orchestration runtime lives under this directory. Most scripts are
invoked indirectly by `npm run …`, slash-command workflows
(`.agents/workflows/*.md`), or Husky / GitHub Actions hooks; you rarely
need to call them by hand.

This file is **not** an exhaustive index of the ~90 top-level entrypoints.
It documents the **operator-facing scripts** that operators may want to
run by hand and that are **not** wired into the standard quality / CI
surface. For everything else, search `package.json` scripts and
`.agents/workflows/` first.

## Operator Scripts

These scripts are kept in the distributed product but are intentionally
not invoked by `npm test`, `npm run verify`, CI, or any Husky hook. They
are optional operator tools; run them by hand when you need them.

### `validate-docs-freshness.js`

**Purpose.** Per-Epic documentation freshness gate. For each doc in
`delivery.docsFreshness.paths` + `project.docsContextFiles`, asserts
that the file was meaningfully updated during this Epic's lifecycle
(commit message references `#<epicId>` or the file body does).

**When to run.** Optional. Useful as a pre-merge spot check when an
Epic should have produced documentation updates; the standard
`/deliver` flow does **not** invoke this gate today.

**Usage.**

```bash
node .agents/scripts/validate-docs-freshness.js --epic <id> \
  [--base main] [--docs <comma-separated>] [--json]
```

## See Also

- [`/.agents/README.md`](../README.md) — consumer user guide.
- [`/docs/architecture.md`](../../docs/architecture.md) — system
  architecture; the "Key Scripts" section lists the standard
  orchestration entrypoints.
- [`.agents/docs/quality-gates.md`](../docs/quality-gates.md) — coverage,
  CRAP, and maintainability baselines + floors.
- `package.json` `scripts` — the canonical list of standard CLIs
  (`test`, `verify`, `coverage:update`, …).
