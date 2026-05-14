/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

import Ajv from 'ajv';

import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';

const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
};

const NULLABLE_SAFE_STRING = {
  type: ['string', 'null'],
  not: { type: 'string', pattern: SHELL_INJECTION_PATTERN_STRING },
};

/**
 * Optional commands that may be `null` to mean "disabled" but, when set as a
 * string, must be non-empty. `minLength` is a string-only keyword so it is a
 * no-op for `null`; the empty string is explicitly rejected.
 */
const NULLABLE_NONEMPTY_SAFE_STRING = {
  type: ['string', 'null'],
  minLength: 1,
  not: { type: 'string', pattern: SHELL_INJECTION_PATTERN_STRING },
};

/** A list-valued config key may be a plain array (replace) or an extender
 * object `{ append, prepend }` that deep-merges with framework defaults. */
const LIST_OR_EXTENDER_OF_STRINGS = {
  oneOf: [
    { type: 'array', items: { type: 'string' } },
    {
      type: 'object',
      properties: {
        append: { type: 'array', items: { type: 'string' } },
        prepend: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  ],
};

/**
 * Backwards-compatible export used by a handful of call sites that historically
 * scanned the schema for string-shaped fields. Post-reshape, the only
 * top-level flat string field of the legacy agentSettings bag is gone; the
 * export is kept (empty) so old imports don't fail.
 */
export const AGENT_SETTINGS_STRING_FIELDS = Object.freeze([]);

// ---------------------------------------------------------------------------
// project.* — identity, conventions, commands
// ---------------------------------------------------------------------------

/**
 * `project.paths` carries the three required filesystem roots. The seven
 * legacy `*Root` subdirectory keys and the legacy `auditOutputDir` were
 * dropped — every `${dir}Root` is derived at runtime as `${agentRoot}/<dir>`
 * and `auditOutputDir` is derived as `${tempRoot}/audit`.
 */
const PATHS_SCHEMA = {
  type: 'object',
  required: ['agentRoot', 'docsRoot', 'tempRoot'],
  properties: {
    agentRoot: { ...SAFE_STRING, minLength: 1 },
    docsRoot: { ...SAFE_STRING, minLength: 1 },
    tempRoot: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

/**
 * `project.commands` — names of the lint/test/typecheck/format commands the
 * close-validation chain spawns. `typecheck` accepts `null` to mean
 * "disabled". `validate` and `build` were dropped (no production consumers).
 */
const COMMANDS_SCHEMA = {
  type: 'object',
  properties: {
    lintBaseline: { ...SAFE_STRING, minLength: 1 },
    test: { ...SAFE_STRING, minLength: 1 },
    typecheck: NULLABLE_NONEMPTY_SAFE_STRING,
    formatCheck: { ...SAFE_STRING, minLength: 1 },
    formatWrite: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

const PROJECT_SCHEMA = {
  type: 'object',
  required: ['paths'],
  properties: {
    baseBranch: SAFE_STRING,
    paths: PATHS_SCHEMA,
    docsContextFiles: { type: 'array', items: { type: 'string' } },
    commands: COMMANDS_SCHEMA,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// github.* — provider identity, bootstrap, notifications
// ---------------------------------------------------------------------------

/**
 * Curated webhook event vocabulary. The webhook channel is gated by an
 * explicit allowlist of event names — the webhook narrative is "epic %
 * progress + blockers", not the firehose of per-story transitions that the
 * GitHub-comment channel still receives.
 */
export const WEBHOOK_EVENT_NAMES = Object.freeze([
  'epic-started',
  'epic-progress',
  'epic-blocked',
  'epic-unblocked',
  'epic-complete',
]);

/**
 * Curated GitHub-comment event vocabulary. The comment channel is gated by
 * an explicit allowlist of event names — same model as `webhookEvents`.
 */
export const COMMENT_EVENT_NAMES = Object.freeze([
  'state-transition',
  'story-merged',
  'operator-message',
]);

const NOTIFICATIONS_SCHEMA = {
  type: 'object',
  properties: {
    mentionOperator: { type: 'boolean' },
    commentEvents: {
      type: 'array',
      items: { type: 'string', enum: [...COMMENT_EVENT_NAMES] },
      uniqueItems: true,
    },
    webhookEvents: {
      type: 'array',
      items: { type: 'string', enum: [...WEBHOOK_EVENT_NAMES] },
      uniqueItems: true,
    },
  },
  additionalProperties: false,
};

const BRANCH_PROTECTION_CHECK_SCHEMA = {
  type: 'object',
  required: ['name', 'cmd'],
  properties: {
    name: { type: 'string', minLength: 1 },
    cmd: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
  },
  additionalProperties: false,
};

const BRANCH_PROTECTION_SCHEMA = {
  type: 'object',
  properties: {
    enforce: { type: 'boolean' },
    requiredChecks: {
      type: 'array',
      items: BRANCH_PROTECTION_CHECK_SCHEMA,
    },
  },
  additionalProperties: false,
};

const MERGE_METHODS_SCHEMA = {
  type: 'object',
  properties: {
    allow_squash_merge: { type: 'boolean' },
    allow_rebase_merge: { type: 'boolean' },
    allow_merge_commit: { type: 'boolean' },
    allow_auto_merge: { type: 'boolean' },
    delete_branch_on_merge: { type: 'boolean' },
  },
  additionalProperties: false,
};

const GITHUB_SCHEMA = {
  type: 'object',
  required: ['owner', 'repo'],
  properties: {
    owner: { type: 'string', minLength: 1 },
    repo: { type: 'string', minLength: 1 },
    projectNumber: { type: ['integer', 'null'], minimum: 1 },
    projectOwner: { type: ['string', 'null'], minLength: 1 },
    operatorHandle: { type: 'string', pattern: '^@.+' },
    branchProtection: BRANCH_PROTECTION_SCHEMA,
    mergeMethods: MERGE_METHODS_SCHEMA,
    notifications: NOTIFICATIONS_SCHEMA,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// planning.* — inputs to /epic-plan
// ---------------------------------------------------------------------------

/**
 * `planning.context` — bounded planning-context budget for `--emit-context`
 * payloads. When the full payload would exceed `maxBytes`, planners switch
 * to a summary representation.
 */
const PLANNING_CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    maxBytes: { type: 'integer', minimum: 1024 },
    summaryMode: { type: 'string', enum: ['auto', 'always', 'never'] },
  },
  additionalProperties: false,
};

const PLANNING_SCHEMA = {
  type: 'object',
  properties: {
    riskHeuristics: LIST_OR_EXTENDER_OF_STRINGS,
    maxTickets: { type: 'integer', minimum: 1 },
    context: PLANNING_CONTEXT_SCHEMA,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// delivery.* — /epic-deliver + story-execute consume
// ---------------------------------------------------------------------------

const EXECUTION_SCHEMA = {
  type: 'object',
  properties: {
    timeoutMs: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

const DOCS_FRESHNESS_SCHEMA = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { ...SAFE_STRING, minLength: 1 },
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.deliverRunner` — bounded-concurrency knob for the epic-deliver
 * fan-out. Flattened post-reshape — no `runners.` wrapper, no `enabled`
 * field (operators dial concurrency directly).
 */
const DELIVER_RUNNER_SCHEMA = {
  type: 'object',
  properties: {
    concurrencyCap: { type: 'integer', minimum: 1 },
    progressReportIntervalSec: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

const WORKTREE_ISOLATION_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    root: { type: 'string', minLength: 1 },
    nodeModulesStrategy: {
      type: 'string',
      enum: ['per-worktree', 'symlink', 'pnpm-store'],
    },
    primeFromPath: { type: ['string', 'null'], minLength: 1 },
    allowSymlinkOnWindows: { type: 'boolean' },
    reapOnSuccess: { type: 'boolean' },
    reapOnCancel: { type: 'boolean' },
    bootstrapFiles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  additionalProperties: false,
  // `root` is required only when isolation is explicitly enabled.
  allOf: [
    {
      if: {
        properties: { enabled: { const: true } },
        required: ['enabled'],
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then keyword
      then: { required: ['root'] },
    },
  ],
};

/**
 * `delivery.signals` — detector thresholds for the three surviving
 * performance-signal categories. `churn` and `idle` were dropped (low
 * signal-to-noise). Each block is shallow-merged by the resolver.
 */
const SIGNALS_SCHEMA = {
  type: 'object',
  properties: {
    hotspot: {
      type: 'object',
      properties: {
        p95Multiplier: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    rework: {
      type: 'object',
      properties: {
        editsPerFile: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    retry: {
      type: 'object',
      properties: {
        repeatCount: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * Object-shaped tolerance: `{ kind: 'absolute' | 'percent', value: number }`.
 * Story #1737 (Epic #1720 Story 2) migrated every gate's scalar tolerance
 * to this uniform shape — scalar numbers are now rejected by the schema.
 * `absolute` carries an additive band (e.g. CRAP +0.05 over baseline);
 * `percent` carries a multiplicative band (e.g. 5% bundle-size growth
 * over baseline).
 */
const TOLERANCE_SCHEMA = {
  type: 'object',
  required: ['kind', 'value'],
  properties: {
    kind: { type: 'string', enum: ['absolute', 'percent'] },
    value: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

/**
 * Workspace-keyed floors object. The `"*"` key is the single-workspace
 * default; real workspace names handle monorepo consumers. Story #1737
 * made the object shape mandatory (scalar / flat shapes are rejected by
 * the schema) so the generic applier in `lib/quality-floors.js` walks one
 * codepath regardless of repo layout.
 *
 * `floorValues` is the per-workspace bag — the metric names (`lines`,
 * `branches`, etc.) vary per gate so the bag itself stays open
 * (`additionalProperties: { type: 'number' }`). Each gate's checker
 * validates the metric names it expects.
 */
const FLOORS_SCHEMA = {
  type: 'object',
  // Require the catch-all key so consumers cannot silently ship an empty
  // floors block that disables the floor gate. Workspace overrides are
  // optional and validated alongside the catch-all.
  required: ['*'],
  additionalProperties: {
    type: 'object',
    additionalProperties: { type: 'number' },
  },
};

const BASELINE_ENTRY_SCHEMA = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { ...SAFE_STRING, minLength: 1 },
    refreshCommand: NULLABLE_NONEMPTY_SAFE_STRING,
  },
  additionalProperties: false,
};

/**
 * Shared base for every `delivery.quality.gates.<tier>` entry. Each gate
 * declares the same four fields:
 *
 *   - `enabled`      — when `false`, the checker exits 0 with a skip line.
 *   - `baselinePath` — repo-root-relative path to the gate's baseline file.
 *                      Resolved against the project root, not the CWD.
 *   - `tolerance`    — `{ kind, value }` band before the gate fails.
 *   - `floors`       — workspace-keyed absolute floor object; `"*"` is the
 *                      single-workspace default.
 *
 * Gate-specific extras (e.g. `targetDirs` for crap/MI, `routes` for
 * lighthouse, `bundles` for bundleSize, `coveragePath` for coverage)
 * layer on top via per-gate schemas below.
 */
const GATE_BASE_PROPERTIES = {
  enabled: { type: 'boolean' },
  baselinePath: { ...SAFE_STRING, minLength: 1 },
  tolerance: TOLERANCE_SCHEMA,
  floors: FLOORS_SCHEMA,
};

const LINT_GATE_SCHEMA = {
  type: 'object',
  properties: { ...GATE_BASE_PROPERTIES },
  additionalProperties: false,
};

/**
 * Coverage gate. Owns `coveragePath` (the artifact location read by the
 * coverage gate and, downstream, the CRAP gate). Story #1737 moved
 * `coveragePath` from `crap` to `coverage` — coverage is the upstream
 * artifact, crap is the derivative metric.
 */
const COVERAGE_GATE_SCHEMA = {
  type: 'object',
  properties: {
    ...GATE_BASE_PROPERTIES,
    coveragePath: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

/**
 * CRAP gate. Carries the historical scoring knobs (`targetDirs`,
 * `newMethodCeiling`, `requireCoverage`, `friction.markerKey`,
 * `refreshTag`). Reads `coveragePath` from `gates.coverage` rather than
 * carrying its own (Story #1737).
 */
const CRAP_GATE_SCHEMA = {
  type: 'object',
  properties: {
    ...GATE_BASE_PROPERTIES,
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
    newMethodCeiling: { type: 'integer', minimum: 1 },
    requireCoverage: { type: 'boolean' },
    friction: {
      type: 'object',
      properties: { markerKey: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    refreshTag: { ...SAFE_STRING, minLength: 1 },
  },
  // CRAP rejects `coveragePath` — it now lives on `gates.coverage`.
  additionalProperties: false,
};

const MAINTAINABILITY_GATE_SCHEMA = {
  type: 'object',
  properties: {
    ...GATE_BASE_PROPERTIES,
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
  },
  additionalProperties: false,
};

/**
 * Mutation gate. Stryker is the only mutation runner today. The schema
 * intentionally does not carry a `runner` enum — if a second runner ever
 * ships, it lands behind a new key rather than overloading this gate.
 */
const MUTATION_GATE_SCHEMA = {
  type: 'object',
  properties: {
    ...GATE_BASE_PROPERTIES,
    strykerConfigPath: NULLABLE_NONEMPTY_SAFE_STRING,
  },
  additionalProperties: false,
};

/**
 * Lighthouse gate. `routes` is an array of repo-relative URL paths that the
 * checker probes; the gate emits a skip line and exits 0 when the array
 * is empty.
 */
const LIGHTHOUSE_ROUTE_SCHEMA = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1 },
    formFactor: { type: 'string', enum: ['mobile', 'desktop'] },
  },
  additionalProperties: false,
};

const LIGHTHOUSE_GATE_SCHEMA = {
  type: 'object',
  properties: {
    ...GATE_BASE_PROPERTIES,
    baseUrl: NULLABLE_NONEMPTY_SAFE_STRING,
    routes: { type: 'array', items: LIGHTHOUSE_ROUTE_SCHEMA },
  },
  additionalProperties: false,
};

/**
 * Bundle-size gate. `bundles` is a list of bundle declarations the checker
 * measures; the gate emits a skip line and exits 0 when empty.
 */
const BUNDLE_DECLARATION_SCHEMA = {
  type: 'object',
  required: ['name', 'path', 'limit'],
  properties: {
    name: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    limit: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const BUNDLE_SIZE_GATE_SCHEMA = {
  type: 'object',
  properties: {
    ...GATE_BASE_PROPERTIES,
    bundles: { type: 'array', items: BUNDLE_DECLARATION_SCHEMA },
  },
  additionalProperties: false,
};

const GATES_SCHEMA = {
  type: 'object',
  properties: {
    lint: LINT_GATE_SCHEMA,
    coverage: COVERAGE_GATE_SCHEMA,
    crap: CRAP_GATE_SCHEMA,
    maintainability: MAINTAINABILITY_GATE_SCHEMA,
    mutation: MUTATION_GATE_SCHEMA,
    lighthouse: LIGHTHOUSE_GATE_SCHEMA,
    bundleSize: BUNDLE_SIZE_GATE_SCHEMA,
  },
  additionalProperties: false,
};

const CODING_GUARDRAILS_SCHEMA = {
  type: 'object',
  properties: {
    cyclomaticFlag: { type: 'integer', minimum: 1 },
    cyclomaticMustFix: { type: 'integer', minimum: 1 },
    miDropMustRefactor: { type: 'number', minimum: 0 },
    requireSiblingTest: { type: 'boolean' },
  },
  additionalProperties: false,
};

const AUTO_REFRESH_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    miDropCap: { type: 'number', minimum: 0 },
    crapJumpCap: { type: 'number', minimum: 0 },
    scope: { type: 'string', enum: ['diff', 'full'] },
  },
  additionalProperties: false,
};

/**
 * `delivery.quality` — uniform per-gate shape (Story #1737).
 *
 * Every gate lives under `gates.<tier>` and shares the four-field base:
 * `{ enabled, baselinePath, tolerance: { kind, value }, floors: { "*": {...} } }`.
 * Shared scoping lives at the block root (`gateScoping`). The legacy
 * top-level `crap`, `maintainability`, `qualityFloors`, and `baselines`
 * keys are gone — replaced by the gate-shaped equivalents.
 */
const QUALITY_SCHEMA = {
  type: 'object',
  properties: {
    gateScoping: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['diff', 'full'] },
        diffRef: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    gates: GATES_SCHEMA,
    codingGuardrails: CODING_GUARDRAILS_SCHEMA,
    autoRefresh: AUTO_REFRESH_SCHEMA,
  },
  additionalProperties: false,
};

const DELIVERY_SCHEMA = {
  type: 'object',
  properties: {
    execution: EXECUTION_SCHEMA,
    maxTokenBudget: { type: 'integer', minimum: 1 },
    docsFreshness: DOCS_FRESHNESS_SCHEMA,
    deliverRunner: DELIVER_RUNNER_SCHEMA,
    worktreeIsolation: WORKTREE_ISOLATION_SCHEMA,
    signals: SIGNALS_SCHEMA,
    quality: QUALITY_SCHEMA,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Top-level: { project, github, planning, delivery }
// ---------------------------------------------------------------------------

/**
 * The top-level `.agentrc.json` shape, post-reshape (Epic #1720 Story #1739).
 *
 * The four blocks mirror SDLC phases:
 *   - `project`  — identity, paths, commands, docs context.
 *   - `github`   — provider identity, branch protection, merge methods,
 *                  notifications.
 *   - `planning` — risk heuristics, max tickets, planning-context limits.
 *   - `delivery` — execution timeouts, worktree isolation, deliver-runner
 *                  concurrency, docs-freshness, signals, quality.
 *
 * Hard cutover: the legacy `agentSettings.*` / `orchestration.*` shape is
 * rejected entirely. Consumers update their `.agentrc.json` in lockstep
 * with the framework bump.
 */
export const AGENTRC_SCHEMA = {
  type: 'object',
  required: ['project'],
  properties: {
    $schema: { type: 'string' },
    project: PROJECT_SCHEMA,
    github: GITHUB_SCHEMA,
    planning: PLANNING_SCHEMA,
    delivery: DELIVERY_SCHEMA,
  },
  additionalProperties: false,
};

let _agentrcValidator = null;
export function getAgentrcValidator() {
  if (!_agentrcValidator) {
    const ajv = new Ajv({ allErrors: true });
    _agentrcValidator = ajv.compile(AGENTRC_SCHEMA);
  }
  return _agentrcValidator;
}
