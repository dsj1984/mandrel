/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

import Ajv from 'ajv';

import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';
// `delivery.*` sub-schemas were extracted to a sibling module (refs #3457)
// to keep this aggregate module above the maintainability floor. The
// resolved AGENTRC_SCHEMA is unchanged.
import { DELIVERY_SCHEMA } from './config-settings-schema-delivery.js';

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
  required: ['owner', 'repo', 'operatorHandle'],
  properties: {
    owner: { type: 'string', minLength: 1 },
    repo: { type: 'string', minLength: 1 },
    projectNumber: { type: ['integer', 'null'], minimum: 1 },
    projectOwner: { type: ['string', 'null'], minLength: 1 },
    operatorHandle: { type: 'string', pattern: '^@.+' },
    defaultTimeoutMs: { type: 'integer', minimum: 1000 },
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

/**
 * Per-profile soft+hard ceiling pair reused for both change-count ceilings
 * (Recal A, Story #3231) and test-surface gates (Feature 6, Story #3235).
 */
const PROFILE_CEILING_SCHEMA = {
  type: 'object',
  required: ['soft', 'hard'],
  properties: {
    soft: { type: 'integer', minimum: 1 },
    hard: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `planning.taskSizing.profileCeilings` — operator overrides for per-profile
 * change ceilings. Keys are `sizingProfile` enum values plus `""` for the
 * no-profile default. Absent keys fall back to `DEFAULT_TASK_SIZING` in
 * `ticket-validator-sizing.js`.
 */
const PROFILE_CEILINGS_SCHEMA = {
  type: 'object',
  properties: {
    'mechanical-sweep': PROFILE_CEILING_SCHEMA,
    scaffolding: PROFILE_CEILING_SCHEMA,
    'atomic-rewrite': PROFILE_CEILING_SCHEMA,
    '': PROFILE_CEILING_SCHEMA,
  },
  additionalProperties: false,
};

/**
 * `planning.taskSizing.testSurface` — operator overrides for per-profile
 * test-surface gates on `estimated_test_files`. Keys match the `sizingProfile`
 * enum plus `""` for the no-profile default. Absent keys fall back to
 * `DEFAULT_TASK_SIZING.testSurface` in `ticket-validator-sizing.js`
 * (Story #3235, Epic #3211 Feature 6).
 */
const TEST_SURFACE_SCHEMA = {
  type: 'object',
  properties: {
    'mechanical-sweep': PROFILE_CEILING_SCHEMA,
    scaffolding: PROFILE_CEILING_SCHEMA,
    'atomic-rewrite': PROFILE_CEILING_SCHEMA,
    '': PROFILE_CEILING_SCHEMA,
  },
  additionalProperties: false,
};

/**
 * `planning.taskSizing` — Story-sizing thresholds consumed by
 * `ticket-validator-sizing.js`. Operator overrides shallow-merge with
 * `DEFAULT_TASK_SIZING` defaults. Story #3231 (Epic #3211 Feature 5)
 * recalibrated for the 3-tier world: `maxAcceptance` raised to 8,
 * per-profile change ceilings introduced, `sizingProfile` demoted to an
 * informational-always hint. Story #3235 adds `testSurface` gates on
 * `estimated_test_files`.
 */
const TASK_SIZING_SCHEMA = {
  type: 'object',
  properties: {
    maxAcceptance: { type: 'integer', minimum: 1 },
    softAcceptanceCount: { type: 'integer', minimum: 1 },
    softFileCount: { type: 'integer', minimum: 1 },
    profileCeilings: PROFILE_CEILINGS_SCHEMA,
    testSurface: TEST_SURFACE_SCHEMA,
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
    taskSizing: TASK_SIZING_SCHEMA,
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
// delivery.* — /epic-deliver + story-deliver consume. The full block of
// per-key sub-schemas lives in `config-settings-schema-delivery.js` (refs
// #3457); DELIVERY_SCHEMA is imported above and referenced unchanged below.
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
 * Hard cutover (Epic #2646, Story #2687; finalized by Epic #2880, Story
 * #2935): the legacy `agentSettings.*` / `orchestration.*` input shape is
 * rejected entirely by this schema (top-level `additionalProperties: false`
 * fails any document carrying those keys), the corresponding resolver-side
 * compat branches were swept across the seven `lib/config/*.js` accessors,
 * and the output-side shim on `resolveConfig` was deleted — every consumer
 * now reads the canonical `project` / `github` / `planning` / `delivery`
 * blocks directly.
 */
// ---------------------------------------------------------------------------
// qa.* — Agent-driven QA harness contract (Epic #3214)
// ---------------------------------------------------------------------------

const QA_SIGN_IN_SEAM_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        urlTemplate: { ...SAFE_STRING, minLength: 1 },
      },
      required: ['urlTemplate'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: { ...SAFE_STRING, minLength: 1 },
      },
      required: ['skill'],
      additionalProperties: false,
    },
  ],
};

// `personas` accepts two shapes (Story #3306). The plain `string[]` of
// persona names is the honest shape for a `urlTemplate` dev-impersonation
// seam, where the workflow substitutes only the persona name into the URL
// and never reads per-persona auth material. The object-map form (keyed by
// persona name, each entry carrying `credentialRef` or `signInSkill`) is
// for `skill`/credential seams where per-persona material is genuinely
// consulted. The resolver normalizes both to one canonical internal form.
const QA_PERSONAS_SCHEMA = {
  oneOf: [
    {
      type: 'array',
      minItems: 1,
      items: { ...SAFE_STRING, minLength: 1 },
    },
    {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        oneOf: [
          {
            type: 'object',
            properties: {
              credentialRef: { ...SAFE_STRING, minLength: 1 },
            },
            required: ['credentialRef'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              signInSkill: { ...SAFE_STRING, minLength: 1 },
            },
            required: ['signInSkill'],
            additionalProperties: false,
          },
        ],
      },
    },
  ],
};

export const QA_SCHEMA = {
  type: 'object',
  properties: {
    featureRoot: { ...SAFE_STRING, minLength: 1 },
    fixturesManifest: { ...SAFE_STRING, minLength: 1 },
    signInSeam: QA_SIGN_IN_SEAM_SCHEMA,
    personas: QA_PERSONAS_SCHEMA,
    consoleAllowlist: {
      type: 'array',
      items: { ...SAFE_STRING, minLength: 1 },
    },
    designTokens: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

export const AGENTRC_SCHEMA = {
  type: 'object',
  required: ['project'],
  properties: {
    $schema: { type: 'string' },
    project: PROJECT_SCHEMA,
    github: GITHUB_SCHEMA,
    planning: PLANNING_SCHEMA,
    delivery: DELIVERY_SCHEMA,
    qa: QA_SCHEMA,
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
