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

### `loc-delta.js`

**Purpose.** Verify the Skills-migration LOC budget — the signed line
delta between `main` and `HEAD` across the four SSOT directories
(`.agents/scripts/`, `.agents/skills/`, `.agents/workflows/`,
`.agents/README.md`) must be `< 0`.

**When to run.** Optional spot-check during framework refactors that
claim to retire code rather than add it. Originally an acceptance
criterion of Epic #1181 / Story #1441; kept available because the same
"net-negative LOC" check is occasionally useful when reviewing
maintenance Epics.

**Usage.**

```bash
node .agents/scripts/loc-delta.js                 # main...HEAD
node .agents/scripts/loc-delta.js --base main     # explicit base
node .agents/scripts/loc-delta.js --json          # machine output
```

Exits `0` iff total LOC delta `< 0`; exits `1` otherwise.

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

### `update-mutation-baseline.js`

**Purpose.** Refresh `baselines/mutation.json` from a fresh Stryker
run. Reads `delivery.quality.gates.mutation` from `.agentrc.json`,
invokes the in-repo Stryker runner, and atomically rewrites the
baseline.

**When to run.** Optional. Mutation testing is opt-in per consumer;
this is the equivalent of `npm run coverage:update` /
`npm run crap:update` / `npm run maintainability:update` for the
mutation gate. It is intentionally not wired into `package.json`
because most consumers do not configure Stryker.

**Usage.**

```bash
node .agents/scripts/update-mutation-baseline.js [--full-scope]
```

Exits `0` whether or not the baseline changed; exits `0` (with a
stderr explainer) when no Stryker config is present; exits `1` only
when Stryker itself fails to run.

## See Also

- [`/.agents/README.md`](../README.md) — consumer user guide.
- [`/docs/architecture.md`](../../docs/architecture.md) — system
  architecture; the "Key Scripts" section lists the standard
  orchestration entrypoints.
- [`.agents/docs/quality-gates.md`](../docs/quality-gates.md) — coverage,
  CRAP, and maintainability baselines + floors.
- `package.json` `scripts` — the canonical list of standard CLIs
  (`test`, `verify`, `coverage:update`, …).
