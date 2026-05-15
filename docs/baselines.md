# Baselines

This is the authoritative reference for the canonical baseline shape used
by every quality gate in the framework — `lint`, `coverage`, `crap`,
`maintainability`, `mutation`, `lighthouse`, and `bundle-size`. It covers
the envelope, the per-kind shapes, the component model, how paths are
canonicalised, the writer/reader contract, how consumers override floors,
and how kernel-version drift surfaces as friction.

Cross-references:

- [`docs/quality-gates.md`](quality-gates.md) — runtime behaviour of each
  gate (when it fires, what it asserts, how to refresh).
- [`docs/configuration.md`](configuration.md) — the `.agentrc.json`
  configuration surface that backs the gates.
- [`.agents/README.md`](../.agents/README.md) — consumer onboarding.

---

## Envelope

Every baseline file under `baselines/<kind>.json` shares the same
top-level envelope:

```json
{
  "$schema": ".agents/schemas/baselines/<kind>.schema.json",
  "kernelVersion": "1.1.0",
  "generatedAt": "2026-05-15T19:30:00.000Z",
  "rollup": {
    "*": { "<axis>": <number>, "...": <number> }
  },
  "rows": [
    { "path": "<repo-relative-path>", "<axis>": <number>, "...": <number> }
  ]
}
```

| Field           | Purpose                                                           |
| --------------- | ----------------------------------------------------------------- |
| `$schema`       | Per-kind JSON Schema path. Drives validation in the shared AJV.   |
| `kernelVersion` | Version stamp of the writer that produced the file. See below.    |
| `generatedAt`   | ISO 8601 timestamp; advisory — not load-bearing for gate logic.   |
| `rollup`        | Per-component aggregate keyed by component name. `*` is required. |
| `rows`          | Sorted, canonicalised per-file (or per-route/per-bundle) entries. |

The schemas live under [`.agents/schemas/baselines/`](../.agents/schemas/baselines/).
The shared AJV instance is built by `buildBaselineSchemaAjv()` in
[`.agents/scripts/lib/baseline-schema-registry.js`](../.agents/scripts/lib/baseline-schema-registry.js).

---

## Per-Kind Shapes

Each kind contributes a `rows[]` schema and a `rollup` axis set. The
authoritative declarations live in the per-kind modules at
[`.agents/scripts/lib/baselines/kinds/`](../.agents/scripts/lib/baselines/kinds/):

| Kind              | Key field | Row axes                                                       | Rollup axes                              |
| ----------------- | --------- | -------------------------------------------------------------- | ---------------------------------------- |
| `lint`            | `path`    | `errorCount`, `warningCount`                                   | `errorCount`, `warningCount`             |
| `coverage`        | `path`    | `lines`, `branches`, `functions`, `statements`                 | `lines`, `branches`, `functions`         |
| `crap`            | `path`    | `method`, `startLine`, `crap`                                  | `max`, `p95`, `methodsAboveCeiling`      |
| `maintainability` | `path`    | `maintainability`                                              | `min`, `p50`, `p95`                      |
| `mutation`        | `path`    | `score`, `killed`, `survived`, `noCoverage`, `timeout`, `total`| `score`, `survived`, `noCoverage`        |
| `lighthouse`      | `route`   | `route`, `performance`, `accessibility`, `bestPractices`, `seo`| per-category scores                      |
| `bundle-size`     | `bundle`  | `bundle`, `bytes`, `gzippedBytes`                              | `bytes`, `gzippedBytes`                  |

The `keyField` is the per-row identifier the writer canonicalises and the
component grouper matches against (see below). Lighthouse keys rows on
`route`; bundle-size keys on `bundle`; every other kind keys on `path`.

---

## Component Model

A component is a named bucket of rows that share a floor and a tolerance.
Components let an operator slice a baseline so per-component floors can
be evaluated independently (e.g. `api`, `worker`, `infra` each with its
own coverage floor).

Shape:

```json
"components": {
  "<name>": ["<glob>", "<glob>", "..."]
}
```

Rules:

- The component literally named `*` is the **whole-repo bucket** and
  captures every row regardless of declared globs. Every baseline emits
  `rollup['*']` for backwards compatibility with pre-component gates.
- Glob matching uses
  [`minimatch`](https://github.com/isaacs/minimatch) with `dot: true`.
- **Overlap is allowed by design** — a row matched by two components is
  reported under both.
- When a gate omits `components`, the default is `{ "*": ["**"] }`. The
  resolver lives in
  [`.agents/scripts/lib/baselines/components.js`](../.agents/scripts/lib/baselines/components.js)
  (`resolveComponents` + `groupRows`).

---

## Path Canonicalisation

Every path-like field in a baseline (`rows[].path`, `rows[].route`,
`rows[].bundle`) is canonicalised to a forward-slashed, repo-relative
form before it is written:

- Windows backslashes are normalised to forward slashes.
- Leading `./` is stripped.
- A `.worktrees/<workspace>/` prefix — which would leak into a hand-edit
  made inside a story worktree — is stripped.
- Absolute paths are rejected (the writer throws rather than silently
  rewrite identity).

The canonicaliser lives at
[`.agents/scripts/lib/baselines/path-canon.js`](../.agents/scripts/lib/baselines/path-canon.js).
The reader applies a defensive second pass (`canonicaliseRowPath`) when
loading so downstream consumers never have to special-case the worktree
prefix.

---

## Writer/Reader Contract

The single funnel for **writing** a baseline is
[`.agents/scripts/lib/baselines/writer.js`](../.agents/scripts/lib/baselines/writer.js)
— `write({ kind, rows, components, kernelVersion?, generatedAt? })`:

1. Resolve the per-kind module from the kernel registry.
2. Project every row through `projectRow` (which canonicalises the key
   field and asserts the result with `assertCanonical`).
3. Sort the rows deterministically for stable on-disk diffs.
4. Compute the per-component rollup, always including `*`.
5. Stamp `$schema`, `kernelVersion`, and `generatedAt` via
   `buildEnvelope`.
6. Validate the envelope against the per-kind schema via the shared AJV.
7. Return the envelope. `writeFile(absPath, envelope)` is the separate
   serialise + atomic-rename seam.

The single funnel for **reading** a baseline is
[`.agents/scripts/lib/baselines/reader.js`](../.agents/scripts/lib/baselines/reader.js)
— `reader.load(kind, { cwd?, configPath? })`:

1. Resolve the on-disk path from `delivery.quality.gates.<kind>.baselinePath`,
   falling back to the canonical default (`baselines/<kind>.json`).
2. Read the file as UTF-8 JSON.
3. Validate against the per-kind schema.
4. Apply the defensive path canonicalisation pass to `rows[]`.
5. Return `{ rollup, rows, kernelVersion, generatedAt }`.

Every gate (`check-lint.js`, `check-coverage-baseline.js`, `check-crap.js`,
`check-maintainability.js`, `check-mutation.js`, the unified
`check-baselines.js`, the audit-suite delta emitter, and the per-component
drift signals) reads through this module — no gate opens
`JSON.parse(readFileSync(...))` of a baseline directly.

`loadFile(absolutePath, { kind? })` is the same contract for ad-hoc
fixture paths; the kind is inferred from `$schema` when not supplied.

---

## Floor Overrides

Consumers override floors per gate in `.agentrc.json` under
`delivery.quality.gates.<kind>`:

```json
{
  "delivery": {
    "quality": {
      "gates": {
        "coverage": {
          "floors": {
            "*": { "lines": 90, "branches": 85, "functions": 90 },
            "api": { "lines": 95, "branches": 90, "functions": 95 }
          },
          "components": {
            "api": ["src/api/**", "src/server/**"]
          }
        }
      }
    }
  }
}
```

Behaviour:

- `floors['*']` is the whole-repo floor. Every gate falls back to `*`
  when a component-scoped floor is not declared.
- A per-component floor overrides `*` for that component only. Other
  components still inherit `*`.
- The `components` map is optional. When omitted, the default
  `{ "*": ["**"] }` applies and only `*` rows are ever evaluated.
- The unified `check-baselines.js` reports breaches per component, with
  `*` always present in the output. The per-component progress signals
  (`crap-drift.js#detectComponentRegressions`,
  `maintainability-drift.js#detectComponentRegressions`) name the
  breached component in their bullet so a `*` rollup is not falsely
  implicated when only a component-scoped floor was crossed.

For the full configuration surface (every gate-level key with defaults
and types) see [`docs/configuration.md`](configuration.md) and the
`agentSettings.quality.*` section.

### Shipped surface vs follow-up

The unified [`check-baselines.js`](../.agents/scripts/check-baselines.js)
currently ships **floor + tolerance + schema + kernel-mismatch** logic
only. It does **not** absorb the full regression-detection / scope /
git-base-ref logic that still lives in the per-kind `check-<kind>.js`
CLIs — those remain operational and branch protection requires both.
Full regression absorption and per-kind CLI deletion are tracked in
follow-up **Epic #1943**. Until then, consumers wire both `baselines`
and the per-kind checks into their branch protection (see
`.agentrc.json` → `github.branchProtection.requiredChecks`).

---

## Kernel-Version Friction

Every per-kind module exports a `kernelVersion()` function that returns
the writer's version of the analysis it produces. The writer stamps the
version on the envelope; the reader returns it; the unified gate
compares it against the running kernel.

When `baseline.kernelVersion !== runningKernelVersion`, the gate emits a
`baseline-kernel-mismatch` friction signal (suppressed with
`--no-friction`) but does **not** change its exit code — kernel drift is
advisory. The friction record points the reviewer at the regenerate
workflow for the kind in question.

Refresh paths:

- `npm run test:coverage` — rewrites `baselines/coverage.json`.
- `node .agents/scripts/update-crap-baseline.js` — rewrites
  `baselines/crap.json`.
- `node .agents/scripts/update-maintainability-baseline.js` — rewrites
  `baselines/maintainability.json`.
- `node .agents/scripts/lint-baseline.js --write` — rewrites
  `baselines/lint.json`.

After a kernel bump, regenerate every baseline whose `kernelVersion`
drifted, then commit the refreshed files. The writer guarantees
deterministic ordering and canonical paths, so the diff is the kernel
delta and nothing else.

---

## See also

- [`docs/quality-gates.md`](quality-gates.md) — when each gate fires and
  how to opt out.
- [`docs/configuration.md`](configuration.md) — full `.agentrc.json`
  surface.
- [`.agents/scripts/lib/baselines/`](../.agents/scripts/lib/baselines/) —
  source of truth for the writer, reader, kernel registry, components
  resolver, envelope schemas, and per-kind modules.
