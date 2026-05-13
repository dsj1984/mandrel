# `.agents/schemas`

JSON Schema (draft 2020-12) files consumed by the mandrel
orchestration layer. Each schema is the **contract** for one structured
artefact — config files, runtime reports, persisted state. Where a runtime
AJV schema also exists, the JSON file is a mirror kept in sync via a
drift test.

## Schemas

### Structural Spec

- [`epic-spec.schema.json`](epic-spec.schema.json) — Canonical structural
  spec for an Epic and its children (Features, Stories, Tasks). Source of
  truth for the declarative `epic-yaml + reconciler` flow (Epic #1182).
  Lives on disk as `.agents/epics/<epic-id>.yaml`; the
  `epic-spec-reconciler` diffs it against live GitHub state and applies
  structural mutations behind a dry-run default. Slugs are stable,
  GH-incarnation-independent identifiers used for both intra-spec
  dependency edges and the spec ↔ GH-issue mapping persisted in the
  sibling `.agents/epics/<epic-id>.state.json`. Models structure only —
  execution-state labels (`agent::*`) are intentionally absent from this
  schema since that surface belongs to the wave-runner.

### Configuration

- [`agentrc.schema.json`](agentrc.schema.json) — `.agentrc.json` contract.
  Mirror of the runtime AJV schemas at
  `.agents/scripts/lib/config-schema.js` +
  `config-settings-schema.js`. Drift is enforced by
  `tests/config-schema-mirror-drift.test.js`.

### Runtime reports

- [`audit-results.schema.json`](audit-results.schema.json) — Audit run
  output.
- [`audit-rules.schema.json`](audit-rules.schema.json) — Audit rule
  catalogue (paired with `audit-rules.json`).
- [`crap-baseline.schema.json`](crap-baseline.schema.json),
  [`crap-report.schema.json`](crap-report.schema.json) — CRAP metric
  baseline + report shapes.
- [`mi-report.schema.json`](mi-report.schema.json) — Maintainability Index
  report shape.
- [`epic-perf-report.schema.json`](epic-perf-report.schema.json),
  [`story-perf-summary.schema.json`](story-perf-summary.schema.json) —
  Performance-signal reports (Epic #1185).
- [`friction-event.schema.json`](friction-event.schema.json),
  [`signal-event.schema.json`](signal-event.schema.json) — Per-event
  payload shapes for the friction + signal streams.
- [`validation-evidence.schema.json`](validation-evidence.schema.json) —
  Close-validation evidence bundle.

### Dispatch

- [`dispatch-manifest.json`](dispatch-manifest.json) — Schema for the
  per-Epic dispatch manifest written by `dispatcher.js`.

## Conventions

- **`$schema`** must reference draft 2020-12.
- **`$id`** must be the canonical GitHub blob URL for the file.
- **Every property must carry a `description`.** No undocumented surface.
- **`additionalProperties: false`** at every object level — schemas are
  closed contracts.
- **AGENT_LABELS exclusion.** Structural schemas (e.g. the epic spec)
  MUST NOT model `agent::*` labels — those are wave-runner-owned state,
  not structural intent.
