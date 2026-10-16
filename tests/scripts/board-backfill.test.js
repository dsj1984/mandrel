/**
 * Unit tests for `.agents/scripts/board-backfill.js` (Story #5727): open
 * `type::story` / `type::epic` issues missing from the Projects v2 board are
 * listed by `--dry-run`, added (with Story Status synced from the `agent::*`
 * label) otherwise, and a re-run is a no-op. A scope refusal surfaces as a
 * `ProjectAccessError` carrying the remedy.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  listBoardCandidates,
  planIssue,
  runBackfill,
} from '../../.agents/scripts/board-backfill.js';
import { ProjectAccessError } from '../../.agents/scripts/lib/orchestration/project-meta-resolver.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

let tempRoot;
let config;
beforeEach(() => {
  tempRoot = makeTempDir('mandrel-backfill-');
  config = { github: { projectNumber: 4 }, project: { paths: { tempRoot } } };
});
afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const STATUS_FIELD = {
  id: 'FIELD',
  options: [
    { id: 'o-todo', name: 'Todo' },
    { id: 'o-prog', name: 'In Progress' },
    { id: 'o-done', name: 'Done' },
  ],
};

/**
 * A fake board: `issues` are open issues `{ number, labels }`; `board` maps
 * issue number → Status name (or null) for those already on the board.
 */
function fakeBoard(issues, board = new Map()) {
  const mutations = [];
  const itemNodes = (number) =>
    board.has(number)
      ? [
          {
            id: `ITEM-${number}`,
            project: { id: 'PROJ' },
            fieldValueByName: board.get(number)
              ? { name: board.get(number) }
              : null,
          },
        ]
      : [];
  const provider = {
    owner: 'acme',
    repo: 'widgets',
    projectNumber: 4,
    mutations,
    board,
    async graphql(query, vars) {
      if (query.includes('organization(login: $owner)')) {
        return {
          organization: { projectV2: { id: 'PROJ', field: STATUS_FIELD } },
        };
      }
      if (query.includes('issues(states: OPEN')) {
        return {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: issues
                .filter((i) => i.labels.includes(vars.label))
                .map((i) => ({
                  number: i.number,
                  id: `NODE-${i.number}`,
                  labels: { nodes: i.labels.map((name) => ({ name })) },
                  projectItems: { nodes: itemNodes(i.number) },
                })),
            },
          },
        };
      }
      if (query.includes('addProjectV2ItemById')) {
        mutations.push(['add', vars.contentId]);
        board.set(Number(vars.contentId.replace('NODE-', '')), null);
        return { addProjectV2ItemById: { item: { id: 'X' } } };
      }
      if (query.includes('projectItems(first')) {
        return {
          repository: {
            issue: { projectItems: { nodes: itemNodes(vars.number) } },
          },
        };
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        const number = Number(vars.itemId.replace('ITEM-', ''));
        const name = STATUS_FIELD.options.find(
          (o) => o.id === vars.optionId,
        ).name;
        mutations.push(['status', number, name]);
        board.set(number, name);
        return {};
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    },
  };
  return provider;
}

const ISSUES = [
  { number: 1, labels: ['type::story', 'agent::executing'] },
  { number: 2, labels: ['type::epic'] },
  { number: 3, labels: ['type::story', 'agent::done'] },
];

describe('board-backfill', () => {
  it('--dry-run lists the missing issues and the Status each would receive, changing nothing', async () => {
    const provider = fakeBoard(ISSUES, new Map([[3, 'Done']]));
    const out = await runBackfill({ provider, config, dryRun: true });
    assert.deepEqual(out.planned, [
      { number: 1, type: 'story', add: true, status: 'In Progress' },
      { number: 2, type: 'epic', add: true, status: null },
    ]);
    assert.equal(out.skipped, 1);
    assert.equal(out.added, 0);
    assert.deepEqual(provider.mutations, []);
  });

  it('adds missing issues, syncs Story Status from agent::* labels, and a re-run is a no-op', async () => {
    const provider = fakeBoard(ISSUES, new Map([[3, 'In Progress']]));
    const first = await runBackfill({ provider, config });
    assert.deepEqual(
      { ...first, planned: undefined },
      {
        dryRun: false,
        added: 2,
        synced: 2,
        skipped: 0,
        failed: 0,
        planned: undefined,
      },
    );
    assert.equal(provider.board.get(1), 'In Progress');
    assert.equal(provider.board.get(2), null, 'Epic Status left to rollup');
    assert.equal(provider.board.get(3), 'Done');

    provider.mutations.length = 0;
    const second = await runBackfill({ provider, config });
    assert.equal(second.added, 0);
    assert.equal(second.synced, 0);
    assert.equal(second.skipped, 3);
    assert.deepEqual(provider.mutations, []);
  });

  it('throws a ProjectAccessError with the remedy when the token lacks the project scope', async () => {
    const provider = fakeBoard(ISSUES);
    provider.graphql = async () => {
      throw new Error(
        'GraphQL errors: [{"type":"INSUFFICIENT_SCOPES","message":"Your token has not been granted the required scopes to execute this query."}]',
      );
    };
    await assert.rejects(runBackfill({ provider, config }), (err) => {
      assert.ok(err instanceof ProjectAccessError);
      assert.equal(err.remedy, 'gh auth refresh -h github.com -s project');
      return true;
    });
  });

  it('throws a ProjectAccessError when only the add mutation is refused (read-only scope)', async () => {
    const provider = fakeBoard(ISSUES);
    const base = provider.graphql.bind(provider);
    provider.graphql = async (query, vars) => {
      if (query.includes('addProjectV2ItemById')) {
        throw new Error('INSUFFICIENT_SCOPES');
      }
      return base(query, vars);
    };
    await assert.rejects(runBackfill({ provider, config }), ProjectAccessError);
  });

  it('counts a non-scope add failure and carries on', async (t) => {
    const provider = fakeBoard(ISSUES, new Map([[3, 'Done']]));
    const base = provider.graphql.bind(provider);
    provider.graphql = async (query, vars) => {
      if (
        query.includes('addProjectV2ItemById') &&
        vars.contentId === 'NODE-1'
      ) {
        throw new Error('boom');
      }
      return base(query, vars);
    };
    t.mock.method(console, 'warn', () => {});
    const out = await runBackfill({ provider, config });
    assert.equal(out.failed, 1);
    assert.equal(out.added, 1);
  });

  it('refuses to run without a configured board', async () => {
    const provider = fakeBoard(ISSUES);
    provider.projectNumber = null;
    await assert.rejects(
      runBackfill({ provider, config: {} }),
      /No github\.projectNumber configured/,
    );
  });

  it('refuses to run when the board resolves on no rung', async () => {
    const provider = fakeBoard(ISSUES);
    const base = provider.graphql.bind(provider);
    provider.graphql = async (query, vars) => {
      if (query.includes('projectV2(number')) return {};
      return base(query, vars);
    };
    await assert.rejects(
      runBackfill({ provider, config }),
      /Project #4 not found/,
    );
  });

  it('dedupes an issue carrying both type labels', async () => {
    const provider = fakeBoard([
      { number: 9, labels: ['type::story', 'type::epic'] },
    ]);
    const list = await listBoardCandidates(provider);
    assert.equal(list.length, 1);
    assert.equal(planIssue(list[0], 'PROJ').type, 'epic');
  });
});
