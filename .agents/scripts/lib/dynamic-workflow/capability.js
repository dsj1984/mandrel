// .agents/scripts/lib/dynamic-workflow/capability.js
/**
 * Dynamic-workflow capability detection + audit-lens strategy selection.
 *
 * Originated as the `audit-clean-code` dynamic-workflow pilot (Story #3278)
 * and generalized to five read-only, dimensionally-decomposable lenses
 * (`audit-clean-code`, `audit-security`, `audit-performance`,
 * `audit-architecture`, `audit-quality`) under Epic #3597. The one-shot pilot
 * doc has been retired; this module docstring is the **canonical home for the
 * capability-degradation rationale** (the "Why this is not a contract shim"
 * section below), and `docs/roadmap.md` (Part 3 — Dynamic-Workflow
 * Orchestration) holds the orchestrated-run evidence and per-lens
 * cost/precision gate verdicts.
 *
 * Claude Code's [dynamic workflows](https://code.claude.com/docs/en/workflows)
 * let a JS script orchestrate many subagents in the background. They are a
 * Claude Code-only, paid-plan, research-preview feature (CC >= 2.1.154). Each
 * generalized lens runs along **two execution paths**:
 *
 *   1. **orchestrated** — the per-lens dynamic-workflow script
 *      (`.claude/workflows/<lens>.workflow.js`) fans the lens dimensions out
 *      as parallel subagents with an adversarial cross-check stage, then emits
 *      the report contract.
 *   2. **sequential** — the existing single-pass lens
 *      (`.agents/workflows/<lens>.md`) followed turn-by-turn.
 *
 * Both paths MUST emit the identical per-lens report contract
 * (`{{auditOutputDir}}/<lens>-results.md`), so downstream consumers
 * (`/deliver` Phase 4 epic-audit, `audit-to-stories`) are agnostic to
 * which path produced it.
 *
 * ## Why this is capability-degradation, not a contract shim
 *
 * The No-Shim / hard-cutover rule in `.agents/rules/git-conventions.md`
 * governs *contract version* changes (config / schema / lifecycle shape) and
 * forbids running two shapes of the **same contract** side by side. This
 * module does the opposite: it keeps **one** report contract and selects an
 * **execution strategy** from a runtime capability snapshot — the same
 * pattern the protocol already endorses in `.agents/instructions.md`
 * §1.C/§1.D (live-docs → in-repo → web fallback order). There is no second
 * report shape, no version-windowed sunset, and no legacy reader to delete
 * later.
 *
 * This module is **pure** — `detectDynamicWorkflowCapability` reads an
 * injected environment snapshot (never `process` / `fs` directly) and
 * `selectAuditStrategy` is a pure function of that snapshot. The split keeps
 * strategy selection unit-testable without a live Claude Code runtime.
 *
 * @module dynamic-workflow/capability
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum Claude Code version that ships the dynamic-workflow runtime
 * (research preview). Below this floor the orchestrated path is unavailable
 * even on a paid Claude Code runtime.
 *
 * Source: https://code.claude.com/docs/en/workflows ("require Claude Code
 * v2.1.154 or later").
 */
export const DYNAMIC_WORKFLOW_VERSION_FLOOR = '2.1.154';

/** The two execution strategies the lens can run under. */
export const AUDIT_STRATEGY = Object.freeze({
  ORCHESTRATED: 'orchestrated',
  SEQUENTIAL: 'sequential',
});

/**
 * Environment-variable names consulted when a caller does not inject an
 * explicit snapshot. Kept as constants so the docs / tests reference the
 * exact keys rather than hard-coding the strings.
 */
export const ENV_KEYS = Object.freeze({
  /** Hard kill-switch documented at code.claude.com/docs/en/workflows. */
  DISABLE: 'CLAUDE_CODE_DISABLE_WORKFLOWS',
  /** Test/operator force-override: `orchestrated` | `sequential`. */
  FORCE_STRATEGY: 'MANDREL_AUDIT_STRATEGY',
  /** Runtime identity (`claude-code` when running under Claude Code). */
  RUNTIME: 'CLAUDE_CODE_RUNTIME',
  /** Claude Code version string (e.g. `2.1.160`). */
  VERSION: 'CLAUDE_CODE_VERSION',
  /** Entitlement hint (`pro` | `max` | `team` | `enterprise` | `api`). */
  PLAN: 'CLAUDE_CODE_PLAN',
});

/** Reason codes attached to a strategy decision for observability. */
export const DECISION_REASON = Object.freeze({
  FORCED_ORCHESTRATED: 'forced-orchestrated',
  FORCED_SEQUENTIAL: 'forced-sequential',
  CAPABILITY_PRESENT: 'capability-present',
  NOT_CLAUDE_RUNTIME: 'not-claude-runtime',
  DISABLED_SETTING: 'disabled-setting',
  DISABLED_ENV: 'disabled-env',
  VERSION_BELOW_FLOOR: 'version-below-floor',
  UNPAID_PLAN: 'unpaid-plan',
  RUNTIME_UNKNOWN: 'runtime-unknown',
});

// Truthy env-flag values (mirrors how Claude Code reads boolean env flags:
// the var is "set" when present and not an explicit falsey token).
const FALSEY_FLAG = new Set(['', '0', 'false', 'off', 'no']);

// Paid plan/entitlement tokens that unlock dynamic workflows.
const PAID_PLANS = new Set(['pro', 'max', 'team', 'enterprise', 'api']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Is an environment flag "set" in the truthy sense Claude Code uses for
 * `CLAUDE_CODE_DISABLE_WORKFLOWS`? Present and not an explicit falsey token.
 *
 * @param {string|undefined|null} raw
 * @returns {boolean}
 */
export function isFlagSet(raw) {
  if (raw === undefined || raw === null) return false;
  return !FALSEY_FLAG.has(String(raw).trim().toLowerCase());
}

/**
 * Compare two dotted numeric version strings. Returns a negative number when
 * `a < b`, zero when equal, positive when `a > b`. Non-numeric / missing
 * segments are treated as 0. Pre-release suffixes (e.g. `-rc1`) are ignored.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const norm = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((seg) => {
        const n = Number.parseInt(seg, 10);
        return Number.isNaN(n) ? 0 : n;
      });
  const av = norm(a);
  const bv = norm(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Does `version` meet or exceed the dynamic-workflow floor?
 *
 * @param {string} version
 * @param {string} [floor=DYNAMIC_WORKFLOW_VERSION_FLOOR]
 * @returns {boolean}
 */
export function meetsVersionFloor(
  version,
  floor = DYNAMIC_WORKFLOW_VERSION_FLOOR,
) {
  if (!version) return false;
  return compareVersions(version, floor) >= 0;
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CapabilitySnapshot
 * @property {string|undefined} [runtime]   - Runtime identity (`claude-code` …).
 * @property {string|undefined} [version]   - Claude Code version string.
 * @property {string|undefined} [plan]      - Plan/entitlement token.
 * @property {boolean}          [disableWorkflowsSetting] - `disableWorkflows` from settings.json.
 * @property {string|undefined} [disableWorkflowsEnv]     - Raw env value of CLAUDE_CODE_DISABLE_WORKFLOWS.
 */

/**
 * @typedef {object} CapabilityResult
 * @property {boolean} available        - Whether the orchestrated path can run.
 * @property {string}  reason           - One of {@link DECISION_REASON}.
 * @property {object}  detail           - Echoed snapshot facts for logging.
 */

/**
 * Detect whether the dynamic-workflow orchestrated path is available, from an
 * **injected** environment snapshot. The function is pure: callers resolve
 * `process.env` / settings.json and pass the facts in, so the decision is
 * reproducible in tests without a live runtime.
 *
 * Detection accounts for, in priority order:
 *   1. Non-Claude runtime → unavailable (`not-claude-runtime`).
 *   2. `disableWorkflows: true` in settings → unavailable (`disabled-setting`).
 *   3. `CLAUDE_CODE_DISABLE_WORKFLOWS` set → unavailable (`disabled-env`).
 *   4. CC version below {@link DYNAMIC_WORKFLOW_VERSION_FLOOR} → unavailable.
 *   5. Non-paid plan (when the plan token is known) → unavailable.
 *   6. Otherwise → available.
 *
 * When the runtime identifies as Claude Code but supplies no version, the
 * function fails **closed** (`runtime-unknown`, unavailable): an undetectable
 * version cannot be assumed to clear the research-preview floor, and the
 * sequential lens is always a safe fallback.
 *
 * @param {CapabilitySnapshot} snapshot
 * @returns {CapabilityResult}
 */
export function detectDynamicWorkflowCapability(snapshot = {}) {
  const {
    runtime,
    version,
    plan,
    disableWorkflowsSetting,
    disableWorkflowsEnv,
  } = snapshot;

  const detail = {
    runtime: runtime ?? null,
    version: version ?? null,
    plan: plan ?? null,
    disableWorkflowsSetting: Boolean(disableWorkflowsSetting),
    disableWorkflowsEnv: isFlagSet(disableWorkflowsEnv),
  };

  const isClaudeRuntime =
    typeof runtime === 'string' && /claude[-_ ]?code/i.test(runtime);
  if (!isClaudeRuntime) {
    return {
      available: false,
      reason: DECISION_REASON.NOT_CLAUDE_RUNTIME,
      detail,
    };
  }

  if (disableWorkflowsSetting === true) {
    return {
      available: false,
      reason: DECISION_REASON.DISABLED_SETTING,
      detail,
    };
  }

  if (isFlagSet(disableWorkflowsEnv)) {
    return { available: false, reason: DECISION_REASON.DISABLED_ENV, detail };
  }

  if (!version) {
    // Claude Code runtime but no resolvable version → fail closed.
    return {
      available: false,
      reason: DECISION_REASON.RUNTIME_UNKNOWN,
      detail,
    };
  }

  if (!meetsVersionFloor(version)) {
    return {
      available: false,
      reason: DECISION_REASON.VERSION_BELOW_FLOOR,
      detail,
    };
  }

  // Plan is only a gate when we actually know it. An absent plan token does
  // not block — the runtime will refuse the launch itself if unentitled, and
  // the sequential fallback covers that case.
  if (typeof plan === 'string' && plan.trim().length > 0) {
    if (!PAID_PLANS.has(plan.trim().toLowerCase())) {
      return { available: false, reason: DECISION_REASON.UNPAID_PLAN, detail };
    }
  }

  return {
    available: true,
    reason: DECISION_REASON.CAPABILITY_PRESENT,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Strategy selection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} StrategyDecision
 * @property {('orchestrated'|'sequential')} strategy - The chosen execution path.
 * @property {string}  reason   - One of {@link DECISION_REASON}.
 * @property {boolean} forced   - True when an explicit override drove the choice.
 * @property {object}  capability - The {@link CapabilityResult} that informed it.
 */

/**
 * Select the audit execution strategy for `audit-clean-code` from a capability
 * snapshot and an optional explicit force-override.
 *
 * Decision order:
 *   1. `forceStrategy === 'orchestrated'` → orchestrated (forced). Used to
 *      pin the dynamic path for testing even if detection is conservative;
 *      the runtime still refuses the launch if genuinely unentitled.
 *   2. `forceStrategy === 'sequential'` → sequential (forced). Used to verify
 *      the fallback path (Acceptance: "running the lens with the feature
 *      disabled") without mutating the real environment.
 *   3. Capability available → orchestrated.
 *   4. Otherwise → sequential (graceful degradation).
 *
 * Pure function — no I/O, no side effects.
 *
 * @param {object} input
 * @param {CapabilitySnapshot} [input.snapshot]      - Environment facts.
 * @param {('orchestrated'|'sequential'|null|undefined)} [input.forceStrategy] - Explicit override.
 * @returns {StrategyDecision}
 */
export function selectAuditStrategy({ snapshot = {}, forceStrategy } = {}) {
  const capability = detectDynamicWorkflowCapability(snapshot);

  const normalizedForce =
    typeof forceStrategy === 'string'
      ? forceStrategy.trim().toLowerCase()
      : null;

  if (normalizedForce === AUDIT_STRATEGY.ORCHESTRATED) {
    return {
      strategy: AUDIT_STRATEGY.ORCHESTRATED,
      reason: DECISION_REASON.FORCED_ORCHESTRATED,
      forced: true,
      capability,
    };
  }
  if (normalizedForce === AUDIT_STRATEGY.SEQUENTIAL) {
    return {
      strategy: AUDIT_STRATEGY.SEQUENTIAL,
      reason: DECISION_REASON.FORCED_SEQUENTIAL,
      forced: true,
      capability,
    };
  }

  if (capability.available) {
    return {
      strategy: AUDIT_STRATEGY.ORCHESTRATED,
      reason: capability.reason,
      forced: false,
      capability,
    };
  }

  return {
    strategy: AUDIT_STRATEGY.SEQUENTIAL,
    reason: capability.reason,
    forced: false,
    capability,
  };
}

/**
 * Build a {@link CapabilitySnapshot} from a raw environment bag (typically
 * `process.env`) plus a resolved `disableWorkflows` settings value. Kept
 * separate from `process.env` access so it stays testable; the caller decides
 * where the env comes from.
 *
 * @param {Record<string,string|undefined>} env
 * @param {{ disableWorkflows?: boolean }} [settings]
 * @returns {CapabilitySnapshot}
 */
export function snapshotFromEnv(env = {}, settings = {}) {
  return {
    runtime: env[ENV_KEYS.RUNTIME],
    version: env[ENV_KEYS.VERSION],
    plan: env[ENV_KEYS.PLAN],
    disableWorkflowsSetting: settings.disableWorkflows === true,
    disableWorkflowsEnv: env[ENV_KEYS.DISABLE],
  };
}

/**
 * Read the operator/test force-override from a raw environment bag. Returns
 * `'orchestrated'` / `'sequential'` when the value is a recognised strategy,
 * else `null`.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {('orchestrated'|'sequential'|null)}
 */
export function forceStrategyFromEnv(env = {}) {
  const raw = env[ENV_KEYS.FORCE_STRATEGY];
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === AUDIT_STRATEGY.ORCHESTRATED || v === AUDIT_STRATEGY.SEQUENTIAL) {
    return v;
  }
  return null;
}
