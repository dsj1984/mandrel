/**
 * `github.*` accessor. `branchProtection.requiredChecks` is the SSOT
 * `/agents-bootstrap-github` registers as required-status checks.
 */

/** Keep in sync with the job names in `.github/workflows/ci.yml`. */
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
    'state-transition',
    'story-merged',
    'story-closing',
    'operator-message',
    'merge.unlanded',
    'merge.flip-failed',
  ]),
});

/**
 * Shallow overlay; `requiredChecks` is replaced wholesale when present.
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
