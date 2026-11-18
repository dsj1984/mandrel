import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveEnvironments } from '../../../.agents/scripts/lib/dispatch/environments.js';
import {
  buildStatus,
  fetchBoard,
  renderStatus,
} from '../../../.agents/scripts/lib/dispatch/status.js';

const t = (id, labels, extra = {}) => ({
  id,
  title: `Story ${id}`,
  body: '',
  state: 'open',
  labels,
  assignees: [],
  ...extra,
});

/** One ticket through the read model: its row, or undefined when unlisted. */
const rowOf = (ticket, prs = []) =>
  buildStatus({
    environments: resolveEnvironments({}),
    openTickets: ticket.state === 'closed' ? [] : [ticket],
    closedStories: ticket.state === 'closed' ? [ticket] : [],
    prs,
  }).stories[0];

describe('column mapping', () => {
  const cases = [
    [t(1, ['type::story']), 'backlog'],
    [t(2, ['agent::review-spec']), 'planning'],
    [t(3, ['agent::ready']), 'ready'],
    [t(4, ['agent::ready', 'env::local']), 'delivering'],
    [t(5, ['agent::executing']), 'delivering'],
    [t(6, ['agent::closing']), 'delivering'],
    [t(7, ['agent::blocked']), 'blocked'],
    [t(8, ['agent::done'], { state: 'closed' }), 'done'],
    [t(9, ['agent::done']), undefined],
  ];
  for (const [ticket, column] of cases) {
    it(`maps ${ticket.labels.join(',')} (${ticket.state}) to ${column}`, () => {
      assert.equal(rowOf(ticket)?.column, column);
    });
  }
});

describe('PR check summary', () => {
  it('counts passed, failed and pending checks', () => {
    const row = rowOf(t(1, ['agent::executing']), [
      {
        number: 3,
        url: 'u',
        headRefName: 'story-1',
        statusCheckRollup: [
          { conclusion: 'SUCCESS' },
          { conclusion: 'SKIPPED' },
          { conclusion: 'FAILURE' },
          { status: 'IN_PROGRESS', conclusion: '' },
          { state: 'PENDING' },
        ],
      },
    ]);
    assert.deepEqual(row.pr.checks, {
      total: 5,
      passed: 2,
      failed: 1,
      pending: 2,
    });
  });
});

describe('buildStatus', () => {
  const environments = resolveEnvironments({});
  const board = {
    environments,
    openTickets: [
      t(10, ['type::story', 'agent::ready'], {
        body: 'x\n\n---\nblocked by #11\n',
      }),
      t(11, ['type::story', 'agent::executing', 'env::local']),
      t(12, ['type::epic']),
      t(13, ['type::story', 'agent::blocked', 'env::local']),
    ],
    closedStories: Array.from({ length: 22 }, (_, i) =>
      t(100 + i, ['type::story', 'agent::done'], {
        state: 'closed',
        closedAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    ),
    prs: [
      {
        number: 5,
        url: 'u',
        headRefName: 'story-11',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      },
    ],
    operator: 'me',
  };
  const status = buildStatus(board);

  it('returns the documented environment shape with load', () => {
    assert.deepEqual(status.environments, [
      { name: 'local', target: 'local', capacity: 1, load: 2, online: true },
    ]);
  });

  it('lists no Epic and caps done at the 20 most recently closed', () => {
    const ids = status.stories.map((s) => s.id);
    assert.equal(ids.includes(12), false);
    const done = status.stories.filter((s) => s.column === 'done');
    assert.equal(done.length, 20);
    assert.equal(done[0].id, 121);
  });

  it('carries the documented Story fields', () => {
    const row = status.stories.find((s) => s.id === 11);
    assert.deepEqual(Object.keys(row).sort(), [
      'column',
      'dependsOn',
      'drops',
      'environment',
      'id',
      'pr',
      'state',
      'title',
    ]);
    assert.equal(row.environment, 'local');
    assert.deepEqual(row.pr, {
      number: 5,
      url: 'u',
      checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    });
  });

  it('maps every column and environment to a verdict', () => {
    const { drops, dependsOn } = status.stories.find((s) => s.id === 10);
    assert.deepEqual(dependsOn, [11]);
    assert.deepEqual(Object.keys(drops).sort(), [
      'backlog',
      'blocked',
      'delivering',
      'done',
      'local',
      'planning',
      'ready',
    ]);
    assert.equal(drops.local.reason, 'unmet-dependency');
    assert.equal(drops.ready.reason, 'wrong-environment');
    const blocked = status.stories.find((s) => s.id === 13);
    assert.deepEqual(blocked.drops.local, {
      ok: true,
      action: 'resume',
      environment: 'local',
      applyLabel: false,
    });
  });

  it('renders a human table', () => {
    const text = renderStatus(status);
    assert.match(text, /local\s+local\s+2\/1/);
    assert.match(text, /#11 \[local\] PR #5 Story 11/);
  });
});

describe('fetchBoard', () => {
  it('reads open issues, one page of closed Stories and open PRs', async () => {
    const calls = [];
    const board = await fetchBoard({
      config: { github: { owner: 'o', repo: 'r' } },
      provider: {
        listTicketsByLabel: async (opts) => {
          calls.push(['list', opts]);
          return [t(1, ['agent::ready'])];
        },
      },
      gh: {
        api: async ({ endpoint }) => {
          calls.push(['api', endpoint]);
          return {
            stdout: JSON.stringify([
              {
                number: 2,
                title: 'Closed',
                labels: [{ name: 'type::story' }],
                assignees: [{ login: 'a' }],
                closed_at: 'z',
              },
              { number: 3, pull_request: {} },
            ]),
          };
        },
        pr: {
          list: async (flags, fields) => {
            calls.push(['pr', flags, fields]);
            return [{ number: 9 }];
          },
        },
      },
    });
    assert.deepEqual(calls[0], ['list', { state: 'open' }]);
    assert.match(
      calls[1][1],
      /^\/repos\/o\/r\/issues\?state=closed&labels=type%3A%3Astory/,
    );
    assert.deepEqual(board.closedStories, [
      {
        id: 2,
        title: 'Closed',
        body: '',
        labels: ['type::story'],
        assignees: ['a'],
        state: 'closed',
        closedAt: 'z',
      },
    ]);
    assert.deepEqual(board.prs, [{ number: 9 }]);
  });
});
