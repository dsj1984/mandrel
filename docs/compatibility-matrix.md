# Compatibility matrix

This page is the source of truth for the **supported install surface** of the
[`@mandrelai/agents`](https://www.npmjs.com/package/@mandrelai/agents) package: the
operating systems, Node.js versions, and package managers that the framework is
tested and supported against.

A combination is **supported** only when it is exercised by the
[`Install Matrix`](../.github/workflows/install-matrix.yml) CI workflow, which
packs this repo into a tarball, installs it into a throwaway consumer project
with each package manager on each OS, materializes `./.agents/` via
`mandrel sync`, and asserts the golden-path invariants
(`./.agents/` materialized, consumer manifest unpolluted, `mandrel doctor`
ready). Combinations outside the matrix may work but carry no support guarantee.

---

## Supported OS × package manager

The install matrix runs every package manager against every OS:

| OS | npm | pnpm | yarn (classic) |
| -- | --- | ---- | -------------- |
| Linux (`ubuntu-latest`) | ✅ Supported | ✅ Supported | ✅ Supported |
| Windows (`windows-latest`) | ✅ Supported | ✅ Supported | ✅ Supported |
| macOS | ⚠️ Expected to work, not CI-gated | ⚠️ Expected to work, not CI-gated | ⚠️ Expected to work, not CI-gated |

- **Linux and Windows** are first-class: each `{npm, pnpm, yarn} × {linux,
  windows}` leg runs on every pull request that touches the install surface
  and on every push to `main`.
- **macOS** is not part of the CI matrix. The package payload is plain,
  cross-platform JavaScript and a copy-only `mandrel sync` (no symlinks, no
  native build steps), so macOS is expected to work, but it is not gated and
  regressions there are not caught automatically.

`yarn` refers to **classic yarn** (the Corepack default for the `yarn` shim).
Yarn Berry (PnP) is not exercised by the matrix; if you use Berry, install in
`node-modules` linker mode so `mandrel sync` can resolve the package root from
`node_modules/@mandrelai/agents`.

---

## Supported Node.js versions

| Node.js | Status | Notes |
| ------- | ------ | ----- |
| 22.x (`>= 22.22.1`) | ✅ Supported | CI install matrix and the full test suite run on Node 22. |
| 23.x | ✅ Supported | Within the `engines` range; not separately CI-gated. |
| 24.x (`< 25`) | ✅ Supported | Within the `engines` range; not separately CI-gated. |
| < 22.22.1 | ❌ Unsupported | Below the `engines` floor — `npm` warns and orchestration preflight refuses. |
| >= 25 | ❌ Unsupported | Above the `engines` ceiling. |

The supported range is declared in the package's
[`engines`](../package.json) field as `>=22.22.1 <25` and enforced by the
bootstrap/orchestration preflight (Node major-version gate). The CI install
matrix pins **Node 22** as the representative tested version; 23 and 24 fall
within the declared range but are not separately gated.

---

## Package-manager notes

- **npm** — the reference package manager. `npm install @mandrelai/agents`
  runs the `postinstall` hook (best-effort `mandrel sync`) automatically
  unless `--ignore-scripts` is set.
- **pnpm** — supported. Enable it via Corepack (`corepack enable`) and use
  `pnpm add @mandrelai/agents`. `mandrel sync` resolves the package root from
  pnpm's `node_modules` layout, so it works under pnpm's symlinked store.
- **yarn (classic)** — supported. Enable via Corepack and use
  `yarn add @mandrelai/agents`.

In all three cases, if the lifecycle scripts are skipped (`--ignore-scripts`
or the equivalent), run `npx mandrel sync` afterward to materialize
`./.agents/`, then `npx mandrel doctor` to confirm the install is healthy.

---

## What "supported" guarantees

For every ✅ combination, the install matrix proves, on every relevant CI run,
that:

1. `./.agents/` is materialized after install + `mandrel sync`.
2. The consumer's `package.json` is **not** mutated with framework runtime
   dependencies.
3. `mandrel doctor` returns a **ready** verdict.

If you hit a failure on a supported combination, it is a framework bug — open
an issue at <https://github.com/dsj1984/mandrel/issues> with your OS, Node
version, and package manager.
