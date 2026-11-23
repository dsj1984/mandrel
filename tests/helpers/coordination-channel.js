/**
 * An in-memory GitHub for coordination-channel tests. A comment posted
 * through `postComment` comes back from `getRepoCommentsSince` and
 * `getTicketComments` carrying the author fields a reader decides trust on,
 * and every provider call is recorded so a test can assert none was made.
 */

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/**
 * @param {{ tickets?: Record<number, { body?: string, labels?: string[], state?: string }>,
 *   clock?: () => string }} [opts] `clock` stamps each posted comment.
 */
export function makeChannelProvider({
  tickets = {},
  clock = () => '2026-11-20T10:00:00Z',
} = {}) {
  const issues = new Map(
    Object.entries(tickets).map(([id, ticket]) => [
      Number(id),
      { id: Number(id), body: '', labels: [], state: 'open', ...ticket },
    ]),
  );
  let nextIssue = 9000;
  const provider = {
    /** Raw comments, oldest first. */
    comments: [],
    /** Names of the provider methods called, in order. */
    calls: [],
    /** Who the next posted comment is from. */
    author: { login: 'alice', association: 'MEMBER' },
    issues,

    /** Add a comment directly, bypassing the channel. */
    add(issueId, body, overrides = {}) {
      const at = clock();
      const comment = {
        id: provider.comments.length + 1,
        body,
        issue_url: `https://api.github.com/repos/octo/demo/issues/${issueId}`,
        user: { login: provider.author.login },
        author_association: provider.author.association,
        created_at: at,
        updated_at: at,
        ...overrides,
      };
      provider.comments.push(comment);
      return comment;
    },
    async postComment(issueId, payload) {
      provider.calls.push('postComment');
      return { commentId: provider.add(issueId, payload.body).id };
    },
    async getRepoCommentsSince(since) {
      provider.calls.push('getRepoCommentsSince');
      return provider.comments.filter(
        (c) => Date.parse(c.updated_at) >= Date.parse(since),
      );
    },
    async getTicketComments(issueId) {
      provider.calls.push('getTicketComments');
      return provider.comments.filter((c) =>
        c.issue_url.endsWith(`/issues/${issueId}`),
      );
    },
    async getTicket(id) {
      provider.calls.push('getTicket');
      const ticket = issues.get(id);
      if (!ticket) throw new Error(`no ticket #${id}`);
      return ticket;
    },
    async listTicketsByLabel({ labels }) {
      provider.calls.push('listTicketsByLabel');
      return [...issues.values()].filter(
        (t) => t.state === 'open' && t.labels.includes(labels),
      );
    },
    async ensureLabels(defs) {
      provider.calls.push('ensureLabels');
      return { created: defs.map((d) => d.name), skipped: [], missing: [] };
    },
    async createIssue({ title, body, labels }) {
      provider.calls.push('createIssue');
      const id = nextIssue;
      nextIssue += 1;
      issues.set(id, { id, title, body, labels, state: 'open' });
      return { id, number: id };
    },
  };
  return provider;
}

/**
 * A resolved-config stand-in whose temp root is a fresh scratch directory,
 * so each test owns its cursor files.
 *
 * @param {{ coordination?: object, webhookEvents?: string[] }} [opts]
 */
export function makeChannelConfig({ coordination, webhookEvents = [] } = {}) {
  return {
    project: {
      baseBranch: 'main',
      paths: { tempRoot: makeTempDir('coordination-') },
    },
    github: {
      owner: 'octo',
      repo: 'demo',
      notifications: { commentEvents: [], webhookEvents },
      ...(coordination ? { coordination } : {}),
    },
  };
}

/**
 * A Story body declaring `paths` under `## Changes` and `blockedBy` in the
 * footer.
 *
 * @param {{ paths?: string[], blockedBy?: number[] }} [opts]
 * @returns {string}
 */
export function storyBody({ paths = [], blockedBy = [] } = {}) {
  const lines = ['## Goal', 'A fixture Story.', '', '## Changes'];
  for (const p of paths) lines.push(`- \`${p}\` — refactors-existing`);
  if (blockedBy.length > 0) {
    lines.push('', '---');
    for (const id of blockedBy) lines.push(`blocked by #${id}`);
  }
  return lines.join('\n');
}

/**
 * A git double: the branch checked out, and the paths `git diff --name-only`
 * reports against the base.
 *
 * @param {{ branch?: string, changed?: string[] }} [opts]
 */
export function fakeGit({ branch = 'main', changed = [] } = {}) {
  return {
    gitSpawn(_cwd, ...args) {
      if (args[0] === 'branch')
        return { status: 0, stdout: branch, stderr: '' };
      return { status: 0, stdout: changed.join('\n'), stderr: '' };
    },
  };
}
