/**
 * GitHub Provider — gateway composition helper.
 *
 * Pulled out of `../github.js` in Story #2462 / Task #2481 so the parent
 * file can stay under the thin-composer LOC ceiling. This module owns the
 * mechanical wiring: it builds each gateway, threads the hooks that
 * cross-link them, and constructs the shared `_ctx` object the projects-v2
 * shim reads from.
 *
 * The provider holds the public surface; this helper holds the wiring.
 * Splitting the two keeps the composer file readable and reviewable as a
 * delegation manifest rather than a constructor-shaped wall of new-up
 * calls.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { BranchProtectionGateway } from './branch-protection.js';
import { CommentGateway } from './comments.js';
import { classifyGithubError } from './errors.js';
import { IssuesGateway } from './issues.js';
import { LabelGateway } from './labels.js';
import { MergeMethodsGateway } from './merge-methods.js';
import { ProjectBoardGateway } from './project-board.js';
import * as projects from './projects-v2-graphql.js';
import { PullRequestGateway } from './prs.js';
import { SubIssueGateway } from './sub-issues.js';
import { TicketGateway } from './tickets.js';

/**
 * Wire every gateway onto `provider` and attach the shared `_ctx` object.
 * Mutates the provider in place — the constructor passes `this` in and
 * lets this helper own the wiring decisions.
 */
export function composeGateways(provider) {
  const p = provider;
  const ghDeps = { gh: p._gh, owner: p.owner, repo: p.repo };
  const addItemToProject = (id) => projects.addItemToProject(p._ctx, id);
  const getProjectNumber = () => p.projectNumber;

  p.tickets = new TicketGateway({
    ...ghDeps,
    cache: p._cache,
    hooks: {
      addSubIssue: (a, b) => p.addSubIssue(a, b),
      addItemToProject,
      getProjectNumber,
    },
  });
  p.subIssues = new SubIssueGateway({
    ghGraphql: (q, v, o) => p.graphql(q, v, o),
    cache: p._cache,
    classifyGithubError,
    hooks: {
      getTicket: (id, o) => p.getTicket(id, o),
      getTickets: (id) => p.getTickets(id),
      primeTicketCache: (t) => p.primeTicketCache(t),
      invalidateTicket: (id) => p.invalidateTicket(id),
    },
  });
  p.comments = new CommentGateway({
    ...ghDeps,
    hooks: { invalidateTicket: (id) => p.invalidateTicket(id) },
  });
  p.labels = new LabelGateway(ghDeps);
  p.branchProtection = new BranchProtectionGateway(ghDeps);
  p.mergeMethods = new MergeMethodsGateway(ghDeps);
  p.pullRequests = new PullRequestGateway({
    gh: p._gh,
    hooks: {
      getTicket: (id) => p.getTicket(id),
      addItemToProject,
      getProjectNumber,
    },
  });
  p.issues = new IssuesGateway({
    ...ghDeps,
    hooks: {
      getTicket: (id, o) => p.getTicket(id, o),
      getTickets: (id) => p.getTickets(id),
      getNativeSubIssues: (n, id) => p.subIssues.getNativeSubIssues(n, id),
      primeTicketCache: (t) => p.primeTicketCache(t),
    },
  });

  p._ctx = {
    owner: p.owner,
    repo: p.repo,
    projectOwner: p.projectOwner,
    projectName: p.projectName,
    operatorHandle: p.operatorHandle,
    get projectNumber() {
      return p.projectNumber;
    },
    set projectNumber(v) {
      p.projectNumber = v;
    },
    get cache() {
      return p._cache;
    },
    get token() {
      return p._memoizedToken;
    },
    state: { projectId: null },
    hooks: {
      getTicket: (id, o) => p.getTicket(id, o),
      addItemToProject: (id) => projects.addItemToProject(p._ctx, id),
    },
  };
  p.projectBoard = new ProjectBoardGateway({ ctx: p._ctx });
}
