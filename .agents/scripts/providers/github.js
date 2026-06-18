/**
 * GitHub Provider — composition root (thin composer).
 *
 * Story #2462 (Epic #2453) split this class into nine sibling modules under
 * `./github/`. This file now does two things only:
 *
 *   1. **Holds the constructor** that captures config + opts + the gh-exec
 *      facade, then delegates gateway wiring to `composeGateways()` in
 *      `./github/compose.js`.
 *   2. **Installs the ITicketingProvider surface** as one-line delegating
 *      methods sourced from the `DELEGATIONS` table below — every public
 *      method forwards verbatim to a concrete gateway.
 *
 * Re-exports: only the five error-classification helpers still used by tests
 * that import through this barrel (classifyGithubError et al.). All other
 * symbols (mappers, auth helpers, sub-issue constants) are dead exports per
 * baselines/dead-exports.json and were removed in Story #3650 (Epic #3599).
 * Callers should import those symbols directly from their ./github/<sub>.js
 * module.
 *
 * Gateway map: tickets, sub-issues, comments, labels, branch-protection,
 * merge-methods, prs, project-board, issues (epics + sub-tickets +
 * branch probe + raw GraphQL).
 */

import { createGh, gh as defaultGh } from '../lib/gh-exec.js';
import { ITicketingProvider } from '../lib/ITicketingProvider.js';
import { resolveToken } from './github/auth.js';
import { createInlineTicketCache } from './github/cache.js';
import { composeGateways } from './github/compose.js';
import {
  classifyGithubError,
  extractErrorFields,
  isPermissionSignal,
  isTransientByCodeOrMessage,
  isTransientStatus,
} from './github/errors.js';
import * as projects from './github/projects-v2-graphql.js';

export {
  classifyGithubError,
  extractErrorFields,
  isPermissionSignal,
  isTransientByCodeOrMessage,
  isTransientStatus,
};

export class GitHubProvider extends ITicketingProvider {
  constructor(config, opts = {}) {
    super();
    this.owner = config.owner;
    this.repo = config.repo;
    this.projectNumber = config.projectNumber ?? null;
    this.projectOwner = config.projectOwner ?? config.owner;
    this.projectName = config.projectName ?? null;
    this.operatorHandle = config.operatorHandle ?? null;
    this._explicitToken = opts.token ?? null;
    this._memoizedToken = opts.token ?? null;
    // Resolve the gh-exec default timeout (Story #2860). When the operator
    // sets `github.defaultTimeoutMs` in `.agentrc.json`, every `gh`
    // subprocess this provider spawns inherits that timeout ceiling. An
    // injected `opts.gh` is honored as-is so tests can drive the facade
    // without going through this fallback. Unset → 60_000 ms in code.
    if (opts.gh) {
      this._gh = opts.gh;
    } else {
      const defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000;
      this._gh =
        defaultTimeoutMs > 0
          ? createGh(undefined, { timeoutMs: defaultTimeoutMs })
          : defaultGh;
    }
    this._cache = createInlineTicketCache();
    composeGateways(this);
  }

  get token() {
    if (this._memoizedToken) return this._memoizedToken;
    this._memoizedToken = resolveToken();
    return this._memoizedToken;
  }

  /* node:coverage ignore next */
  async listIssues(filters = {}) {
    return this.getEpics(filters);
  }

  static isInsufficientScopes(err) {
    return projects.isInsufficientScopes(err);
  }
}

/**
 * Delegation table. Each `[publicMethod, 'gatewayName.gatewayMethod']` pair
 * installs an async wrapper on `GitHubProvider.prototype` that forwards
 * every argument to the matching gateway method. This keeps the parity
 * surface explicit and the file under the thin-composer LOC ceiling.
 */
const DELEGATIONS = [
  ['graphql', 'issues.ghGraphql'],
  ['searchIssues', 'issues.searchIssues'],
  ['listIssuesByLabel', 'issues.listIssuesByLabel'],
  ['getEpics', 'issues.getEpics'],
  ['getEpic', 'issues.getEpic'],
  ['branchExists', 'issues.branchExists'],
  ['getSubTickets', 'issues.getSubTickets'],
  ['_getReferencedChildren', 'issues._getReferencedChildren'],
  ['getTickets', 'tickets.getTickets'],
  ['getTicket', 'tickets.getTicket'],
  ['getTicketDependencies', 'tickets.getTicketDependencies'],
  ['createTicket', 'tickets.createTicket'],
  ['createIssue', 'tickets.createIssue'],
  ['updateTicket', 'tickets.updateTicket'],
  ['_applyLabelMutations', 'tickets._applyLabelMutations'],
  ['_getNativeSubIssues', 'subIssues.getNativeSubIssues'],
  ['_getNativeParent', 'subIssues.getNativeParent'],
  ['addSubIssue', 'subIssues.addSubIssue'],
  ['removeSubIssue', 'subIssues.removeSubIssue'],
  ['reconcileSubIssueLinks', 'subIssues.reconcileSubIssueLinks'],
  ['getRecentComments', 'comments.getRecentComments'],
  ['getTicketComments', 'comments.getTicketComments'],
  ['deleteComment', 'comments.deleteComment'],
  ['postComment', 'comments.postComment'],
  ['getBranchProtection', 'branchProtection.getBranchProtection'],
  ['setBranchProtection', 'branchProtection.setBranchProtection'],
  ['createPullRequest', 'pullRequests.createPullRequest'],
  ['ensureLabels', 'labels.ensureLabels'],
  ['_reconcileLabelsPresence', 'labels._reconcileLabelsPresence'],
  ['getMergeMethods', 'mergeMethods.getMergeMethods'],
  ['setMergeMethods', 'mergeMethods.setMergeMethods'],
  ['resolveOrCreateProject', 'projectBoard.resolveOrCreateProject'],
  ['ensureStatusField', 'projectBoard.ensureStatusField'],
  ['ensureProjectFields', 'projectBoard.ensureProjectFields'],
];
for (const [name, target] of DELEGATIONS) {
  const [gw, method] = target.split('.');
  GitHubProvider.prototype[name] = async function (...args) {
    return this[gw][method](...args);
  };
}

// Synchronous (void-returning or non-promise) delegations.
GitHubProvider.prototype.primeTicketCache = function (t) {
  this.tickets.primeTicketCache(t);
};
GitHubProvider.prototype.invalidateTicket = function (id) {
  this.tickets.invalidateTicket(id);
};
GitHubProvider.prototype._normalizeLabelListResult = function (r) {
  return this.labels._normalizeLabelListResult(r);
};
GitHubProvider.prototype._getChecklistChildren = function (body) {
  return this.issues._getChecklistChildren(body);
};
GitHubProvider.prototype._updateLabels = function (id, mutations, hasOther) {
  return this._applyLabelMutations(id, mutations, hasOther);
};
