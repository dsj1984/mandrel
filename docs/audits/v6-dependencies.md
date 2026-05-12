# Dependency Audit Report — v6.0 Boundary

Snapshot: 2026-05-12 (Story #1598 / Epic #1184)

Tooling: `npm outdated`, `npm audit`, repo-wide import grep.

## Health Summary

- **Outdated Packages (pre-audit):** 6 (`@biomejs/biome`, `ajv`, `chokidar`,
  `lint-staged`, `memfs`, `typescript`).
- **Vulnerabilities:** Critical: 0, High: 0, Moderate: 0 (`npm audit` clean).
- **Unused Packages:** 0 — every entry in `dependencies` and `devDependencies`
  has at least one verified import path in the repo (see Rationale below).
- **Engines pin (new):** `node ">=22.22.1 <25"`.

## Engines pin rationale

`engines.node` was unset. CI runs on Node 22 (`.github/workflows/ci.yml`).
The new `lint-staged@17` floor is Node `>=22.22.1`, which becomes the hard
lower bound for the whole tree. Upper bound `<25` keeps us off an
un-tested major while permitting local Node 24 dev (current toolchain).

## Detailed Findings

### @biomejs/biome — 2.4.10 → 2.4.15

- **Dimension:** Patch (deferred during 5.x)
- **Impact:** Low
- **Rationale:** Patch series; bugfixes only, no rule semantic changes.
  `npm run lint` and `npm run format:check` still pass.

### ajv — 8.18.0 → 8.20.0

- **Dimension:** Minor (deferred)
- **Impact:** Low
- **Rationale:** Backwards-compatible bugfixes. Schema validation
  call-sites (`tests/schemas/*`, `manifest-schema.test.js`) unchanged.

### memfs — 4.57.1 → 4.57.2

- **Dimension:** Patch (deferred)
- **Impact:** Low
- **Rationale:** Patch release. fs-utils tests pass.

### chokidar — 4.0.3 → 5.0.0

- **Dimension:** Major (deferred)
- **Impact:** Medium
- **Rationale:** v5 raises Node floor to `>=20.19.0` — already satisfied
  by our new engines pin. The public surface (`watch`, `on`, `close`) used
  by `.agents/scripts/quality-watch.js` is unchanged; the watcher factory
  is dependency-injected so test suites stub `chokidar.watch` and never
  load the real module.

### lint-staged — 16.2.7 → 17.0.4

- **Dimension:** Major (deferred)
- **Impact:** Medium
- **Rationale:** v17 raises Node floor to `>=22.22.1` — drove the engines
  pin. Config shape (`package.json#lint-staged`, husky `pre-commit`) is
  v16-compatible; `tests/pre-commit-hook.test.js` exercises the hook end
  to end and stays green.

### typescript — held at 5.x

- **Dimension:** Major (NOT bumped)
- **Impact:** Deferred
- **Rationale:** `peerDependencies.typescript: ">=5.0.0"` is part of the
  package's public contract; bumping the floor to 6.x is a consumer-facing
  break that belongs in a separate Story with its own deprecation window.
  Internal `maintainability-utils.js` only reads `ts.version` and calls
  `transpileModule` — both stable across 5.x.

## Dependencies Inventory (post-audit)

| Package | Range | Used by |
| --- | --- | --- |
| js-yaml | ^4.1.1 | update-ticket-state, workers/{maintainability,crap}-worker |
| picomatch | ^4.0.4 | lint-baseline |
| string-argv | ^0.3.2 | update-ticket-state, workers/{maintainability,crap}-worker |
| typescript | >=5.0.0 | maintainability-utils (require) + peerDep |
| typhonjs-escomplex | ^0.1.0 | maintainability-utils |
| @biomejs/biome | ^2.4.15 | `npm run lint`, `npm run format` |
| ajv + ajv-formats | ^8.20.0 / ^3.0.1 | schema validation tests |
| c8 | ^11.0.0 | `.c8rc.cjs` coverage runner |
| chokidar | ^5.0.0 | quality-watch.js |
| husky | ^9.1.7 | `.husky/{pre-commit,pre-push}` |
| lint-staged | ^17.0.4 | pre-commit hook |
| markdownlint-cli | ^0.48.0 | `npm run lint:md` |
| memfs | ^4.57.2 | fs-utils, config-resolver, limits-override tests |

## Recommended Removals/Replacements

None this cycle. The tree is lean and every entry has a load-bearing
caller. Re-evaluate `typhonjs-escomplex` (low activity) the next time the
maintainability engine sees structural change.

## Verification

- `npm install` — clean install, 0 vulnerabilities, lockfile regenerated.
- `npm run lint` — green.
- `npm test` — green.
