/**
 * `mandrel explain`: each config key's effective value, source (`agentrc`
 * incl. local overlay, or `default`) and one-line meaning. Secret-shaped keys
 * report their source only; the value is redacted to `null`.
 */

import { resolveConfig } from '../config-resolver.js';
import {
  getAgentrcDefaults,
  iterDefaultLeaves,
  lookupPath,
} from './defaults.js';

/**
 * Forward defence: no key matches today.
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
 * Exact glosses; misses fall back to the longest prefix, then the block.
 *
 * @type {Readonly<Record<string, string>>}
 */
const KEY_MEANINGS = Object.freeze({
  // project.*
  'project.baseBranch':
    'Default base branch Stories branch from and merge back into.',
  'project.paths.agentRoot':
    'Directory holding the distributed agent bundle (instructions, skills, scripts).',
  'project.paths.docsRoot':
    'Directory the mandatory docs-context reads resolve against.',
  'project.paths.tempRoot':
    'Root for gitignored scratch output (per-run state, mirrors, logs).',
  'project.docsContextFiles':
    'Authoritative files an agent must read before starting any task.',
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
  'planning.navigation.routeGlobs':
    'Glob patterns marking paths that add a user-facing route (plan-time reachability gate).',
  'planning.navigation.navRegistry':
    'Tokens identifying the nav-registry SSOT a route-adding Story is expected to reference.',

  // delivery.*
  'delivery.ci.autoMerge':
    'Merge posture: trust-ci merges on green checks; strict also requires a clean review gate.',
  'delivery.docsFreshness.paths':
    'Docs the audit-documentation lens folds into its target set.',
  'delivery.deliverRunner.concurrencyCap':
    'Maximum Stories dispatched in parallel within one wave. Default 3 — conservative by design to keep host-quota consumption predictable. Operators running wide waves with adequate parallel-agent quota should raise this to reduce wall-clock time proportionally.',
  'delivery.worktreeIsolation.enabled':
    'Whether each Story runs in its own git worktree.',
  'delivery.worktreeIsolation.root':
    'Directory under which per-Story worktrees are created.',
  'delivery.worktreeIsolation.nodeModulesStrategy':
    'How node_modules is provisioned per worktree (default clone on darwin/linux; per-worktree on win32).',
  'delivery.worktreeIsolation.primeFromPath':
    'Source path a worktree primes its node_modules from.',
  'delivery.worktreeIsolation.allowSymlinkOnWindows':
    'Whether symlink node_modules strategy is allowed on Windows.',
  'delivery.worktreeIsolation.reapOnSuccess':
    'Whether a worktree is removed after a Story closes cleanly.',
  'delivery.worktreeIsolation.bootstrapFiles':
    'Files copied into each new worktree (e.g. .env, .mcp.json, local overrides).',
  'delivery.mergeWatch.maxBudgetSeconds':
    'Cumulative wall-clock budget (seconds) across resumes before the merge wait gives up and blocks.',
  'delivery.codeReview.providers':
    'Ordered provider chain the code-review phase consults.',
  'delivery.codeReview.autoFixSeverity':
    'Severity threshold for on-branch code-review remediation (medium fixes 🔴/🟠/🟡, high fixes 🔴/🟠 only; default medium).',
  'delivery.routing.roleScopedAgents':
    'Whether delivery spawns boot on role-scoped .claude/agents/<role>.md contexts.',
  'delivery.routing.ceremonyProfile':
    'Who authors the Story acceptance verdict: minimal and standard = the inline self-eval, strict = a fresh maker-blind critic.',
  'delivery.routing.closeAndLand':
    'When true, single-story-close lands through merge in one close (opt out with --no-wait-merge).',
  'delivery.feedbackLoop.retroProposals':
    'When true, auto-file actionable retro proposals as follow-up issues.',
  'delivery.quality.requireBaselines':
    'When true, absent baseline artifacts fail close-validation instead of skipping cleanly.',
  'delivery.quality.navigability.routeGlobs':
    'Glob patterns marking user-facing routes for the navigability lens / journey gate.',
  'delivery.quality.navigability.navRegistry':
    'Tokens identifying the nav-registry SSOT the navigability lens expects.',
  'delivery.quality.navigability.journeySuite':
    'Optional journey-suite path the post-wave navigability integration gate runs.',
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
 * @type {ReadonlyArray<[string, string]>}
 */
const PREFIX_MEANINGS = Object.freeze([
  [
    'delivery.quality.gates',
    'Quality-gate threshold/configuration for the delivery close gate.',
  ],
  [
    'delivery.quality.autoRefresh',
    'Auto-refresh policy for ratcheted baselines.',
  ],
  ['delivery.quality', 'Delivery-time quality configuration.'],
  ['delivery.mergeWatch', 'Merge-wait posture and wall-clock budget.'],
  [
    'delivery.feedbackLoop',
    'Opt-out toggles for auto-filing non-blocking findings.',
  ],
  [
    'delivery.routing',
    'Delivery-spawn routing and acceptance-ceremony profile.',
  ],
  ['delivery.ci', 'CI-aware delivery namespace (auto-merge, advisory checks).'],
  [
    'planning.navigation',
    'Plan-time navigability reachability gate (route globs + nav registry).',
  ],
  [
    'qa.environments',
    'QA harness deployment target (baseUrl, per-environment sign-in seam, allowWrites gate).',
  ],
  ['qa.personas', 'QA harness persona / credential mapping.'],
  [
    'qa.gherkinLint',
    'Static Gherkin corpus gate: per-scope feature/step roots plus the exemption-tag and step-waiver escapes.',
  ],
]);

/**
 * @type {Readonly<Record<string, string>>}
 */
const BLOCK_MEANINGS = Object.freeze({
  project: 'Project identity, paths, and command configuration.',
  github: 'GitHub provider identity and merge/notification policy.',
  planning: 'Inputs and guardrails for /mandrel-plan.',
  delivery: 'Execution, isolation, quality, and CI settings for delivery.',
  qa: 'Agent-driven QA harness contract.',
});

/**
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
 * @param {string} dottedPath
 * @returns {string}
 */
export function meaningFor(dottedPath) {
  if (Object.hasOwn(KEY_MEANINGS, dottedPath)) {
    return KEY_MEANINGS[dottedPath];
  }
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
 * @param {string} dottedPath
 * @param {object|null} rawAgentrc — merged agentrc + local overlay.
 * @param {unknown} defaultValue
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
 * @param {{ cwd?: string }} [opts]
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
