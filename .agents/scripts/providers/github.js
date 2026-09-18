/**
 * GitHub Provider — composition root. The constructor wires gateways via
 * `composeGateways()`; the `DELEGATIONS` table installs the
 * ITicketingProvider surface as one-line forwards to them. Only the error
 * classifiers are re-exported; import anything else from `./github/<sub>.js`.
 */

import { createGh } from '../lib/gh-exec.js';
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

/**
 * Per-`gh`-subprocess ceiling so a stalled socket can't hang orchestration;
 * the resulting `GhExecTimeoutError` classifies as transient and is retried.
 */
const GH_DEFAULT_TIMEOUT_MS = 60_000;

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
    // An injected `opts.gh` is honored as-is (test seam).
    this._gh =
      opts.gh ?? createGh(undefined, { timeoutMs: GH_DEFAULT_TIMEOUT_MS });
    this._cache = createInlineTicketCache();
    composeGateways(this);
  }

  get token() {
    if (this._memoizedToken) return this._memoizedToken;
    this._memoizedToken = resolveToken();
    return this._memoizedToken;
  }

  /**
   * What `blocked-by-add.js` needs for the dependencies REST API, lent
   * explicitly so orchestration callers never reach into `provider._gh`.
   *
   * @returns {{ gh: object, owner: string, repo: string }}
   */
  getDependencyWriteContext() {
    return { gh: this._gh, owner: this.owner, repo: this.repo };
  }

  static isInsufficientScopes(err) {
    return projects.isInsufficientScopes(err);
  }
}

/** `[publicMethod, 'gateway.method']` → async prototype forwarder. */
const DELEGATIONS = [
  ['graphql', 'issues.ghGraphql'],
  ['searchIssues', 'issues.searchIssues'],
  ['listIssuesByLabel', 'issues.listIssuesByLabel'],
  ['listTicketsByLabel', 'issues.listTicketsByLabel'],
  ['getParentIssue', 'issues.getParentIssue'],
  ['getEpic', 'issues.getEpic'],
  ['branchExists', 'issues.branchExists'],
  ['getSubTickets', 'issues.getSubTickets'],
  ['_getReferencedChildren', 'issues._getReferencedChildren'],
  ['getTickets', 'tickets.getTickets'],
  ['getTicket', 'tickets.getTicket'],
  ['getTicketDependencies', 'tickets.getTicketDependencies'],
  ['createIssue', 'tickets.createIssue'],
  ['updateTicket', 'tickets.updateTicket'],
  ['_applyLabelMutations', 'tickets._applyLabelMutations'],
  ['getNativeSubIssues', 'subIssues.getNativeSubIssues'],
  // Legacy private alias with live call sites; same target, so both agree.
  ['_getNativeSubIssues', 'subIssues.getNativeSubIssues'],
  ['getTicketComments', 'comments.getTicketComments'],
  ['deleteComment', 'comments.deleteComment'],
  ['postComment', 'comments.postComment'],
  ['getBranchProtection', 'branchProtection.getBranchProtection'],
  ['setBranchProtection', 'branchProtection.setBranchProtection'],
  ['ensureLabels', 'labels.ensureLabels'],
  ['listLabels', 'labels.listLabels'],
  ['deleteLabel', 'labels.deleteLabel'],
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
