/**
 * tests/providers/github-surface-parity.test.js
 *
 * Surface-parity test for the thin-composer GitHubProvider (Story #2462 /
 * Task #2481).
 *
 * The split moves every cross-cutting concern into a sibling gateway under
 * `.agents/scripts/providers/github/`. This test asserts:
 *
 *   1. Every async/sync method declared on `ITicketingProvider` is present
 *      on `GitHubProvider` (no method got accidentally renamed or dropped
 *      during the split).
 *   2. The thin composer delegates each one to a concrete gateway — i.e.
 *      a fixture-stubbed gateway return value is returned verbatim by the
 *      provider's method. This is the parity invariant: external callers
 *      see the same call shape whether the body lived in `github.js` (pre-
 *      split) or on a gateway (post-split).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ITicketingProvider } from '../../.agents/scripts/lib/ITicketingProvider.js';
import { GitHubProvider } from '../../.agents/scripts/providers/github.js';

/**
 * Build a provider with every gateway stubbed so we can assert the
 * delegation surface without spinning up a real `gh-exec` facade.
 */
function buildProvider() {
  const provider = new GitHubProvider(
    { owner: 'octo', repo: 'demo', projectNumber: 1, projectOwner: 'octo' },
    { token: 'ghp_test', gh: { api: async () => ({ stdout: '{}' }) } },
  );

  // Every gateway is replaced with an object whose method names match the
  // ones the thin composer reaches for. Each method returns a sentinel so
  // the parity assertion in the second test can pick up the exact return.
  provider.tickets = {
    getTicket: async () => 'tickets.getTicket',
    getTickets: async () => 'tickets.getTickets',
    primeTicketCache: () => 'tickets.primeTicketCache',
    invalidateTicket: () => 'tickets.invalidateTicket',
    getTicketDependencies: async () => 'tickets.getTicketDependencies',
    createTicket: async () => 'tickets.createTicket',
    updateTicket: async () => 'tickets.updateTicket',
    _applyLabelMutations: async () => 'tickets._applyLabelMutations',
  };
  provider.subIssues = {
    getNativeSubIssues: async () => 'subIssues.getNativeSubIssues',
    getNativeParent: async () => 'subIssues.getNativeParent',
    addSubIssue: async () => 'subIssues.addSubIssue',
    removeSubIssue: async () => 'subIssues.removeSubIssue',
    reconcileSubIssueLinks: async () => 'subIssues.reconcileSubIssueLinks',
  };
  provider.comments = {
    getRecentComments: async () => 'comments.getRecentComments',
    getTicketComments: async () => 'comments.getTicketComments',
    deleteComment: async () => 'comments.deleteComment',
    postComment: async () => 'comments.postComment',
  };
  provider.labels = {
    ensureLabels: async () => 'labels.ensureLabels',
    _reconcileLabelsPresence: async () => 'labels._reconcileLabelsPresence',
    _normalizeLabelListResult: () => 'labels._normalizeLabelListResult',
  };
  provider.branchProtection = {
    getBranchProtection: async () => 'branchProtection.getBranchProtection',
    setBranchProtection: async () => 'branchProtection.setBranchProtection',
  };
  provider.mergeMethods = {
    getMergeMethods: async () => 'mergeMethods.getMergeMethods',
    setMergeMethods: async () => 'mergeMethods.setMergeMethods',
  };
  provider.pullRequests = {
    createPullRequest: async () => 'pullRequests.createPullRequest',
  };
  provider.projectBoard = {
    resolveOrCreateProject: async () => 'projectBoard.resolveOrCreateProject',
    ensureStatusField: async () => 'projectBoard.ensureStatusField',
    ensureProjectViews: async () => 'projectBoard.ensureProjectViews',
    ensureProjectFields: async () => 'projectBoard.ensureProjectFields',
  };
  provider.issues = {
    ghGraphql: async () => 'issues.ghGraphql',
    listIssuesByLabel: async () => 'issues.listIssuesByLabel',
    getEpics: async () => 'issues.getEpics',
    getEpic: async () => 'issues.getEpic',
    branchExists: async () => 'issues.branchExists',
    getSubTickets: async () => 'issues.getSubTickets',
    _getChecklistChildren: () => 'issues._getChecklistChildren',
    _getReferencedChildren: async () => 'issues._getReferencedChildren',
  };
  return provider;
}

/**
 * Methods declared on ITicketingProvider that the parity contract requires
 * GitHubProvider to expose. Sourced from the interface's prototype.
 */
const REQUIRED_INTERFACE_METHODS = Object.getOwnPropertyNames(
  ITicketingProvider.prototype,
).filter((name) => name !== 'constructor');

describe('providers/github.js — surface parity (Story #2462 / Task #2481)', () => {
  it('GitHubProvider exposes every method declared on ITicketingProvider', () => {
    const proto = Object.getOwnPropertyNames(GitHubProvider.prototype);
    for (const method of REQUIRED_INTERFACE_METHODS) {
      assert.ok(
        proto.includes(method),
        `GitHubProvider is missing the ITicketingProvider method '${method}'`,
      );
      assert.equal(
        typeof GitHubProvider.prototype[method],
        'function',
        `GitHubProvider.${method} is not a function`,
      );
    }
  });

  it('every thin-composer method delegates verbatim to its gateway', async () => {
    const provider = buildProvider();

    // Map of public method on the provider → expected sentinel from the
    // stubbed gateway. Together these cover the ITicketingProvider surface
    // plus the underscore-prefixed accessors external tests reach for.
    const cases = [
      // tickets
      ['getTicket', [1], 'tickets.getTicket'],
      ['getTickets', [1], 'tickets.getTickets'],
      ['getTicketDependencies', [1], 'tickets.getTicketDependencies'],
      ['createTicket', [1, {}], 'tickets.createTicket'],
      ['updateTicket', [1, {}], 'tickets.updateTicket'],
      ['_applyLabelMutations', [1, {}, false], 'tickets._applyLabelMutations'],
      // sub-issues
      ['_getNativeSubIssues', ['NODE', 1], 'subIssues.getNativeSubIssues'],
      ['_getNativeParent', ['NODE', 1], 'subIssues.getNativeParent'],
      ['addSubIssue', [1, 'NODE'], 'subIssues.addSubIssue'],
      ['removeSubIssue', [1, 2], 'subIssues.removeSubIssue'],
      ['reconcileSubIssueLinks', [1], 'subIssues.reconcileSubIssueLinks'],
      // comments
      ['getRecentComments', [], 'comments.getRecentComments'],
      ['getTicketComments', [1], 'comments.getTicketComments'],
      ['deleteComment', [1], 'comments.deleteComment'],
      ['postComment', [1, {}], 'comments.postComment'],
      // labels
      ['ensureLabels', [[]], 'labels.ensureLabels'],
      ['_reconcileLabelsPresence', [[]], 'labels._reconcileLabelsPresence'],
      // branch-protection
      ['getBranchProtection', ['main'], 'branchProtection.getBranchProtection'],
      [
        'setBranchProtection',
        ['main', {}],
        'branchProtection.setBranchProtection',
      ],
      // merge-methods
      ['getMergeMethods', [], 'mergeMethods.getMergeMethods'],
      ['setMergeMethods', [{}], 'mergeMethods.setMergeMethods'],
      // pull-requests
      [
        'createPullRequest',
        ['feat/x', 1, 'main'],
        'pullRequests.createPullRequest',
      ],
      // project-board
      ['resolveOrCreateProject', [{}], 'projectBoard.resolveOrCreateProject'],
      ['ensureStatusField', [[]], 'projectBoard.ensureStatusField'],
      ['ensureProjectViews', [[]], 'projectBoard.ensureProjectViews'],
      ['ensureProjectFields', [[]], 'projectBoard.ensureProjectFields'],
      // issues
      ['graphql', ['query {}'], 'issues.ghGraphql'],
      ['listIssuesByLabel', [{}], 'issues.listIssuesByLabel'],
      ['getEpics', [{}], 'issues.getEpics'],
      ['getEpic', [1], 'issues.getEpic'],
      ['branchExists', ['main'], 'issues.branchExists'],
      ['getSubTickets', [1], 'issues.getSubTickets'],
      ['_getReferencedChildren', [1], 'issues._getReferencedChildren'],
    ];

    for (const [method, args, expected] of cases) {
      const result = await provider[method](...args);
      assert.equal(
        result,
        expected,
        `GitHubProvider.${method}() should delegate to ${expected}`,
      );
    }

    // Synchronous delegations — `primeTicketCache` / `invalidateTicket`
    // are void-returning (the gateway versions also drop returns). Spy on
    // them via call-tracking instead of return-value parity.
    let primed = null;
    let invalidated = null;
    provider.tickets.primeTicketCache = (t) => {
      primed = t;
    };
    provider.tickets.invalidateTicket = (id) => {
      invalidated = id;
    };
    provider.primeTicketCache(['x']);
    provider.invalidateTicket(42);
    assert.deepEqual(primed, ['x']);
    assert.equal(invalidated, 42);

    assert.equal(
      provider._normalizeLabelListResult({}),
      'labels._normalizeLabelListResult',
    );
    assert.equal(
      provider._getChecklistChildren(''),
      'issues._getChecklistChildren',
    );
  });
});
