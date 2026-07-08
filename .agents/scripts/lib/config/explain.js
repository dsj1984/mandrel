/**
 * Config-explain capability (Story #3523, Epic #3438).
 *
 * `explainConfig()` answers the operator question "what does each resolved
 * config key mean, what is its effective value, and where did that value
 * come from?". It pairs with the unified config resolver: the resolver
 * decides the *effective* value, this module attributes that value to a
 * *source* layer and pins a one-line *meaning* to every key.
 *
 * Source attribution is two-valued (Story #3690 removed the named
 * config-profile layer):
 *   - `agentrc`  — the key is present in the project's resolved `.agentrc.json`
 *                  (including any `.agentrc.local.json` overlay). The operator
 *                  set it.
 *   - `default`  — the project does not carry the key; the framework default
 *                  from `.agents/docs/agentrc-reference.json` applies.
 *
 * Secret hygiene: no key in the `.agentrc.json` surface is a credential today,
 * but the report is defensive — any key whose dotted path matches a
 * secret-shaped token (`token`, `secret`, `password`, `apiKey`, `credential`,
 * …) has its value redacted to `null` and is flagged `redacted: true`. Only
 * the *source* of a secret is ever reported, never the value.
 */

import { resolveConfig } from '../config-resolver.js';
import {
  getAgentrcDefaults,
  iterDefaultLeaves,
  lookupPath,
} from './defaults.js';

/**
 * Dotted-path segment patterns that mark a key as secret-bearing. Matched
 * case-insensitively against any segment of the dotted path. The
 * `.agentrc.json` schema carries none of these today; the guard is forward
 * defence so a future credential-shaped key never leaks its value through
 * `mandrel explain`.
 *
 * @type {readonly RegExp[]}
 */
const SECRET_SEGMENT_PATTERNS = Object.freeze([
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /credential/i,
  /apikey/i,
  /api[-_]?key/i,
  /(^|[^a-z])key$/i,
  /private/i,
]);

/**
 * Curated one-line meanings keyed by dotted config path. Wildcard floor
 * paths (`...floors.*`) are covered by the prefix fallbacks below, so this
 * map pins the operator-facing keys that benefit from a bespoke gloss. Any
 * key without an exact entry falls back to the longest matching prefix gloss,
 * then to a top-level block gloss, so every key always reports a non-empty
 * meaning.
 *
 * @type {Readonly<Record<string, string>>}
 */
const KEY_MEANINGS = Object.freeze({
  // project.*
  'project.baseBranch':
    'Default base branch Epics and Stories branch from and merge back into.',
  'project.paths.agentRoot':
    'Directory holding the distributed agent bundle (instructions, skills, scripts).',
  'project.paths.docsRoot':
    'Directory the mandatory docs-context reads resolve against.',
  'project.paths.tempRoot':
    'Root for gitignored scratch output (per-Epic run state, mirrors, logs).',
  'project.docsContextFiles':
    'Authoritative files an agent must read before starting any task.',
  'project.commands.lintBaseline':
    'Lint command the close-validation chain runs.',
  'project.commands.test': 'Test command the close-validation chain runs.',
  'project.commands.typecheck':
    'Typecheck command (null disables the typecheck gate).',
  'project.commands.formatCheck':
    'Format-verify command run without modifying files.',
  'project.commands.formatWrite':
    'Format-write command that applies formatting in place.',

  // github.*
  'github.owner': 'GitHub owner/org the repo lives under.',
  'github.repo': 'GitHub repository name for ticket and PR operations.',
  'github.projectNumber':
    'GitHub Projects (v2) board number tickets are added to.',
  'github.projectOwner': 'Owner of the GitHub Projects board.',
  'github.operatorHandle':
    'GitHub @handle mentioned when a run needs operator attention.',
  'github.branchProtection.enforce':
    'Whether the framework applies branch-protection rules.',
  'github.branchProtection.requiredChecks':
    'Status checks that must pass before a PR can merge.',
  'github.mergeMethods.allow_squash_merge':
    'Whether squash-merge is permitted on PRs.',
  'github.mergeMethods.allow_rebase_merge':
    'Whether rebase-merge is permitted on PRs.',
  'github.mergeMethods.allow_merge_commit':
    'Whether merge-commit merges are permitted on PRs.',
  'github.mergeMethods.allow_auto_merge':
    'Whether GitHub auto-merge is enabled for the repo.',
  'github.mergeMethods.delete_branch_on_merge':
    'Whether head branches are deleted after merge.',
  'github.notifications.mentionOperator':
    'Whether notifications @-mention the operator handle.',
  'github.notifications.commentEvents':
    'Allowlist of events that post a GitHub comment notification.',
  'github.notifications.webhookEvents':
    'Allowlist of events that fire a webhook notification.',

  // planning.*
  'planning.context.maxBytes':
    'Byte budget for the planning-context payload before summary mode kicks in.',
  'planning.context.summaryMode':
    'When the planner switches to a summarized context representation.',
  'planning.codebaseSnapshot.tier':
    'Depth of the structural codebase view threaded into spec authoring.',
  'planning.codebaseSnapshot.include':
    'Glob patterns included in the codebase snapshot.',
  'planning.codebaseSnapshot.exclude':
    'Glob patterns excluded from the codebase snapshot.',
  'planning.codebaseSnapshot.recentCommitWindow':
    'How many recent commits the snapshot summarizes.',
  'planning.riskHeuristics':
    'Phrases that flag a Story as high-risk for HITL escalation.',
  'planning.taskSizing.softAcceptanceCount':
    'Acceptance-criteria count above which a Story is flagged as large (advisory-only — there is no hard acceptance ceiling).',
  'planning.taskSizing.softFiles':
    'Touched-file count above which a Story is flagged as large.',
  'planning.taskSizing.hardFiles':
    'Touched-file count above which a Story is rejected unless it declares `wide` with a reason.',
  'planning.failOnSharedEditors':
    'Whether shared-editor conflict findings are promoted to hard errors.',
  'planning.requireExplicitCrossStoryDeps':
    'Whether implicit cross-Story dependencies are promoted to hard errors.',

  // delivery.*
  'delivery.execution.timeoutMs':
    'Per-execution timeout for orchestrated delivery steps.',
  'delivery.maxTokenBudget':
    'Cap on the hydrated task-prompt size handed to an agent.',
  'delivery.lease.ttlMs':
    'Time-to-live for the Epic lease before a stale claim is reclaimable.',
  'delivery.ci.skipForStoryPushes':
    'Whether Story-branch pushes carry a [skip ci] trailer.',
  'delivery.ci.earlyPr':
    'Whether /deliver opens the Epic PR early so CI warms during later waves.',
  'delivery.ci.watch.pollIntervalMs':
    'Poll cadence (ms) for the merge/CI watch loop.',
  'delivery.ci.watch.maxPolls':
    'Maximum number of poll probes before the CI watch gives up.',
  'delivery.ci.watch.maxResumes':
    'Maximum times the CI watch may resume after a transient stall.',
  'delivery.ci.autoMerge':
    'Merge posture: trust-ci merges on green checks; strict also requires a clean review gate.',
  'delivery.preflight.maxStories':
    'Pre-dispatch ceiling on estimated Story count (no cap when unset).',
  'delivery.preflight.maxWaves':
    'Pre-dispatch ceiling on estimated wave count.',
  'delivery.preflight.maxInstallCostSeconds':
    'Pre-dispatch ceiling on estimated dependency-install seconds.',
  'delivery.preflight.maxGithubApiRequests':
    'Pre-dispatch ceiling on estimated GitHub API request volume.',
  'delivery.preflight.maxClaudeQuotaTokens':
    'Pre-dispatch ceiling on estimated Claude quota-token burn.',
  'delivery.docsFreshness.paths':
    'Docs whose freshness is checked at delivery time.',
  'delivery.deliverRunner.concurrencyCap':
    'Maximum Stories dispatched in parallel within one wave. Default 3 — conservative by design to keep host-quota consumption predictable. Operators running wide-wave Epics with adequate parallel-agent quota should raise this to reduce wall-clock time proportionally.',
  'delivery.deliverRunner.progressReportIntervalSec':
    'Cadence for delivery progress reporting.',
  'delivery.deliverRunner.verifyConcurrencyCap':
    'Maximum verify steps run in parallel.',
  'delivery.worktreeIsolation.enabled':
    'Whether each Story runs in its own git worktree.',
  'delivery.worktreeIsolation.root':
    'Directory under which per-Story worktrees are created.',
  'delivery.worktreeIsolation.nodeModulesStrategy':
    'How node_modules is provisioned per worktree.',
  'delivery.worktreeIsolation.primeFromPath':
    'Source path a worktree primes its node_modules from.',
  'delivery.worktreeIsolation.allowSymlinkOnWindows':
    'Whether symlink node_modules strategy is allowed on Windows.',
  'delivery.worktreeIsolation.reapOnSuccess':
    'Whether a worktree is removed after a Story closes cleanly.',
  'delivery.worktreeIsolation.reapOnCancel':
    'Whether a worktree is removed after a cancelled run.',
  'delivery.worktreeIsolation.bootstrapFiles':
    'Files copied into each new worktree (e.g. .env, .mcp.json).',
  'delivery.codeReview.providers':
    'Ordered provider chain the code-review phase consults.',
  'delivery.codeReview.maxFixAttempts':
    'Maximum auto-fix attempts the code-review phase makes.',
  'delivery.codeReview.maxFixScopeFiles':
    'Maximum files an auto-fix may touch in one attempt.',
  'delivery.codeReview.autoFixSeverity':
    'Severity threshold for on-branch code-review remediation (medium fixes 🔴/🟠/🟡, high fixes 🔴/🟠 only; default medium).',
  'delivery.epicAudit.autoFixSeverity':
    'Severity threshold for on-branch epic-audit remediation (medium fixes 🔴/🟠/🟡, high fixes 🔴/🟠 only; default medium).',
  'delivery.refactorStage.enabled':
    'Whether a dedicated refactor stage runs during delivery.',
  'delivery.acceptanceEval.maxRounds':
    'Redraft rounds the per-Story acceptance self-eval loop runs before escalating to agent::blocked (default 2; clamped to a hard ceiling that cannot be disabled).',

  // qa.*
  'qa.featureRoot': 'Root directory holding the QA harness .feature files.',
  'qa.fixturesManifest': 'Path to the QA fixtures manifest.',
  'qa.consoleAllowlist': 'Console-message patterns the QA harness tolerates.',
  'qa.designTokens': 'Path to the design-token source the QA harness checks.',
});

/**
 * Prefix-keyed fallback glosses. Used when a key has no exact entry in
 * `KEY_MEANINGS` (notably wildcard floor paths and per-gate sub-keys). The
 * longest matching prefix wins.
 *
 * @type {ReadonlyArray<[string, string]>}
 */
const PREFIX_MEANINGS = Object.freeze([
  [
    'delivery.quality.gates',
    'Quality-gate threshold/configuration for the delivery close gate.',
  ],
  [
    'delivery.quality.codingGuardrails',
    'Per-commit coding-guardrail threshold.',
  ],
  [
    'delivery.quality.autoRefresh',
    'Auto-refresh policy for ratcheted baselines.',
  ],
  [
    'delivery.quality.baselineEpsilon',
    'Tolerance epsilon applied when comparing a quality baseline.',
  ],
  ['delivery.quality', 'Delivery-time quality configuration.'],
  ['delivery.signals', 'Threshold for a delivery friction/telemetry signal.'],
  ['delivery.lifecycle.timeouts', 'Timeout for a lifecycle-bus phase.'],
  ['delivery.lifecycle', 'Lifecycle-bus configuration.'],
  [
    'planning.taskSizing',
    'Story-sizing threshold for the decompose validator.',
  ],
  [
    'qa.environments',
    'QA harness deployment target (baseUrl, per-environment sign-in seam, allowWrites gate).',
  ],
  ['qa.personas', 'QA harness persona / credential mapping.'],
]);

/**
 * Block-level fallback glosses by top-level prefix. Guarantees every key gets
 * a non-empty meaning even if neither the exact map nor a prefix gloss matches.
 *
 * @type {Readonly<Record<string, string>>}
 */
const BLOCK_MEANINGS = Object.freeze({
  project: 'Project identity, paths, and command configuration.',
  github: 'GitHub provider identity and merge/notification policy.',
  planning: 'Inputs and guardrails for /epic-plan.',
  delivery:
    'Execution, isolation, quality, and lifecycle settings for delivery.',
  qa: 'Agent-driven QA harness contract.',
});

/**
 * Is `dottedPath` a secret-bearing key whose value must be redacted?
 *
 * @param {string} dottedPath
 * @returns {boolean}
 */
export function isSecretKey(dottedPath) {
  return dottedPath
    .split('.')
    .some((segment) =>
      SECRET_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment)),
    );
}

/**
 * Resolve the one-line meaning for a dotted config key.
 *
 * @param {string} dottedPath
 * @returns {string}
 */
export function meaningFor(dottedPath) {
  if (Object.hasOwn(KEY_MEANINGS, dottedPath)) {
    return KEY_MEANINGS[dottedPath];
  }
  // Longest matching prefix wins.
  let best = null;
  for (const [prefix, gloss] of PREFIX_MEANINGS) {
    if (
      (dottedPath === prefix || dottedPath.startsWith(`${prefix}.`)) &&
      (best === null || prefix.length > best[0].length)
    ) {
      best = [prefix, gloss];
    }
  }
  if (best) return best[1];

  const block = dottedPath.split('.')[0];
  return BLOCK_MEANINGS[block] ?? 'Configuration key.';
}

/**
 * Attribute a key's effective value to a source layer and capture the value
 * the resolver actually applies.
 *
 * @param {string} dottedPath
 * @param {object|null} rawAgentrc  The resolver's `raw` (merged agentrc+local), or null.
 * @param {unknown} defaultValue    The framework default for this key.
 * @returns {{ source: 'agentrc'|'default', value: unknown }}
 */
function attribute(dottedPath, rawAgentrc, defaultValue) {
  const inAgentrc = lookupPath(rawAgentrc, dottedPath);
  if (inAgentrc.present) {
    return { source: 'agentrc', value: inAgentrc.value };
  }
  return { source: 'default', value: defaultValue };
}

/**
 * Build the config-explain report: one entry per known config key, each
 * carrying its effective value, source layer, and one-line meaning.
 *
 * @param {{ cwd?: string }} [opts]
 *   - `cwd`: project root whose `.agentrc.json` is resolved (default: the
 *     framework root via `resolveConfig`).
 * @returns {Array<{
 *   key: string,
 *   value: unknown,
 *   source: 'agentrc'|'default',
 *   meaning: string,
 *   redacted: boolean,
 * }>}
 */
export function explainConfig(opts = {}) {
  const { cwd } = opts;

  const resolved = resolveConfig(cwd ? { cwd } : undefined);
  const rawAgentrc = resolved.raw ?? null;
  const defaults = getAgentrcDefaults();

  const report = [];
  for (const [key, defaultValue] of iterDefaultLeaves(defaults)) {
    const { source, value } = attribute(key, rawAgentrc, defaultValue);
    const redacted = isSecretKey(key);
    report.push({
      key,
      value: redacted ? null : value,
      source,
      meaning: meaningFor(key),
      redacted,
    });
  }
  return report;
}
