import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Shell-injection constants live in config-schema-shared.js so the settings
// schema file can import them without pulling this module's AJV bundle.
// Re-exported here for backward-compatible import paths.
export {
  SHELL_INJECTION_PATTERN_STRING,
  SHELL_INJECTION_RE,
  SHELL_INJECTION_RE_STRICT,
} from './config-schema-shared.js';

// The agentSettings schema lives in its own module to keep this file under
// escomplex's Halstead-volume ceiling. Re-exported here for import stability.
export {
  AGENT_SETTINGS_SCHEMA,
  AGENT_SETTINGS_STRING_FIELDS,
  getSettingsValidator,
} from './config-settings-schema.js';

const GITHUB_SCHEMA = {
  type: 'object',
  required: ['owner', 'repo'],
  properties: {
    owner: { type: 'string', minLength: 1 },
    repo: { type: 'string', minLength: 1 },
    projectNumber: { type: ['integer', 'null'], minimum: 1 },
    projectOwner: { type: ['string', 'null'], minLength: 1 },
    projectName: { type: ['string', 'null'], minLength: 1 },
    operatorHandle: { type: 'string', pattern: '^@.+' },
  },
  additionalProperties: false,
};

const NOTIFICATIONS_SCHEMA = {
  type: 'object',
  properties: {
    mentionOperator: { type: 'boolean' },
    // Unified severity filter for both manual `notify()` calls and the
    // auto-fired ticket-state-transition notifications dispatched by
    // `transitionTicketState`. Events below this threshold are dropped
    // from every channel. Default: `medium`.
    //
    // Severity assignment for state-transition events:
    //   - Story or Epic reaching `agent::done` → `medium`
    //   - All other transitions (intermediate, task-level)  → `low`
    minLevel: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
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
    windowsPathLengthWarnThreshold: { type: 'integer', minimum: 1 },
    bootstrapFiles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  additionalProperties: false,
  // `root` is required only when isolation is explicitly enabled. A
  // disabled-or-absent block doesn't need a root path.
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
 * `orchestration.runners.epicRunner.healthRefresh` — cadence for the
 * push-based sprint health monitor. Each story-close runs the health refresh,
 * which re-fetches Epic tickets and per-task comments. For large Epics this
 * is the dominant fanout in the post-merge pipeline. The cadence knob lets
 * operators trade refresh frequency against per-close cost.
 *
 *   - `every-close` — current behaviour; refresh on every story-close.
 *   - `every-n-closes` — refresh once per N closes (paired with
 *     `everyNCloses`).
 *   - `wave-boundary` (default) — refresh only when the closing story sits in
 *     a wave higher than any previously-refreshed wave. Cheapest cadence for
 *     a long Epic with many stories per wave.
 *   - `min-interval` — refresh at most once every `minIntervalSec` seconds.
 *
 * `everyNCloses` and `minIntervalSec` are nullable so the canonical wave-
 * boundary default doesn't have to declare unused pairings.
 */
const HEALTH_REFRESH_SCHEMA = {
  type: 'object',
  properties: {
    cadence: {
      type: 'string',
      enum: ['every-close', 'every-n-closes', 'wave-boundary', 'min-interval'],
    },
    everyNCloses: { type: ['integer', 'null'], minimum: 1 },
    minIntervalSec: { type: ['integer', 'null'], minimum: 30 },
  },
  required: ['cadence'],
  additionalProperties: false,
};

/** Default applied when `orchestration.runners.epicRunner.healthRefresh` is absent. */
export const DEFAULT_HEALTH_REFRESH = Object.freeze({
  cadence: 'wave-boundary',
  everyNCloses: null,
  minIntervalSec: null,
});

const EPIC_RUNNER_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    concurrencyCap: { type: 'integer', minimum: 1 },
    progressReportIntervalSec: { type: 'integer', minimum: 0 },
    healthRefresh: HEALTH_REFRESH_SCHEMA,
  },
  additionalProperties: false,
  // `concurrencyCap` is required only when the epic runner is active.
  // Operators flipping `enabled: false` shouldn't have to declare a cap they
  // never use; absent `enabled` (the common case) defaults to active and
  // therefore requires the cap.
  allOf: [
    {
      if: {
        not: {
          properties: { enabled: { const: false } },
          required: ['enabled'],
        },
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then keyword
      then: { required: ['concurrencyCap'] },
    },
  ],
};

const PLAN_RUNNER_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    pollIntervalSec: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `orchestration.runners.closeRetry` — bounded retry policy for the epic-branch push
 * step in `story-close.js`. Protects concurrent story closures against
 * non-fast-forward rejections when a sibling session lands on the same Epic
 * branch between our fetch and our push.
 *
 * Both keys are optional. Defaults (applied by the consumer, not the schema)
 * are `{ maxAttempts: 3, backoffMs: [250, 500, 1000] }`.
 */
const CLOSE_RETRY_SCHEMA = {
  type: 'object',
  properties: {
    maxAttempts: { type: 'integer', minimum: 1 },
    backoffMs: {
      type: 'array',
      items: { type: 'integer', minimum: 0 },
    },
  },
  additionalProperties: false,
};

/** Default applied when `orchestration.runners.closeRetry` is absent or incomplete. */
export const DEFAULT_CLOSE_RETRY = Object.freeze({
  maxAttempts: 3,
  backoffMs: Object.freeze([250, 500, 1000]),
});

/**
 * `orchestration.runners.concurrency` — per-site caps for the `concurrentMap`
 * adoption sites shipped in v5.21.0 (Epic #553). All keys optional;
 * omitting them preserves the v5.21.0 constant-valued defaults exactly.
 *
 *   - waveGate: 0 (uncapped) preserves Promise.all behaviour in
 *     `wave-gate.js`. Positive integers cap the three per-section
 *     ticket-read batches to N concurrent provider calls.
 *   - commitAssertion: default 4 matches
 *     `CommitAssertion.WAVE_END_CONCURRENCY`.
 *   - progressReporter: default 8 matches the literal used inside
 *     `ProgressReporter.fire`.
 */
const CONCURRENCY_SCHEMA = {
  type: 'object',
  properties: {
    waveGate: { type: 'integer', minimum: 0 },
    commitAssertion: { type: 'integer', minimum: 1 },
    progressReporter: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `orchestration.runners.decomposer` — bounded-concurrency knob for the
 * staged Feature/Story/Task creation pass in `ticket-decomposer.js`.
 * `concurrencyCap` controls the maximum number of in-flight `provider.createTicket`
 * calls per type-pass. Default `3` matches the `DEFAULT_DECOMPOSER.concurrencyCap`
 * applied by `getRunners`.
 */
const DECOMPOSER_SCHEMA = {
  type: 'object',
  properties: {
    concurrencyCap: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/** Default applied when `orchestration.runners.decomposer` is absent or incomplete. */
export const DEFAULT_DECOMPOSER = Object.freeze({
  concurrencyCap: 3,
});

/**
 * `orchestration.runners` — typed grouping of every runner-flavoured sub-block
 * (epicRunner, planRunner, concurrency, closeRetry, decomposer) introduced in
 * Epic #773 Story 7. Replaces the prior flat layout where each sub-block sat
 * directly under `orchestration`. Each sub-schema is preserved byte-for-byte;
 * only the parent location changes.
 */
const RUNNERS_SCHEMA = {
  type: 'object',
  properties: {
    epicRunner: EPIC_RUNNER_SCHEMA,
    planRunner: PLAN_RUNNER_SCHEMA,
    concurrency: CONCURRENCY_SCHEMA,
    closeRetry: CLOSE_RETRY_SCHEMA,
    decomposer: DECOMPOSER_SCHEMA,
  },
  additionalProperties: false,
};

/**
 * Embedded JSON Schema for the `orchestration` configuration block. Kept
 * inline so all config validation lives in a single file; composed from the
 * per-section sub-schemas above.
 *
 * @see docs/architecture.md — Provider Abstraction Layer
 */
export const ORCHESTRATION_SCHEMA = {
  type: 'object',
  required: ['provider'],
  properties: {
    provider: { type: 'string', enum: ['github'] },
    github: GITHUB_SCHEMA,
    executor: {
      type: 'string',
      description:
        'The execution adapter to use (e.g., "manual", "subprocess").',
    },
    notifications: NOTIFICATIONS_SCHEMA,
    hitl: { type: 'object', properties: {}, additionalProperties: false },
    worktreeIsolation: WORKTREE_ISOLATION_SCHEMA,
    runners: RUNNERS_SCHEMA,
  },
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: { provider: { const: 'github' } },
        required: ['provider'],
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then keyword
      then: { required: ['github'] },
    },
  ],
};

/** Pre-compiled ajv validator (singleton). */
let _compiledValidator = null;

export function getOrchestrationValidator() {
  if (!_compiledValidator) {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    _compiledValidator = ajv.compile(ORCHESTRATION_SCHEMA);
  }
  return _compiledValidator;
}
