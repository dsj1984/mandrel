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
    // Per-channel severity gates. Each channel filters independently — there
    // is no fallback chain. Events below the channel's threshold are dropped
    // for that channel only. All three are mandatory; default `medium`.
    //
    // Severity assignment by event hierarchy:
    //   - Task transitions, `story-run-progress` upserts → `low`
    //   - Story state transitions, `wave-run-progress`,
    //     `epic-run-progress`, epic milestones                  → `medium`
    //   - Epic blockers, halts, action-required gates       → `high`
    commentMinLevel: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
    webhookMinLevel: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
    terminalMinLevel: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
  },
  required: ['commentMinLevel', 'webhookMinLevel', 'terminalMinLevel'],
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
 * `orchestration.runners.deliverRunner` — bounded-concurrency knob for the
 * epic-deliver fan-out (Epic #773 Story 7). Renamed from `epicRunner` in
 * Epic #1142 Story #1157 to match the `/epic-deliver` workflow it drives;
 * the schema shape is unchanged from the prior `epicRunner` block.
 */
const DELIVER_RUNNER_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    concurrencyCap: { type: 'integer', minimum: 1 },
    progressReportIntervalSec: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
  // `concurrencyCap` is required only when the deliver runner is active.
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
 * `orchestration.runners.storyMergeRetry` — bounded retry policy for the
 * epic-branch push step in `story-close.js`. Protects concurrent story
 * closures against non-fast-forward rejections when a sibling session lands
 * on the same Epic branch between our fetch and our push. Renamed from
 * `closeRetry` in Epic #1142 Story #1157 to make the intent (story-close
 * push retry) explicit at the call site.
 *
 * Both keys are optional. Defaults (applied by the consumer, not the schema)
 * are `{ maxAttempts: 3, backoffMs: [250, 500, 1000] }`.
 */
const STORY_MERGE_RETRY_SCHEMA = {
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

/** Default applied when `orchestration.runners.storyMergeRetry` is absent or incomplete. */
export const DEFAULT_STORY_MERGE_RETRY = Object.freeze({
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
 *
 * Trade-off: each `createTicket` fans out to issue-create + sub-issue link +
 * project add (≈3 GitHub POSTs), so cap=3 puts ~9 in-flight content-creation
 * calls at peak. GitHub's secondary rate limit trips around 80 such calls in
 * a short window — large Epics (>60 tickets) hit it. We keep the snappy
 * default for the common case and rely on the *adaptive* degrade in
 * `decomposeEpic`: the first time the http-client surfaces a secondary RL,
 * the cap drops to 1 for every remaining staged pass. Operators driving
 * known-large Epics can short-circuit by setting
 * `orchestration.runners.decomposer.concurrencyCap: 1` in `.agentrc.json`.
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
 * introduced in Epic #773 Story 7. Replaces the prior flat layout where each
 * sub-block sat directly under `orchestration`. Epic #1142 Story #1157
 * renamed `epicRunner` → `deliverRunner` and `closeRetry` →
 * `storyMergeRetry` to make the per-block intent explicit; the sub-schemas
 * themselves are preserved.
 */
const RUNNERS_SCHEMA = {
  type: 'object',
  properties: {
    deliverRunner: DELIVER_RUNNER_SCHEMA,
    planRunner: PLAN_RUNNER_SCHEMA,
    concurrency: CONCURRENCY_SCHEMA,
    storyMergeRetry: STORY_MERGE_RETRY_SCHEMA,
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
