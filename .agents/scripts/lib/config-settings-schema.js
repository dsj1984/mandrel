/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

import Ajv from 'ajv';

import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';

const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
};

const _NULLABLE_SAFE_STRING = {
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
 * and `auditOutputDir` is derived as `${tempRoot}/audits`.
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

/**
 * Story #2634 — `planning.codebaseSnapshot` controls the structural
 * view of the consumer repo threaded into `/epic-plan` Phase 7 spec
 * authoring. Absent / partial entries resolve to defaults inside
 * `lib/codebase-snapshot.js#resolveSnapshotConfig` — the schema only
 * enforces shape (correct enum value, well-formed glob arrays).
 */
const CODEBASE_SNAPSHOT_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string', enum: ['skinny', 'medium'] },
    include: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    exclude: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    recentCommitWindow: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

const PLANNING_SCHEMA = {
  type: 'object',
  properties: {
    riskHeuristics: LIST_OR_EXTENDER_OF_STRINGS,
    maxTickets: { type: 'integer', minimum: 1 },
    context: PLANNING_CONTEXT_SCHEMA,
    codebaseSnapshot: CODEBASE_SNAPSHOT_SCHEMA,
    // Cross-Story conflict-finding severity gates. Off by default so
    // existing repos keep advisory-only behaviour; flipping either to
    // `true` upgrades the matching finding class to `'hard'`, which routes
    // it through the validator's `errors[]` channel and trips the bounded
    // decompose loop's re-prompt gate.
    failOnSharedEditors: { type: 'boolean' },
    requireExplicitCrossStoryDeps: { type: 'boolean' },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// delivery.* — /epic-deliver + story-deliver consume
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

// `delivery.quality.gates.<tier>` sub-schemas live in their own module
// (Story #1737); see `config-gates-schema.js` for the seven gate shapes
// and the shared { kind, value } tolerance + workspace-keyed floors
// fragments.
import { GATES_SCHEMA } from './config-gates-schema.js';

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
 * `delivery.quality.baselineEpsilon` — per-kind epsilon for
 * s-stability-epsilon (Story #1964). Sub-epsilon row deltas resolve to
 * the prior bytes so env variance never rewrites the on-disk baseline.
 */
const BASELINE_EPSILON_SCHEMA = {
  type: 'object',
  properties: {
    maintainability: { type: 'number', minimum: 0 },
    crap: { type: 'number', minimum: 0 },
    coverage: { type: 'number', minimum: 0 },
    mutation: { type: 'number', minimum: 0 },
    lint: { type: 'number', minimum: 0 },
    lighthouse: { type: 'number', minimum: 0 },
    'bundle-size': { type: 'number', minimum: 0 },
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
/**
 * `delivery.quality.formatAutofix` — bounded-timeout knob for the
 * close-time `npx biome format --write` spawn (Story #2165). Mirrors
 * `gates.coverage.timeoutMs` (Story #2142): a SIGKILL fired at the budget
 * boundary maps to exit 124 so the close orchestrator can flip the Story
 * to `agent::blocked` with a friction comment.
 */
const FORMAT_AUTOFIX_SCHEMA = {
  type: 'object',
  properties: {
    timeoutMs: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `delivery.lifecycle` — knobs consumed by the lifecycle event bus
 * (Epic #2172). `timeouts` is a per-event budget map (eventName → seconds)
 * used by Story 11's `TimeoutWatchdog` listener; missing entries fall back
 * to in-listener defaults. `heartbeatWarnSeconds` is the no-progress
 * threshold consumed by `HeartbeatMonitor`. Story #2227 lays down the
 * keys; consumers land in later stories.
 */
const LIFECYCLE_SCHEMA = {
  type: 'object',
  properties: {
    timeouts: {
      type: 'object',
      additionalProperties: { type: 'integer', minimum: 1 },
    },
    heartbeatWarnSeconds: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

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
    formatAutofix: FORMAT_AUTOFIX_SCHEMA,
    codingGuardrails: CODING_GUARDRAILS_SCHEMA,
    autoRefresh: AUTO_REFRESH_SCHEMA,
    baselineEpsilon: BASELINE_EPSILON_SCHEMA,
  },
  additionalProperties: false,
};

/**
 * `delivery.epicAudit` — bounded-retry knobs for /epic-deliver Phase 4
 * (epic-audit). `maxFixAttempts` caps how many times the auto-fix loop
 * retries a single finding (Story #2611, Epic #2586). `maxFixScopeFiles`
 * caps how many files a single auto-fix may touch before escalating to
 * `agent::blocked` — matches the 5-file rule in `.agents/instructions.md
 * § 7`.
 */
const EPIC_AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    maxFixAttempts: { type: 'integer', minimum: 0 },
    maxFixScopeFiles: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `delivery.codeReview` — sibling to `delivery.epicAudit`. Same bounded
 * retry + scope cap, applied to /epic-deliver Phase 5 (code-review).
 */
const CODE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    // Story #2825 (Epic #2815) seeded the pluggable review backend
    // with `native`; Story #2830 added `codex` (the
    // `openai/codex-plugin-cc` Claude Code plugin). The codex
    // adapter probes for `/codex:review` at factory construction and
    // hard-fails with remediation when absent — there is no silent
    // fallback to native. `providerConfig` is an open-shape escape
    // hatch reserved for adapter-specific options.
    provider: { type: 'string', enum: ['native', 'codex'], default: 'native' },
    providerConfig: { type: 'object', additionalProperties: true },
    maxFixAttempts: { type: 'integer', minimum: 0 },
    maxFixScopeFiles: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `delivery.hydration` — hydrator output mode (Epic #2648). `prose-legacy`
 * delegates to `context-hydration-engine.legacy.js` for one release; remove
 * the flag and legacy module together in the cutover PR (no indefinite shim).
 */
const HYDRATION_SCHEMA = {
  type: 'object',
  properties: {
    outputMode: {
      type: 'string',
      enum: ['envelope', 'prose-legacy'],
    },
    fullSkillBodies: { type: 'boolean' },
  },
  additionalProperties: false,
};

const DELIVERY_SCHEMA = {
  type: 'object',
  properties: {
    execution: EXECUTION_SCHEMA,
    hydration: HYDRATION_SCHEMA,
    maxTokenBudget: { type: 'integer', minimum: 1 },
    docsFreshness: DOCS_FRESHNESS_SCHEMA,
    deliverRunner: DELIVER_RUNNER_SCHEMA,
    worktreeIsolation: WORKTREE_ISOLATION_SCHEMA,
    signals: SIGNALS_SCHEMA,
    quality: QUALITY_SCHEMA,
    lifecycle: LIFECYCLE_SCHEMA,
    epicAudit: EPIC_AUDIT_SCHEMA,
    codeReview: CODE_REVIEW_SCHEMA,
    // Cross-Story concurrency-hazard gate (Story #2297). When true,
    // `epic-deliver-prepare` refuses to flip the Epic to
    // `agent::executing` if the upcoming waves still carry any conflict
    // finding (Story #2296). Off by default; operators using the gate
    // also need to wire findings into prepare via the runtime injection
    // surface.
    failOnConcurrencyHazards: { type: 'boolean' },
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
 * Hard cutover (Epic #2646, Story #2687): the legacy `agentSettings.*` /
 * `orchestration.*` input shape is rejected entirely by this schema, and
 * the corresponding resolver-side compat branches have been swept across
 * the seven `lib/config/*.js` accessors. The internal output-side shim on
 * `resolveConfig` survives as a transitional pointer — a future Epic
 * migrates every consumer onto the canonical `project` / `github` /
 * `delivery` blocks and removes the shim.
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
