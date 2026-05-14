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

const MAINTAINABILITY_CRAP_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
    newMethodCeiling: { type: 'integer', minimum: 1 },
    coveragePath: { ...SAFE_STRING, minLength: 1 },
    tolerance: { type: 'number', minimum: 0 },
    requireCoverage: { type: 'boolean' },
    friction: {
      type: 'object',
      properties: { markerKey: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    refreshTag: { ...SAFE_STRING, minLength: 1 },
  },
  // Coverage-path requirement only when CRAP is enabled AND requireCoverage.
  allOf: [
    {
      if: {
        properties: {
          enabled: { const: true },
          requireCoverage: { const: true },
        },
        required: ['enabled', 'requireCoverage'],
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then keyword
      then: { required: ['coveragePath'] },
    },
  ],
};

const MAINTAINABILITY_QUALITY_SCHEMA = {
  type: 'object',
  properties: {
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
    tolerance: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
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

const QUALITY_FLOORS_SCHEMA = {
  type: 'object',
  properties: {
    coverage: {
      type: 'object',
      properties: {
        lines: { type: 'number', minimum: 0, maximum: 100 },
        branches: { type: 'number', minimum: 0, maximum: 100 },
        functions: { type: 'number', minimum: 0, maximum: 100 },
      },
      additionalProperties: false,
    },
    maintainability: { type: 'number', minimum: 0, maximum: 100 },
    crap: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

const QUALITY_SCHEMA = {
  type: 'object',
  properties: {
    baselines: {
      type: 'object',
      properties: {
        lint: BASELINE_ENTRY_SCHEMA,
        crap: BASELINE_ENTRY_SCHEMA,
        maintainability: BASELINE_ENTRY_SCHEMA,
      },
      additionalProperties: false,
    },
    maintainability: MAINTAINABILITY_QUALITY_SCHEMA,
    crap: MAINTAINABILITY_CRAP_SCHEMA,
    codingGuardrails: CODING_GUARDRAILS_SCHEMA,
    autoRefresh: AUTO_REFRESH_SCHEMA,
    qualityFloors: QUALITY_FLOORS_SCHEMA,
    // Story 1 mechanically relocates the existing `quality.*` block under
    // `delivery.quality.*`. The uniform per-gate `gates.<tier>` restructure
    // happens in Story 2 — keep the legacy fields here so callers continue
    // to read through the existing resolver during the Story 1 cutover.
    gateScoping: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['diff', 'full'] },
        diffRef: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
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
