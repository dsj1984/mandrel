/**
 * GitHub Provider — gateway wiring: builds each gateway, cross-links them
 * via hooks, and builds the shared `_ctx` the projects-v2 shim reads.
 */

import { BranchProtectionGateway } from './branch-protection.js';
import { CommentGateway } from './comments.js';
import { classifyGithubError } from './errors.js';
import { IssuesGateway } from './issues.js';
import { LabelGateway } from './labels.js';
import { MergeMethodsGateway } from './merge-methods.js';
import { ProjectBoardGateway } from './project-board.js';
import * as projects from './projects-v2-graphql.js';
import { SubIssueGateway } from './sub-issues.js';
import { TicketGateway } from './tickets.js';

/** Mutates `provider` in place. */
export function composeGateways(provider) {
  const p = provider;
  const ghDeps = { gh: p._gh, owner: p.owner, repo: p.repo };
  const addItemToProject = (id) => projects.addItemToProject(p._ctx, id);
  const getProjectNumber = () => p.projectNumber;

  p.tickets = new TicketGateway({
    ...ghDeps,
    cache: p._cache,
    hooks: {
      addItemToProject,
      getProjectNumber,
    },
  });
  p.subIssues = new SubIssueGateway({
    ghGraphql: (q, v, o) => p.graphql(q, v, o),
    cache: p._cache,
    classifyGithubError,
  });
  p.comments = new CommentGateway({
    ...ghDeps,
    hooks: { invalidateTicket: (id) => p.invalidateTicket(id) },
  });
  p.labels = new LabelGateway(ghDeps);
  p.branchProtection = new BranchProtectionGateway(ghDeps);
  p.mergeMethods = new MergeMethodsGateway(ghDeps);
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
