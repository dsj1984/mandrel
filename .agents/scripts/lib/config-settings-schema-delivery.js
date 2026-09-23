/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

// delivery.* sub-schemas of AGENTRC_SCHEMA.

import { ACCEPTANCE_EVAL_DEFAULTS } from './config/acceptance-eval.js';
import { CI_DELIVERY_DEFAULTS } from './config/ci.js';
import { DELIVERY_ROUTING_DEFAULTS } from './config/delivery-routing.js';
import { DEFAULT_CODE_REVIEW } from './config/runners.js';
import { WORKTREE_ISOLATION_DEFAULTS } from './config/worktree-isolation.js';
import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';
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
  description: 'Serialization of the full-suite spawns delivery drives.',
  properties: {
    fullSuiteLock: {
      type: 'boolean',
      description:
        'Serialize full-suite spawns (`npm test` / `npm run test:coverage`) behind a host-level advisory lock, so two concurrent deliveries on one checkout do not run two suites against the same cores. Best-effort: a wait that expires spawns anyway, so the lock can never fail a delivery. Set false — or export `MANDREL_FULL_SUITE_LOCK=0` for one invocation — to disable.',
      default: true,
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

const DELIVER_RUNNER_SCHEMA = {
  type: 'object',
  description: 'Bounded-concurrency knob for the /mandrel-deliver fan-out.',
  properties: {
    concurrencyCap: {
      type: 'integer',
      minimum: 1,
      description:
        'Maximum ready Stories dispatched by /mandrel-deliver at once. Default 3. Moderate by design — keeps host-quota consumption predictable while allowing a small ready-set fan-out. Set 1 for strictly sequential delivery; raise further on hosts with adequate parallel-agent quota. See deliver.md for the sequencing model and throughput tradeoff.',
      // Runtime reads DEFAULT_DELIVER_RUNNER; a parity test keeps them equal.
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
      // Not imported: the runtime constant is `per-worktree` on win32.
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

const MERGE_WATCH_SCHEMA = {
  type: 'object',
  description:
    "Knobs consumed by the close-and-land merge wait (Story #4543). `mode` (Story #4698) selects the close-time merge posture. `maxWaitSeconds` bounds ONE invocation of the merge wait and its expiry returns a resumable `pending` terminal with no label mutation; `maxBudgetSeconds` bounds the CUMULATIVE wait across resumes (anchored at the PR's createdAt, so a resume does not restart the clock) and exhausting it is the genuine give-up that classifies and blocks. The 30s poll cadence and the cap of 3 behind-the-base updates are fixed.",
  properties: {
    mode: {
      type: 'string',
      enum: ['sync', 'async'],
      description:
        'Close-time merge-wait posture (Story #4698). `sync` (default) keeps the in-close foreground merge wait unchanged. `async` caps the per-invocation wait to a short ~60s probe window — long enough to catch an instant merge and, via the head-anchored required-check predicate, an instantly-red required check — then returns the resumable `pending` terminal (exit 3) with a `nextCommand`. Opt in when slow CI makes the foreground wait routinely expire: the worker launches `nextCommand` in the background instead of burning the host tool slot polling. `maxBudgetSeconds` (the cumulative give-up) is unchanged.',
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
  },
  additionalProperties: false,
};

const ROUTING_SCHEMA = {
  type: 'object',
  description:
    'v2 delivery-spawn routing: role-scoped boot contexts and the ceremony profile. The v1 singleDelivery epic-route kill-switch was removed in Stage 6; the freshCriticSampleRate sampling floor was retired in Story #5313 and the derived-level ceremony routing in Story #5343.',
  properties: {
    roleScopedAgents: {
      type: 'boolean',
      description:
        'Epic #4478 (M7-B). Kill-switch for the role-scoped boot contexts. When true (default), a converted delivery spawn (`story-worker`, `acceptance-critic`) boots on its own `.claude/agents/<role>.md` system prompt instead of re-paying the full entry-doc (AGENTS.md or CLAUDE.md) @-import closure. When false, every converted spawn falls back to `subagent_type: general-purpose` — the instant, code-rollback-free per-consumer revert, and the universal escape for hosts that ignore `.claude/agents/`. The fallback is the full-closure agent that ran before M7-B, so flipping it off never drops a gate.',
      default: DELIVERY_ROUTING_DEFAULTS.roleScopedAgents,
    },
    ceremonyProfile: {
      type: 'string',
      enum: ['minimal', 'standard', 'strict'],
      description:
        'Acceptance-ceremony depth — who authors the Story acceptance verdict. minimal and standard (default) = the inline self-eval, whatever the diff touches; strict = a fresh-context maker-blind critic. Review depth is a separate decision and still derives `deep` for any sensitive path (review-depth.js).',
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

const CI_DELIVERY_SCHEMA = {
  type: 'object',
  description:
    'CI-aware delivery namespace (Story #4356, Epic #4355): the merge posture and the advisory-check policy.',
  properties: {
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

const ACCEPTANCE_EVAL_SCHEMA = {
  type: 'object',
  description:
    'Story #3819. Bounded per-Story acceptance self-eval loop. After the implementation commits land and before the Story-implementation phase flips to `closing`, an independent (fresh-context) critic pass scores the caller-injected change set against each inline `acceptance[]` item, redrafts the unmet items, and re-evaluates — capped at `maxRounds` redraft rounds (0 = scored once, no redraft), then escalates to `agent::blocked` when criteria remain unmet. There is no `enabled` flag: the scoring pass is a hard cutover (always on).',
  properties: {
    maxRounds: {
      type: 'integer',
      minimum: 0,
      description:
        'Maximum number of redraft rounds before escalation. Default 2; 0 means the verdict is scored once with no redraft round (Story #5313 dropped the hard ceiling and the floor-of-one clamp).',
      default: ACCEPTANCE_EVAL_DEFAULTS.maxRounds,
    },
  },
  additionalProperties: false,
};

// `retroProposals` defaults off: the auto-filer's output was mostly noise.
const FEEDBACK_LOOP_SCHEMA = {
  type: 'object',
  description:
    'Opt-in toggle for the close-time retro auto-file graduator. Auto-filing defaults to OFF (Story #5341).',
  properties: {
    retroProposals: {
      type: 'boolean',
      description:
        'When true, the retro auto-files its actionable routed proposals as meta::<framework-gap|consumer-improvement> + friction::<category> issues via the graduator pre-parsed-findings seam, and the rendered retro sections list the filed issue numbers instead of paste-ready gh command stanzas. Defaults to false (Story #5341), which renders the command stanzas instead.',
      default: false,
    },
  },
  additionalProperties: false,
};

// Families with no recoverable Story id (audits, plan dirs) use a fixed
// 7-day age floor.
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
    'Everything `/mandrel-deliver` and `single-story-close` consume: worktree isolation, runner concurrency, docs freshness, quality gates, merge/CI watch, review ceremony, and the feedback loop.',
  properties: {
    execution: EXECUTION_SCHEMA,
    docsFreshness: DOCS_FRESHNESS_SCHEMA,
    tempRetention: TEMP_RETENTION_SCHEMA,
    deliverRunner: DELIVER_RUNNER_SCHEMA,
    worktreeIsolation: WORKTREE_ISOLATION_SCHEMA,
    // Gate-level schemas (`config/gates/*.schema.js`) compose in here.
    quality: QUALITY_SCHEMA,
    mergeWatch: MERGE_WATCH_SCHEMA,
    codeReview: CODE_REVIEW_SCHEMA,
    refactorStage: REFACTOR_STAGE_SCHEMA,
    acceptanceEval: ACCEPTANCE_EVAL_SCHEMA,
    feedbackLoop: FEEDBACK_LOOP_SCHEMA,
    ci: CI_DELIVERY_SCHEMA,
    routing: ROUTING_SCHEMA,
  },
  additionalProperties: false,
};
