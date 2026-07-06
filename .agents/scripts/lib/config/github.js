/**
 * `github.*` accessor (Epic #1720 Story #1739 — top-level reshape).
 *
 * GitHub identity, branch protection, merge methods, and notifications all
 * live under the top-level `github` block post-reshape.
 *
 * `branchProtection.requiredChecks` is the single source of truth that
 * drives both:
 *
 *   - `/agents-bootstrap-github` — registers GitHub required-status checks.
 *   - `/git-merge-pr` → `git-pr-quality-gate.js` — runs each check locally
 *     before merge.
 */

/**
 * Default required-check suite. Mirrors the live CI required-check set
 * (`lint` + `test` + `baselines`); consumers override via
 * `github.branchProtection.requiredChecks` in `.agentrc.json`. Kept in sync
 * with `DEFAULT_CHECKS` in `git-pr-quality-gate.js` and the CI job names in
 * `.github/workflows/ci.yml` — the retired `format:check` folded into `lint`
 * (Story #1829) and `lifecycle-doc-drift` collapsed into `lint`/`docs:check`
 * (Epic #1943), so neither belongs in the default set.
 */
export const DEFAULT_REQUIRED_CHECKS = Object.freeze([
  Object.freeze({
    name: 'lint',
    cmd: Object.freeze(['npm', 'run', 'lint']),
  }),
  Object.freeze({
    name: 'test',
    cmd: Object.freeze(['npm', 'test']),
  }),
  Object.freeze({
    name: 'baselines',
    cmd: Object.freeze(['node', '.agents/scripts/check-baselines.js']),
  }),
]);

export const BRANCH_PROTECTION_DEFAULTS = Object.freeze({
  enforce: true,
  requiredChecks: DEFAULT_REQUIRED_CHECKS,
});

export const MERGE_METHODS_DEFAULTS = Object.freeze({
  allow_squash_merge: true,
  allow_rebase_merge: false,
  allow_merge_commit: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
});

export const NOTIFICATIONS_DEFAULTS = Object.freeze({
  mentionOperator: false,
  commentEvents: Object.freeze([
    'state-transition',
    'story-merged',
    'operator-message',
  ]),
  webhookEvents: Object.freeze([
    'epic-started',
    'epic-progress',
    'epic-blocked',
    'epic-unblocked',
    'epic-complete',
  ]),
});

/**
 * Read the merged `github.*` block. Accepts the full resolved config or
 * the bare github bag. Operator-supplied keys shallow-overlay framework
 * defaults; the required-checks list is replaced wholesale when present
 * (no extender semantics).
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   owner: string|null,
 *   repo: string|null,
 *   projectNumber: number|null,
 *   projectOwner: string|null,
 *   operatorHandle: string|null,
 *   branchProtection: { enforce: boolean, requiredChecks: Array<{name:string,cmd:readonly string[]}> },
 *   mergeMethods: typeof MERGE_METHODS_DEFAULTS,
 *   notifications: typeof NOTIFICATIONS_DEFAULTS,
 * }}
 */
export function getGitHub(config) {
  const gh = config?.github ?? config ?? {};
  const userBranchProtection =
    gh.branchProtection && typeof gh.branchProtection === 'object'
      ? gh.branchProtection
      : {};
  const userMergeMethods =
    gh.mergeMethods && typeof gh.mergeMethods === 'object'
      ? gh.mergeMethods
      : {};
  const userNotifications = gh.notifications ?? {};
  return {
    owner: gh.owner ?? null,
    repo: gh.repo ?? null,
    projectNumber: gh.projectNumber ?? null,
    projectOwner: gh.projectOwner ?? null,
    operatorHandle: gh.operatorHandle ?? null,
    branchProtection: {
      enforce:
        typeof userBranchProtection.enforce === 'boolean'
          ? userBranchProtection.enforce
          : BRANCH_PROTECTION_DEFAULTS.enforce,
      requiredChecks: Array.isArray(userBranchProtection.requiredChecks)
        ? userBranchProtection.requiredChecks
        : [...DEFAULT_REQUIRED_CHECKS],
    },
    mergeMethods: { ...MERGE_METHODS_DEFAULTS, ...userMergeMethods },
    notifications: {
      mentionOperator:
        typeof userNotifications.mentionOperator === 'boolean'
          ? userNotifications.mentionOperator
          : NOTIFICATIONS_DEFAULTS.mentionOperator,
      commentEvents: Array.isArray(userNotifications.commentEvents)
        ? userNotifications.commentEvents
        : [...NOTIFICATIONS_DEFAULTS.commentEvents],
      webhookEvents: Array.isArray(userNotifications.webhookEvents)
        ? userNotifications.webhookEvents
        : [...NOTIFICATIONS_DEFAULTS.webhookEvents],
    },
  };
}
