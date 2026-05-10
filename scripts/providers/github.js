/**
 * GitHub Provider — facade over `providers/github/*` submodules.
 *
 * Implements every ITicketingProvider method by delegating to a focused
 * submodule that operates on a shared `ctx` object. Submodules never import
 * each other; cross-cutting concerns (project-add on createTicket, getTicket
 * from createPullRequest) flow through `ctx.hooks` wired up here.
 *
 * Self-Contained Architecture: REST/GraphQL transport is built on raw
 * `fetch()` (Node 20+), no @octokit/* dependency.
 *
 * @see docs/v5-implementation-plan.md Sprint 1B; Tech Spec #775.
 */

import { ITicketingProvider } from '../lib/ITicketingProvider.js';
import { resolveToken } from './github/auth.js';
import * as branches from './github/branches.js';
import { createTicketCacheManager } from './github/cache-manager.js';
import * as comments from './github/comments.js';
import { GithubHttpClient } from './github/http.js';
import * as issues from './github/issues.js';
import * as labels from './github/labels.js';
import * as projects from './github/projects.js';

export { __setExecSyncForTests } from './github/auth.js';

export class GitHubProvider extends ITicketingProvider {
  /**
   * @param {{ owner: string, repo: string, projectNumber?: number|null, projectOwner?: string, projectName?: string|null, operatorHandle?: string }} config
   * @param {{ token?: string, http?: GithubHttpClient, fetchImpl?: typeof fetch }} [opts]
   */
  constructor(config, opts = {}) {
    super();
    this.owner = config.owner;
    this.repo = config.repo;
    this.projectNumber = config.projectNumber ?? null;
    this.projectOwner = config.projectOwner ?? config.owner;
    this.projectName = config.projectName ?? null;
    this.operatorHandle = config.operatorHandle ?? null;
    this._http =
      opts.http ??
      new GithubHttpClient({
        tokenProvider: () => opts.token ?? resolveToken(),
        fetchImpl: opts.fetchImpl,
      });

    // Per-instance ticket cache shared by dispatcher / reconciler / cascade.
    // Mutations (`updateTicket` / `postComment`) invalidate. List endpoints
    // (`getTickets`, `getSubTickets`) deliberately do NOT populate it.
    this._cache = createTicketCacheManager();

    // ctx is the shared object every submodule reads from. `projectNumber`
    // gets a live getter/setter so `resolveOrCreateProject` can mutate it on
    // demand; `http` / `cache` are live getters so tests that reassign
    // `provider._http` / `provider._cache` (e.g. fake-clock cache) see the
    // new instance.
    const provider = this;
    this._ctx = {
      owner: this.owner,
      repo: this.repo,
      projectOwner: this.projectOwner,
      projectName: this.projectName,
      operatorHandle: this.operatorHandle,
      get projectNumber() {
        return provider.projectNumber;
      },
      set projectNumber(v) {
        provider.projectNumber = v;
      },
      get http() {
        return provider._http;
      },
      get cache() {
        return provider._cache;
      },
      state: { projectId: null },
      hooks: {
        getTicket: (id, o) => issues.getTicket(this._ctx, id, o),
        addItemToProject: (nodeId) =>
          projects.addItemToProject(this._ctx, nodeId),
      },
    };
  }

  get token() {
    return this._http.token;
  }

  async graphql(query, variables = {}, opts = {}) {
    return this._http.graphql(query, variables, opts);
  }

  /* node:coverage ignore next */
  async listIssues(filters = {}) {
    return issues.listIssues(this._ctx, filters);
  }

  async listIssuesByLabel(opts) {
    return issues.listIssuesByLabel(this._ctx, opts);
  }

  /* node:coverage ignore next */
  async getEpics(filters = {}) {
    return issues.getEpics(this._ctx, filters);
  }

  async getEpic(epicId) {
    return issues.getEpic(this._ctx, epicId);
  }

  /* node:coverage ignore next */
  async getTickets(epicId, filters = {}) {
    return issues.getTickets(this._ctx, epicId, filters);
  }

  async getSubTickets(parentId) {
    return issues.getSubTickets(this._ctx, parentId);
  }

  async getTicket(ticketId, opts = {}) {
    return issues.getTicket(this._ctx, ticketId, opts);
  }

  primeTicketCache(tickets) {
    issues.primeTicketCache(this._ctx, tickets);
  }

  invalidateTicket(ticketId) {
    issues.invalidateTicket(this._ctx, ticketId);
  }

  /* node:coverage ignore next */
  async getTicketDependencies(ticketId) {
    return issues.getTicketDependencies(this._ctx, ticketId);
  }

  async getRecentComments(limit = 100) {
    return comments.getRecentComments(this._ctx, limit);
  }

  async getTicketComments(ticketId) {
    return comments.getTicketComments(this._ctx, ticketId);
  }

  /* node:coverage ignore next */
  async createTicket(parentId, ticketData) {
    return issues.createTicket(this._ctx, parentId, ticketData);
  }

  async addSubIssue(
    parentNumber,
    childNodeId,
    opts = { replaceParent: false },
  ) {
    return issues.addSubIssue(this._ctx, parentNumber, childNodeId, opts);
  }

  async removeSubIssue(parentNumber, subIssueNumber) {
    return issues.removeSubIssue(this._ctx, parentNumber, subIssueNumber);
  }

  async reconcileSubIssueLinks(epicId) {
    return issues.reconcileSubIssueLinks(this._ctx, epicId);
  }

  /* node:coverage ignore next */
  async updateTicket(ticketId, mutations) {
    return issues.updateTicket(this._ctx, ticketId, mutations);
  }

  async deleteComment(commentId) {
    return comments.deleteComment(this._ctx, commentId);
  }

  async postComment(ticketId, payload) {
    return comments.postComment(this._ctx, ticketId, payload);
  }

  /* node:coverage ignore next */
  async createPullRequest(branchName, ticketId, baseBranch = 'main') {
    return branches.createPullRequest(
      this._ctx,
      branchName,
      ticketId,
      baseBranch,
    );
  }

  async getBranchProtection(branch) {
    return branches.getBranchProtection(this._ctx, branch);
  }

  async setBranchProtection(branch, opts) {
    return branches.setBranchProtection(this._ctx, branch, opts);
  }

  async ensureLabels(labelDefs) {
    return labels.ensureLabels(this._ctx, labelDefs);
  }

  static isInsufficientScopes(err) {
    return projects.isInsufficientScopes(err);
  }

  async resolveOrCreateProject(opts = {}) {
    return projects.resolveOrCreateProject(this._ctx, opts);
  }

  async ensureStatusField(optionNames) {
    return projects.ensureStatusField(this._ctx, optionNames);
  }

  async ensureProjectViews(viewDefs) {
    return projects.ensureProjectViews(this._ctx, viewDefs);
  }

  /* node:coverage ignore next */
  async ensureProjectFields(fieldDefs) {
    return projects.ensureProjectFields(this._ctx, fieldDefs);
  }

  // Underscore-prefixed wrappers preserve the surface that existing unit
  // tests reach for. They are not part of the public ITicketingProvider.

  _getNativeSubIssues(parentNodeId, parentId) {
    return issues.getNativeSubIssues(this._ctx, parentNodeId, parentId);
  }

  _getChecklistChildren(parentBody) {
    return issues.getChecklistChildren(parentBody);
  }

  _getReferencedChildren(parentId) {
    return issues.getReferencedChildren(this._ctx, parentId);
  }

  _updateLabels(ticketId, labelMutations, hasOtherPatchFields) {
    return issues.applyLabelMutations(
      this._ctx,
      ticketId,
      labelMutations,
      hasOtherPatchFields,
    );
  }
}
