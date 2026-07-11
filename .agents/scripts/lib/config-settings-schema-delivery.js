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
 * the staleness window: a ticket claim whose owner has not emitted a
 * `story.heartbeat` within this many milliseconds is reclaimable by another
 * operator. Defaults to 900000 (15 min) in `lib/config/limits.js`.
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
    progressReportIntervalSec: { type: 'integer', minimum: 0 },
    verifyConcurrencyCap: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `delivery.retro.perfThresholds` (Story #3042, Task #3043) — operator-tunable
 * gates for the retro perf-signals classifier. Defaults are documented inline
 * here and mirrored in `lib/orchestration/retro-perf-heuristics.js
 * (DEFAULT_RETRO_PERF_THRESHOLDS)` and the static schema mirror.
 *
 * `utilisation` / `bootstrapShare` are unit-interval ratios; values outside
 * [0, 1] fall back to defaults at the resolver. `capBindingRunLength` is a
 * positive integer count of consecutive cap-binding waves.
 */
const RETRO_PERF_THRESHOLDS_SCHEMA = {
  type: 'object',
  properties: {
    utilisation: { type: 'number', minimum: 0, maximum: 1 },
    bootstrapShare: { type: 'number', minimum: 0, maximum: 1 },
    capBindingRunLength: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

const RETRO_SCHEMA = {
  type: 'object',
  properties: {
    perfThresholds: RETRO_PERF_THRESHOLDS_SCHEMA,
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
      enum: ['per-worktree', 'clone', 'symlink', 'pnpm-store'],
    },
    primeFromPath: { type: ['string', 'null'], minLength: 1 },
    allowSymlinkOnWindows: { type: 'boolean' },
    reapOnSuccess: { type: 'boolean' },
    reapOnCancel: { type: 'boolean' },
    bootstrapFiles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      default: ['.env', '.mcp.json'],
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

/**
 * `delivery.mergeWatch` — knobs consumed by the MergeWatcher lifecycle
 * listener (Story #2896, Epic #2880). `intervalSeconds` is the poll
 * cadence between `gh pr view --json mergeCommit,mergedAt` probes after
 * `epic.merge.armed`; `maxBudgetSeconds` is the total wall-clock budget
 * before the watcher surfaces `agent::blocked` with reason
 * `budget-exceeded`. Both keys default in the listener when omitted
 * (30s / 3600s).
 */
const MERGE_WATCH_SCHEMA = {
  type: 'object',
  properties: {
    intervalSeconds: { type: 'integer', minimum: 1 },
    maxBudgetSeconds: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `delivery.epicAudit` — bounded-retry knobs for /deliver Phase 4
 * (epic-audit). `maxFixAttempts` caps how many times the auto-fix loop
 * retries a single finding (Story #2611, Epic #2586). `maxFixScopeFiles`
 * caps how many files a single auto-fix may touch before escalating to
 * `agent::blocked` (default 5) — a deliberately narrow bound for
 * unattended auto-fixes, independent of the Story-sizing thresholds in
 * `ticket-validator-sizing.js`.
 *
 * `autoFixSeverity` (Story #4399) is the threshold that governs which findings
 * the Epic-close host-LLM remediation loop fixes on-branch. It is **tier-aware**
 * (Story #4412, Epic #4405): the Epic-close audit tier defaults to `high`
 * (route only 🔴 Critical + 🟠 High into remediation; 🟡 Medium + 🟢 Suggestion
 * graduate to follow-up issues) because 🟡 Medium code-quality concerns are
 * already remediated shift-left at the write-time and Story-scope tiers — the
 * slim outermost tier stops re-paying to fix them where a fix is most
 * expensive. Setting `medium` opts back into routing 🔴/🟠/🟡 on-branch. The
 * enum is the single validation seam: a configured value round-trips through
 * the resolver, and any value outside `['high', 'medium']` is rejected at load.
 * Hard cutover per `rules/git-conventions.md` — there is no back-compat flag.
 */
const EPIC_AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    maxFixAttempts: { type: 'integer', minimum: 0 },
    maxFixScopeFiles: { type: 'integer', minimum: 1 },
    autoFixSeverity: { type: 'string', enum: ['high', 'medium'] },
  },
  additionalProperties: false,
};

// Story #2899 (Epic #2880) — performance defaults + preflight (F13).
// `delivery.ci.skipForStoryPushes` (default true via getCiDelivery): when
// true, pre-push tooling appends a `[skip ci]` trailer to Story-branch
// commit subjects so intermediate pushes do not stampede the CI fleet.
// The Epic-branch merge commit produced by story-close.js's merge
// runner never carries the marker, regardless of this flag.
//
// Story #4356 (Epic #4355) — CI-aware delivery namespace. `earlyPr` gates
// whether /deliver opens the Epic PR early (before every Story merges) so CI
// starts warming while later waves run; defaults to `true` via getCiDelivery.
// `watch.*` tunes the merge/CI watch poll loop (poll cadence, poll cap, and
// how many times the watcher may resume after a transient stall).
// `autoMerge` selects the merge posture: `"trust-ci"` (default) merges once
// required checks pass, `"strict"` additionally requires a clean review gate.
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
    skipForStoryPushes: { type: 'boolean' },
    earlyPr: { type: 'boolean' },
    watch: CI_WATCH_SCHEMA,
    autoMerge: { type: 'string', enum: ['trust-ci', 'strict'] },
  },
  additionalProperties: false,
};

// Story #2899 (Epic #2880) — `delivery.preflight.*` thresholds consumed
// by `epic-deliver-preflight.js`. When any value is exceeded the CLI
// surfaces a breach in its envelope and the workflow flips the Epic to
// `agent::blocked` (see /deliver Phase 1 prelude).
const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    maxStories: { type: 'integer', minimum: 1 },
    maxWaves: { type: 'integer', minimum: 1 },
    maxInstallCostSeconds: { type: 'integer', minimum: 1 },
    maxGithubApiRequests: { type: 'integer', minimum: 1 },
    maxClaudeQuotaTokens: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `delivery.refactorStage` — opt-in, config-gated post-green refactor
 * checkpoint wired into story-deliver (Story #3430, Epic #3418). Strictly
 * additive and default-OFF: when `enabled` is unset or `false`, story-deliver
 * behaves exactly as before. When `true`, the worker runs an advisory
 * post-green refactor pass (the `refactorer` persona +
 * `core/refactoring-discipline` skill) after the suite is green. The stage is
 * advisory only — it never changes existing close-validation gate semantics.
 */
const REFACTOR_STAGE_SCHEMA = {
  type: 'object',
  properties: {
    enabled: {
      type: 'boolean',
      description:
        'When true, story-deliver runs an advisory post-green refactor stage (refactorer persona + core/refactoring-discipline skill) after the suite is green. Default false — when unset the stage is skipped and close-validation gate semantics are unchanged.',
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.acceptanceEval` — bounded per-Story acceptance self-eval loop
 * (Story #3819). After the implementation commits land and before the
 * Story-implementation phase flips to `closing`, an independent
 * (fresh-context) critic pass scores the working diff against each inline
 * `acceptance[]` item, redrafts the unmet items, and re-evaluates — capped
 * at `maxRounds` redraft rounds.
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

export const DELIVERY_SCHEMA = {
  type: 'object',
  properties: {
    execution: EXECUTION_SCHEMA,
    maxTokenBudget: { type: 'integer', minimum: 1 },
    lease: LEASE_SCHEMA,
    docsFreshness: DOCS_FRESHNESS_SCHEMA,
    deliverRunner: DELIVER_RUNNER_SCHEMA,
    worktreeIsolation: WORKTREE_ISOLATION_SCHEMA,
    signals: SIGNALS_SCHEMA,
    quality: QUALITY_SCHEMA,
    lifecycle: LIFECYCLE_SCHEMA,
    mergeWatch: MERGE_WATCH_SCHEMA,
    epicAudit: EPIC_AUDIT_SCHEMA,
    codeReview: CODE_REVIEW_SCHEMA,
    retro: RETRO_SCHEMA,
    refactorStage: REFACTOR_STAGE_SCHEMA,
    acceptanceEval: ACCEPTANCE_EVAL_SCHEMA,
    feedbackLoop: FEEDBACK_LOOP_SCHEMA,
    ci: CI_DELIVERY_SCHEMA,
    preflight: PREFLIGHT_SCHEMA,
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
