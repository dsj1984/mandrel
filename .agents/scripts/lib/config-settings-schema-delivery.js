/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

// ---------------------------------------------------------------------------
// delivery.* sub-schemas — extracted from config-settings-schema.js to keep
// the aggregate AGENTRC_SCHEMA module under the maintainability floor. These
// are pure declarative AJV fragments referenced by DELIVERY_SCHEMA; moving
// them here does not change validation semantics (the resolved schema is
// byte-for-byte equivalent in effect).
// ---------------------------------------------------------------------------

import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';
// `delivery.quality` and `delivery.codeReview` sub-schemas live in a
// further-split module (refs #3457) so each schema file stays above the
// maintainability floor.
import {
  CODE_REVIEW_SCHEMA,
  QUALITY_SCHEMA,
} from './config-settings-schema-quality.js';

const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
};

const EXECUTION_SCHEMA = {
  type: 'object',
  properties: {
    timeoutMs: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `delivery.lease` — assignee-as-lease primitive (Story #3480). `ttlMs` is
 * the staleness window: a ticket claim whose owner's last heartbeat is older
 * than this many milliseconds is reclaimable by another operator. Defaults to
 * 900000 (15 min) in `lib/config/limits.js`. Note the shipped guards fail
 * closed (no live heartbeat source since A22 removed the inert emitter), so
 * a stranded claim is cleared with `--steal` rather than by TTL expiry.
 */
const LEASE_SCHEMA = {
  type: 'object',
  properties: {
    ttlMs: { type: 'integer', minimum: 1 },
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
  },
  additionalProperties: false,
};

/**
 * `delivery.worktreeIsolation` — per-Story git worktree provisioning.
 */
const WORKTREE_ISOLATION_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    root: { type: 'string', minLength: 1 },
    nodeModulesStrategy: {
      type: 'string',
      enum: ['per-worktree', 'clone', 'symlink', 'pnpm-store'],
    },
    primeFromPath: { type: ['string', 'null'], minLength: 1 },
    allowSymlinkOnWindows: { type: 'boolean' },
    reapOnSuccess: { type: 'boolean' },
    bootstrapFiles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      default: [
        '.env',
        '.mcp.json',
        '.agentrc.local.json',
        '.agents/instructions.local.md',
      ],
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
 * `delivery.signals` — detector thresholds for the surviving
 * performance-signal categories. `hotspot` was retired with its detector
 * (Epic #4406); `churn` and `idle` were dropped earlier (low signal-to-noise).
 * Each block is shallow-merged by the resolver.
 */
const SIGNALS_SCHEMA = {
  type: 'object',
  properties: {
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
 * `delivery.mergeWatch` — knobs consumed by the close-and-land merge wait
 * listener (Story #2896, Epic #2880) and by the close-and-land merge wait
 * (`single-story-close/phases/confirm-merge.js`). `intervalSeconds` is the
 * poll cadence between `gh pr view` probes after the arm.
 *
 * The two budgets are deliberately separate axes (Story #4543):
 *
 *   - `maxWaitSeconds` bounds **one invocation** of the merge wait. Its
 *     default (300s) fits inside a single host tool invocation, whose
 *     ceiling is ~10 minutes; the gates that run before the wait already
 *     consume minutes of that. Expiry is NOT a block — the wait returns a
 *     resumable `pending` terminal with no label mutation. A headless caller
 *     with no such ceiling raises it to keep land-in-one-block semantics.
 *   - `maxBudgetSeconds` bounds the **cumulative** wait across resumes,
 *     anchored at the PR's `createdAt` so re-entering the wait does not
 *     restart the clock. Exhausting *this* is the genuine give-up condition
 *     that classifies and blocks.
 *
 * `updateAttempts` caps how many times the wait will bring a
 * behind-the-base PR up to date before giving the branch up as unwinnable,
 * rather than waiting out the budget behind a base it could have merged.
 * All keys default in the consumer when omitted (30s / 300s / 3600s / 3).
 *
 * `mode` selects the close-time merge posture (Story #4698). Default `sync`
 * keeps the in-close foreground wait unchanged. `async` caps the per-invocation
 * wait to a short probe window (~60s: catches instant merges and instantly-red
 * required checks) and then returns the resumable `pending` terminal, so a
 * slow-CI consumer no longer burns ~5 minutes of the host tool slot on a merge
 * that lands after the wait would have expired anyway — the worker launches the
 * `pending` envelope's `nextCommand` in the background instead.
 */
const MERGE_WATCH_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['sync', 'async'] },
    intervalSeconds: { type: 'integer', minimum: 1 },
    maxWaitSeconds: { type: 'integer', minimum: 1 },
    maxBudgetSeconds: { type: 'integer', minimum: 1 },
    updateAttempts: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

/**
 * `delivery.epicAudit` was removed on v2 (Story-only delivery — no
 * epic-audit runner). Remediation policy lives on `delivery.codeReview`
 * (`CODE_REVIEW_SCHEMA` imported from the quality schema module).
 */

// Epic #4478 (M7-B) — role-scoped-agent kill-switch + maker-checker floor.
// Stage 6 dropped `delivery.routing.singleDelivery` (v1 epic route switch).
// `delivery.routing.roleScopedAgents` (default true via getDeliveryRouting)
// flips converted delivery spawns onto their `.claude/agents/<role>.md` boot
// context; false falls back to `subagent_type: general-purpose` (the instant
// per-consumer revert + the escape for hosts that ignore `.claude/agents/`).
// `delivery.routing.freshCriticSampleRate` (default 0.2, clamped [0, 1]) is the
// maker-checker sampling floor forcing a fraction of low-derived-level
// acceptance clusters through a fresh critic.
const ROUTING_SCHEMA = {
  type: 'object',
  properties: {
    roleScopedAgents: { type: 'boolean' },
    freshCriticSampleRate: { type: 'number', minimum: 0, maximum: 1 },
    ceremonyProfile: {
      type: 'string',
      enum: ['minimal', 'standard', 'strict'],
    },
    closeAndLand: { type: 'boolean' },
  },
  additionalProperties: false,
};

// Story #4356 (Epic #4355) — CI-aware delivery namespace. `watch.*` tunes
// the merge/CI watch poll loop; `autoMerge` selects the merge posture.
// Retired: `earlyPr` (Epic early-PR warmup) and `requireChecks` (no
// AutomergePredicate reader on v2).
const CI_WATCH_SCHEMA = {
  type: 'object',
  properties: {
    pollIntervalMs: { type: 'integer', minimum: 1 },
    maxPolls: { type: 'integer', minimum: 1 },
    maxResumes: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

const CI_DELIVERY_SCHEMA = {
  type: 'object',
  properties: {
    watch: CI_WATCH_SCHEMA,
    autoMerge: { type: 'string', enum: ['trust-ci', 'strict'] },
  },
  additionalProperties: false,
};

/**
 * `delivery.refactorStage` — opt-in, config-gated post-green refactor
 * checkpoint wired into story-deliver (Story #3430, Epic #3418). Strictly
 * additive and default-OFF: when `enabled` is unset or `false`, story-deliver
 * behaves exactly as before. When `true`, the worker runs an advisory
 * post-green refactor pass (the `core/code-review-and-quality` skill's
 * Post-Green Refactor Pass) after the suite is green. The stage is
 * advisory only — it never changes existing close-validation gate semantics.
 */
const REFACTOR_STAGE_SCHEMA = {
  type: 'object',
  properties: {
    enabled: {
      type: 'boolean',
      description:
        'When true, story-deliver runs an advisory post-green refactor stage (core/code-review-and-quality skill, Post-Green Refactor Pass) after the suite is green. Default false — when unset the stage is skipped and close-validation gate semantics are unchanged.',
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.acceptanceEval` — bounded per-Story acceptance self-eval loop
 * (Story #3819). After the implementation commits land and before the
 * Story-implementation phase flips to `closing`, an independent
 * (fresh-context) critic pass scores the caller-injected change set against
 * each inline `acceptance[]` item, redrafts the unmet items, and
 * re-evaluates — capped at `maxRounds` redraft rounds.
 *
 * `maxRounds` is the operator-tunable redraft ceiling (default 2 via
 * `lib/config/acceptance-eval.js`). It is a soft knob inside an
 * **undisableable** hard cap: `lib/config/acceptance-eval.js` clamps any
 * configured value into `[1, ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING]`, so no
 * configuration can switch the loop off (`maxRounds: 0`) or let it spin
 * unbounded. There is intentionally **no** `enabled` flag — the loop is a
 * hard cutover, always on, per `rules/git-conventions.md`.
 */
const ACCEPTANCE_EVAL_SCHEMA = {
  type: 'object',
  properties: {
    maxRounds: {
      type: 'integer',
      minimum: 1,
      description:
        'Maximum number of redraft rounds the acceptance self-eval loop runs before escalating to agent::blocked when criteria remain unmet. Default 2; clamped into [1, hard ceiling] by the resolver so the cap can never be disabled.',
    },
    clusterCeiling: {
      type: 'integer',
      minimum: 1,
      description:
        'Epic #4475 (M4-B). Max acceptance criteria one single-delivery acceptance critic scores in a single fresh-context pass. Single delivery clusters the Epic ## Acceptance Table ACs into ceil(totalACs / clusterCeiling) groups and spawns one maker-blind critic per cluster, restoring the distributed acceptance coverage the per-Story critic fan-out gave for free. Default 4; clamped into [1, 8] by the resolver so a large value cannot collapse the fan-out to a single diluted critic. Ignored on the fan-out route.',
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.review` — close-scope review tuning (Story #4699). `lensDiffFloor`
 * is the changed-line floor below which the Story-scope local-lens pass skips
 * lens materialization for a diff with zero sensitive-path hits (default 40
 * via `lib/audit-suite/lens-diff-floor.js`; `0` disables the skip). The
 * maker-blind code-review pass and all hard gates are untouched by the floor.
 */
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    lensDiffFloor: {
      type: 'integer',
      minimum: 0,
      description:
        'Changed-line floor for the close-scope lens walk (Story #4699). A diff strictly below this many changed lines (additions + deletions) with zero sensitive-path hits skips lens materialization and records the skip in the findings-yield ledger. Default 40; 0 disables the skip. Hard gates and the maker-blind code-review pass are unaffected.',
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.feedbackLoop` — opt-out toggles consumed by the Epic finalize
 * listener's auto-file graduators (`lib/feedback-loop/*-graduator.js`, read
 * via `graduator-core.js#makeIsAutoFileEnabled`). All default to `true`
 * (auto-file on); set any to `false` to suppress auto-filing the
 * corresponding non-blocking findings as follow-up issues.
 *
 * `retroProposals` (Story #4418) governs the retro auto-filer: when true
 * (default) the retro's actionable routed proposals are filed as
 * `meta::<framework-gap|consumer-improvement>` + `friction::<category>`
 * issues via the graduator pre-parsed-findings seam, and the rendered retro
 * sections list the filed issue numbers instead of paste-ready `gh` command
 * stanzas; set it to `false` to fall back to the command stanzas.
 */
const FEEDBACK_LOOP_SCHEMA = {
  type: 'object',
  properties: {
    auditResultsAutoFile: { type: 'boolean' },
    retroProposals: { type: 'boolean' },
  },
  additionalProperties: false,
};

/**
 * `delivery.auditToStories` — knobs for the `/audit-to-stories` unattended
 * (`--auto`) sweep (Story #4626). `severityFloor` is the minimum severity a
 * finding must meet to be proposed as a Story on an unattended run (default
 * `high`); `autoComment`, when true (default), lets `--auto` post a
 * "re-detected" comment on an already-open matched Issue instead of silently
 * skipping it.
 */
const AUDIT_TO_STORIES_SCHEMA = {
  type: 'object',
  properties: {
    severityFloor: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low', 'all'],
    },
    autoComment: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const DELIVERY_SCHEMA = {
  type: 'object',
  properties: {
    execution: EXECUTION_SCHEMA,
    lease: LEASE_SCHEMA,
    docsFreshness: DOCS_FRESHNESS_SCHEMA,
    deliverRunner: DELIVER_RUNNER_SCHEMA,
    worktreeIsolation: WORKTREE_ISOLATION_SCHEMA,
    signals: SIGNALS_SCHEMA,
    quality: QUALITY_SCHEMA,
    mergeWatch: MERGE_WATCH_SCHEMA,
    codeReview: CODE_REVIEW_SCHEMA,
    review: REVIEW_SCHEMA,
    refactorStage: REFACTOR_STAGE_SCHEMA,
    acceptanceEval: ACCEPTANCE_EVAL_SCHEMA,
    feedbackLoop: FEEDBACK_LOOP_SCHEMA,
    auditToStories: AUDIT_TO_STORIES_SCHEMA,
    ci: CI_DELIVERY_SCHEMA,
    routing: ROUTING_SCHEMA,
  },
  additionalProperties: false,
};
