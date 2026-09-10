/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

// ---------------------------------------------------------------------------
// delivery.* sub-schemas — extracted from config-settings-schema.js to keep
// the aggregate AGENTRC_SCHEMA module under the maintainability floor. These
// are pure declarative AJV fragments referenced by DELIVERY_SCHEMA; moving
// them here does not change validation semantics (the resolved schema is
// byte-for-byte equivalent in effect).
// ---------------------------------------------------------------------------

import { ACCEPTANCE_EVAL_DEFAULTS } from './config/acceptance-eval.js';
import { CI_DELIVERY_DEFAULTS } from './config/ci.js';
import { DELIVERY_ROUTING_DEFAULTS } from './config/delivery-routing.js';
import { LIMITS_DEFAULTS } from './config/limits.js';
import { DEFAULT_CODE_REVIEW } from './config/runners.js';
import { WORKTREE_ISOLATION_DEFAULTS } from './config/worktree-isolation.js';
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
  description: 'Wall-clock bounds on the subprocesses delivery spawns.',
  properties: {
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      description:
        'Per-command timeout (ms) for the long-running spawns delivery drives — the close-validation chain and the gate CLIs.',
      default: LIMITS_DEFAULTS.executionTimeoutMs,
    },
    fullSuiteLock: {
      type: 'boolean',
      description:
        'Serialize full-suite spawns (`npm test` / `npm run test:coverage`) behind a host-level advisory lock, so two concurrent deliveries on one checkout do not run two suites against the same cores. Best-effort: a wait that expires spawns anyway, so the lock can never fail a delivery. Set false — or export `MANDREL_FULL_SUITE_LOCK=0` for one invocation — to disable.',
      default: true,
    },
    requireCreditedCapture: {
      type: 'boolean',
      description:
        'Refuse a full-suite coverage capture that no committed stamp covers, instead of paying for it. Default false — the run is announced (a warning naming the crediting invocation, emitted before the spawn) and then executed, which is the pre-existing behaviour. Set true when the whole-suite cost is large enough that a close should stop at zero seconds rather than absorb it silently.',
      default: false,
    },
  },
  additionalProperties: false,
};

const DOCS_FRESHNESS_SCHEMA = {
  type: 'object',
  description:
    'Documentation-freshness scope: the files a change of consequence is expected to touch. Read by the audit-documentation lens to seed its target set; no delivery gate enforces it.',
  properties: {
    paths: {
      type: 'array',
      items: { ...SAFE_STRING, minLength: 1 },
      description:
        'Repo-relative documentation paths the audit-documentation lens adds to its target set.',
      default: ['README.md'],
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
  description: 'Bounded-concurrency knob for the /mandrel-deliver fan-out.',
  properties: {
    concurrencyCap: {
      type: 'integer',
      minimum: 1,
      description:
        'Maximum ready Stories dispatched by /mandrel-deliver at once. Default 3. Moderate by design — keeps host-quota consumption predictable while allowing a small ready-set fan-out. Set 1 for strictly sequential delivery; raise further on hosts with adequate parallel-agent quota. See deliver.md for the sequencing model and throughput tradeoff.',
      // getRunners() resolves this from its own DEFAULT_DELIVER_RUNNER
      // constant, not from this annotation; the parity suite asserts the two
      // agree.
      default: 3,
    },
    footprintGuard: {
      type: 'string',
      enum: ['enforce', 'advisory'],
      description:
        "How a file-footprint collision affects dispatch. 'enforce' (default, and the behaviour to keep unless you have a reason) withholds a Story whose footprint races a peer admitted this beat or one still in flight — the guard encodes delivery-time-only knowledge (open implementation windows, foreign leases, ground that moved since planning) that no depends_on edge can carry. 'advisory' still DETECTS every collision and reports each would-be withhold in the tick envelope, but lets dispatch follow the declared depends_on edges alone — a deliberate throughput trade for a run whose ordering is fully declared. See stories-wave-tick.js and helpers/deliver-reference.md.",
      default: 'enforce',
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.worktreeIsolation` — per-Story git worktree provisioning.
 */
const WORKTREE_ISOLATION_SCHEMA = {
  type: 'object',
  description:
    'Per-Story git worktree provisioning. Each Story is implemented in its own checkout so concurrent siblings never share a working tree.',
  properties: {
    enabled: {
      type: 'boolean',
      description:
        'When true, `single-story-init.js` materializes a worktree per Story. False implements every Story in the main checkout, which is only safe for strictly serial delivery.',
      default: WORKTREE_ISOLATION_DEFAULTS.enabled,
    },
    root: {
      type: 'string',
      minLength: 1,
      description:
        'Repo-relative directory the per-Story worktrees are created under. Required whenever `enabled` is explicitly true.',
      default: WORKTREE_ISOLATION_DEFAULTS.root,
    },
    nodeModulesStrategy: {
      type: 'string',
      enum: ['per-worktree', 'clone', 'symlink', 'pnpm-store'],
      description:
        'How each worktree gets its dependencies. `clone` copy-on-writes the main checkout tree (fast, cross-platform); `per-worktree` runs a full install; `symlink` links the shared tree (POSIX only unless `allowSymlinkOnWindows`); `pnpm-store` re-links from the pnpm content store.',
      // Pinned to the cross-platform documented default. The runtime constant
      // is evaluated at import time and resolves to `per-worktree` on win32,
      // so it must not be imported here.
      default: 'clone',
    },
    primeFromPath: {
      type: ['string', 'null'],
      minLength: 1,
      description:
        'Absolute path to an existing `node_modules` tree to prime new worktrees from, instead of the main checkout. `null` uses the main checkout.',
      default: WORKTREE_ISOLATION_DEFAULTS.primeFromPath,
    },
    allowSymlinkOnWindows: {
      type: 'boolean',
      description:
        'Permit the `symlink` strategy on win32, where it needs Developer Mode or elevation. Off by default so a Windows consumer fails over to a strategy that works.',
      default: WORKTREE_ISOLATION_DEFAULTS.allowSymlinkOnWindows,
    },
    reapOnSuccess: {
      type: 'boolean',
      description:
        "Remove the Story's worktree once its PR merges. False keeps it for post-mortem inspection.",
      default: WORKTREE_ISOLATION_DEFAULTS.reapOnSuccess,
    },
    bootstrapFiles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'Gitignored files copied from the main checkout into every new worktree. A worktree checks out tracked files only, so local secrets and overrides would otherwise be missing.',
      default: [...WORKTREE_ISOLATION_DEFAULTS.bootstrapFiles],
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
  description:
    'Detector thresholds for the surviving performance-signal categories. Each block is shallow-merged by the resolver.',
  properties: {
    rework: {
      type: 'object',
      description: 'Rework detector — repeated edits to one file in a run.',
      properties: {
        editsPerFile: {
          type: 'integer',
          minimum: 1,
          description:
            'Edits to a single file within one run that trip the rework signal.',
          default: LIMITS_DEFAULTS.signals.rework.editsPerFile,
        },
      },
      additionalProperties: false,
    },
    retry: {
      type: 'object',
      description: 'Retry detector — the same command failing repeatedly.',
      properties: {
        repeatCount: {
          type: 'integer',
          minimum: 1,
          description:
            'Repeats of an identical failing command that trip the retry signal.',
          default: LIMITS_DEFAULTS.signals.retry.repeatCount,
        },
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
  description:
    "Knobs consumed by the close-and-land merge wait (Story #4543; defaults in `lib/orchestration/merge-poll.js`). `mode` (Story #4698) selects the close-time merge posture. `intervalSeconds` is the poll cadence between `gh pr view` probes after the arm. `maxWaitSeconds` bounds ONE invocation of the merge wait and its expiry returns a resumable `pending` terminal with no label mutation; `maxBudgetSeconds` bounds the CUMULATIVE wait across resumes (anchored at the PR's createdAt, so a resume does not restart the clock) and exhausting it is the genuine give-up that classifies and blocks. `updateAttempts` caps the bounded update of a behind-the-base PR.",
  properties: {
    mode: {
      type: 'string',
      enum: ['sync', 'async'],
      description:
        'Close-time merge-wait posture (Story #4698). `sync` (default) keeps the in-close foreground merge wait unchanged. `async` caps the per-invocation wait to a short ~60s probe window — long enough to catch an instant merge and, via the head-anchored required-check predicate, an instantly-red required check — then returns the resumable `pending` terminal (exit 3) with a `nextCommand`. Opt in when slow CI makes the foreground wait routinely expire: the worker launches `nextCommand` in the background instead of burning the host tool slot polling. `maxBudgetSeconds` (the cumulative give-up) is unchanged.',
    },
    intervalSeconds: {
      type: 'integer',
      minimum: 1,
      description: 'Seconds between merge-wait polls. Default 30.',
      default: 30,
    },
    maxWaitSeconds: {
      type: 'integer',
      minimum: 1,
      description:
        'Per-invocation merge-wait bound (seconds). Default 300 (5 minutes) — chosen to fit inside a single host tool invocation (~10 min ceiling) alongside the close gates that precede the wait. Expiry yields `pending` (exit 3), never a block. Headless callers with no host ceiling raise this to land in one block.',
    },
    maxBudgetSeconds: {
      type: 'integer',
      minimum: 1,
      description:
        "Cumulative wall-clock budget (seconds) across merge-wait resumes, anchored at the PR's createdAt. Default 3600 (60 minutes). Exhausting this classifies the block and transitions the Story to agent::blocked.",
      default: 3600,
    },
    updateAttempts: {
      type: 'integer',
      minimum: 0,
      description:
        'Maximum times the merge wait will bring a behind-the-base PR up to date before giving up on the branch. Default 3. Set 0 to disable the update.',
    },
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
  description:
    'v2 delivery-spawn routing: role-scoped boot contexts and maker-checker sampling. The v1 singleDelivery epic-route kill-switch was removed in Stage 6.',
  properties: {
    roleScopedAgents: {
      type: 'boolean',
      description:
        'Epic #4478 (M7-B). Kill-switch for the role-scoped boot contexts. When true (default), a converted delivery spawn (`story-worker`, `acceptance-critic`) boots on its own `.claude/agents/<role>.md` system prompt instead of re-paying the full CLAUDE.md @-import closure. When false, every converted spawn falls back to `subagent_type: general-purpose` — the instant, code-rollback-free per-consumer revert, and the universal escape for hosts that ignore `.claude/agents/`. The fallback is the full-closure agent that ran before M7-B, so flipping it off never drops a gate.',
      default: DELIVERY_ROUTING_DEFAULTS.roleScopedAgents,
    },
    freshCriticSampleRate: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Epic #4478 (M7-B, Part 2). Maker-checker sampling floor. Under the standard profile, a change set touching no sensitive path routes its acceptance clusters down the contract-identical inline critic path, but this fraction of them is still forced through a fresh-context critic so a low derived level never means zero independent checking. Clamped to [0, 1]; 0 disables the floor, 1 forces every cluster fresh. Consumed by resolveCeremonyForRisk (lib/orchestration/ceremony-routing.js).',
      default: DELIVERY_ROUTING_DEFAULTS.freshCriticSampleRate,
    },
    ceremonyProfile: {
      type: 'string',
      enum: ['minimal', 'standard', 'strict'],
      description:
        'Acceptance-ceremony depth. minimal = always inline critic; strict = always fresh-context critic; standard (default) = routed off the change level derived from the Story diff, with the maker-checker sampling floor.',
      default: DELIVERY_ROUTING_DEFAULTS.ceremonyProfile,
    },
    closeAndLand: {
      type: 'boolean',
      description:
        'When true (default), single-story-close lands through merge in one close. Opt out per-run with --no-wait-merge.',
      default: DELIVERY_ROUTING_DEFAULTS.closeAndLand,
    },
  },
  additionalProperties: false,
};

// Story #4356 (Epic #4355) — CI-aware delivery namespace. `watch.*` tunes
// the merge/CI watch poll loop; `autoMerge` selects the merge posture.
// Retired: `earlyPr` (Epic early-PR warmup) and `requireChecks` (no
// AutomergePredicate reader on v2).
// Story #4890 added `attachWindowMs`: how long the watch keeps re-resolving an
// EMPTY required-check set before it stops waiting for one. This block is
// `additionalProperties: false`, so the knob is inert unless it lands here AND
// in the `.agents/schemas/agentrc.schema.json` mirror.
// The four `watch.*` defaults below mirror WATCH_DEFAULTS in
// `pr-watch-with-update.js`. Restated rather than imported: that module is a
// CLI, and importing it behind a schema declaration would drag its
// `runAsCli` wiring into every config read. The rewritten parity suite
// asserts the two agree.
const CI_WATCH_SCHEMA = {
  type: 'object',
  description:
    'Story #4356 (Epic #4355). Poll-loop tuning for the merge/CI watch. pollIntervalMs is the cadence between check probes; maxPolls caps total probes before the watcher gives up; maxResumes caps how many times the watcher may resume after a transient stall; attachWindowMs bounds the wait for a required context to attach at all.',
  properties: {
    pollIntervalMs: {
      type: 'integer',
      minimum: 1,
      description: 'Milliseconds between check probes.',
      default: 10000,
    },
    maxPolls: {
      type: 'integer',
      minimum: 1,
      description:
        'Total probes before the watcher gives up on one invocation.',
      default: 180,
    },
    maxResumes: {
      type: 'integer',
      minimum: 0,
      description:
        'How many times the watcher may resume after a transient stall. 0 disables resuming.',
      default: 3,
    },
    attachWindowMs: {
      type: 'integer',
      minimum: 1,
      description:
        'Story #4890. How long (ms) the watch keeps re-resolving an EMPTY `gh pr checks --required` set before it stops waiting for a required context to attach. A ruleset attaches its contexts asynchronously and the arrival latency is set by the slowest one, so a required context that is an aggregator job gated on every other tier is the last to appear — measured at 16m52s on this repository. Default 1200000 (20 minutes). Raise it for a repository whose contexts arrive later still; exhausting the window is never reported as a red check (the watch exits 2, not-yet-started).',
      default: 1200000,
    },
  },
  additionalProperties: false,
};

const CI_DELIVERY_SCHEMA = {
  type: 'object',
  description:
    'CI-aware delivery namespace (Story #4356, Epic #4355): the merge/CI watch poll loop and the merge posture.',
  properties: {
    watch: CI_WATCH_SCHEMA,
    autoMerge: {
      type: 'string',
      enum: ['trust-ci', 'strict'],
      description:
        "Story #4356 (Epic #4355). Merge posture. 'trust-ci' (default) merges once required checks pass; 'strict' additionally requires a clean review gate.",
      default: CI_DELIVERY_DEFAULTS.autoMerge,
    },
    blockOnAdvisoryFailure: {
      type: 'boolean',
      description:
        'Story #5096. When true (default), delivery refuses to arm — and disarms — GitHub native auto-merge while a non-required (advisory) check is genuinely red on the PR head and GitHub reports the PR mergeable anyway (mergeStateStatus=UNSTABLE). `--auto` waits on REQUIRED contexts only, so without this a red advisory quality gate merges unattended. Set false to restore the pre-#5096 behaviour verbatim.',
      default: CI_DELIVERY_DEFAULTS.blockOnAdvisoryFailure,
    },
    advisoryAllowlist: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Story #5096. Check-run names exempt from blockOnAdvisoryFailure — a red run whose name matches exactly never blocks arming. Matching is exact; an unnamed run can never match and always blocks.',
      default: [...CI_DELIVERY_DEFAULTS.advisoryAllowlist],
    },
    rerunAdvisory: {
      type: 'integer',
      minimum: 0,
      description:
        'Story #5266. How many times close may re-run a failed advisory workflow run before blocking on it, per close invocation. Default 0: close spends no CI minutes and issues no GitHub mutation on an advisory red unless asked. At n > 0 the failed run(s) are re-run within that allowance and the merge wait re-polls inside its existing budget, landing or blocking on the re-run verdict. Overridden per invocation by --rerun-advisory <n>.',
      default: CI_DELIVERY_DEFAULTS.rerunAdvisory,
    },
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
  description:
    'Opt-in, config-gated post-green refactor checkpoint wired into story-deliver (Story #3430, Epic #3418). Strictly additive and default-OFF: when disabled, story-deliver behaves exactly as before. Advisory only — never changes existing close-validation gate semantics.',
  properties: {
    enabled: {
      type: 'boolean',
      description:
        'When true, story-deliver runs an advisory post-green refactor stage (core/code-review-and-quality skill, Post-Green Refactor Pass) after the suite is green. Default false — when unset the stage is skipped and close-validation gate semantics are unchanged.',
      default: false,
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
  description:
    'Story #3819. Bounded per-Story acceptance self-eval loop. After the implementation commits land and before the Story-implementation phase flips to `closing`, an independent (fresh-context) critic pass scores the caller-injected change set against each inline `acceptance[]` item, redrafts the unmet items, and re-evaluates — capped at `maxRounds` redraft rounds, then escalates to `agent::blocked` when criteria remain unmet. There is no `enabled` flag: the loop is a hard cutover (always on).',
  properties: {
    maxRounds: {
      type: 'integer',
      minimum: 1,
      description:
        'Maximum number of redraft rounds before escalation. Default 2; clamped into [1, hard ceiling] by lib/config/acceptance-eval.js so the cap can never be disabled (maxRounds: 0 clamps up to 1).',
      default: ACCEPTANCE_EVAL_DEFAULTS.maxRounds,
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
  description:
    'Close-scope review tuning (Story #4699). Governs the Story-scope local-lens pass that runs inside the close subprocess; the maker-blind code-review pass and all hard gates are unaffected.',
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
 *
 * `frictionWindowDays` (Story #4850) bounds the run-scope friction recurrence
 * window by row age. The window deliberately spans every surviving signal
 * stream rather than the triggering run's own Stories — that is what lets a
 * once-per-Story systemic defect reach the ≥ 2 actionable threshold — which
 * left it unbounded in time, so a defect fixed weeks ago kept re-routing. An
 * integer ≥ 1; unset means 30 days.
 */
const FEEDBACK_LOOP_SCHEMA = {
  type: 'object',
  description:
    'Opt-out toggles for the close-time auto-file graduators. All default to auto-filing on.',
  properties: {
    auditResultsAutoFile: {
      type: 'boolean',
      description:
        'When true (default), the close-time audit-results graduator auto-files non-blocking audit-results findings as follow-up issues routed by source classification. Set to false to suppress auto-filing; findings remain accessible in the structured comments on the Story.',
      default: true,
    },
    retroProposals: {
      type: 'boolean',
      description:
        'When true (default), the retro auto-files its actionable routed proposals as meta::<framework-gap|consumer-improvement> + friction::<category> issues via the graduator pre-parsed-findings seam, and the rendered retro sections list the filed issue numbers instead of paste-ready gh command stanzas. Set to false to fall back to the command stanzas.',
      default: true,
    },
    frictionWindowDays: {
      type: 'integer',
      minimum: 1,
      description:
        "How many days back the run-scope friction recurrence window reaches (Story #4850). The window spans every surviving per-Story signal stream rather than the triggering run's own Stories, so that a defect firing once per Story can reach the actionable threshold; this bounds it by age so a defect fixed weeks ago stops re-routing. Rows older than the bound — and rows carrying no readable timestamp — are excluded and counted on the roll-up step result. Default 30.",
    },
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
  description:
    'Knobs for the `/audit-to-stories` unattended (`--auto`) sweep (Story #4626).',
  properties: {
    severityFloor: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low', 'all'],
      description:
        'Minimum severity a finding must meet to be proposed as a Story on an unattended `/audit-to-stories --auto` sweep (Story #4626). Default high.',
    },
    autoComment: {
      type: 'boolean',
      description:
        'When true (default), `/audit-to-stories --auto` posts a re-detected comment on an already-open matched Issue instead of silently skipping it.',
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.tempRetention` — auto-purge of spent temp artifacts (Story #4794).
 *
 * `enabled` defaults to `true`: reclaiming a landed Story's gate transcripts
 * and evidence is the behaviour, and the knob exists to turn it off. `classes`
 * lets an operator keep one family while purging the rest; `staleDays` is the
 * age floor for the families no Story id can be recovered from (audit reports,
 * abandoned `plan-<slug>/` dirs).
 */
const TEMP_RETENTION_SCHEMA = {
  type: 'object',
  description:
    'Story #4794. Auto-purge of spent temp artifacts once their Story lands. ' +
    'Classification is an allowlist: only the declared classes below are ever ' +
    'deleted, so operator scratch files under tempRoot are reported with their ' +
    'size and left alone. signals.ndjson is never purged by any path.',
  properties: {
    enabled: {
      type: 'boolean',
      description:
        "Master switch. Default true — reclaiming a landed Story's gate " +
        'transcripts and validation evidence is the behaviour, and this knob ' +
        'turns it off. When false every purge path is a reported no-op.',
      default: true,
    },
    staleDays: {
      type: 'integer',
      minimum: 1,
      description:
        'Age floor (days, default 7) for the families no Story id can be ' +
        'recovered from — roster-level audit reports and abandoned ' +
        'plan-<slug>/ dirs. Story-keyed artifacts do not wait for it: they are ' +
        'purged as soon as their merge is confirmed.',
      default: 7,
    },
    classes: {
      type: 'object',
      description:
        'Per-class opt-out. Each defaults to true; set one false to keep that ' +
        'family while the rest are purged.',
      properties: {
        orchestrationLogs: {
          type: 'boolean',
          description:
            '<tempRoot>/orchestration/*.log — close gate transcripts and ' +
            'terse-result detail dumps.',
          default: true,
        },
        validationEvidence: {
          type: 'boolean',
          description:
            'Per-Story validation-evidence.json, lifecycle.ndjson, and ' +
            'manifest.md under the standalone and per-run story trees.',
          default: true,
        },
        auditResults: {
          type: 'boolean',
          description: '<tempRoot>/audits/ — audit lens reports.',
          default: true,
        },
        planDirs: {
          type: 'boolean',
          description:
            '<tempRoot>/plan-<slug>/ — abandoned plan authoring dirs. ' +
            'Age-floored only; the current run is always excluded.',
          default: true,
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const DELIVERY_SCHEMA = {
  type: 'object',
  description:
    'Everything `/mandrel-deliver` and `single-story-close` consume: execution timeouts, worktree isolation, runner concurrency, docs freshness, signals, quality gates, merge/CI watch, review ceremony, and the feedback loop.',
  properties: {
    execution: EXECUTION_SCHEMA,
    docsFreshness: DOCS_FRESHNESS_SCHEMA,
    tempRetention: TEMP_RETENTION_SCHEMA,
    deliverRunner: DELIVER_RUNNER_SCHEMA,
    worktreeIsolation: WORKTREE_ISOLATION_SCHEMA,
    signals: SIGNALS_SCHEMA,
    // `quality.gates.crap.incrementalCoverage` (Story #4981) is declared in
    // `config/gates/crap.schema.js` and reaches AJV validation through this
    // property — QUALITY_SCHEMA → GATES_SCHEMA → CRAP_GATE. No separate
    // declaration lives here; this is the composition point that makes the
    // gate-level schema authoritative for the top-level `.agentrc.json`
    // surface this module validates.
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
