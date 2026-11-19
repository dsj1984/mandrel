import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readProjectStatuses } from '../../../.agents/scripts/lib/dispatch/project-status.js';

const config = { github: { owner: 'o', repo: 'r', projectNumber: 7 } };

const item = (number, name) => ({
  project: { number },
  status: name === null ? null : { name },
});

/** A provider whose GraphQL answers each aliased issue from `items`. */
function fakeProvider(items, calls = []) {
  return {
    graphql: async (query, vars) => {
      calls.push({ query, vars });
      const repository = {};
      for (const [, id] of query.matchAll(/i(\d+): issue/g)) {
        repository[`i${id}`] = { projectItems: { nodes: items[id] ?? [] } };
      }
      return { repository };
    },
  };
}

describe('readProjectStatuses', () => {
  it('reads each Story Status on the configured project only', async () => {
    const provider = fakeProvider({
      1: [item(3, 'Done'), item(7, 'On Hold')],
      2: [item(7, null)],
      3: [],
    });
    const statuses = await readProjectStatuses(provider, [1, 2, 3], config);
    assert.deepEqual([...statuses], [[1, 'On Hold']]);
  });

  it('batches ids 50 to a request and drops duplicates and non-integers', async () => {
    const calls = [];
    const ids = [...Array.from({ length: 120 }, (_, i) => i + 1), 1, 'x'];
    await readProjectStatuses(fakeProvider({}, calls), ids, config);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].vars, { owner: 'o', repo: 'r' });
    assert.equal(calls[2].query.match(/: issue/g).length, 20);
  });

  it('reads nothing without a project, a repository or GraphQL', async () => {
    const calls = [];
    const provider = fakeProvider({ 1: [item(7, 'Todo')] }, calls);
    for (const github of [
      { owner: 'o', repo: 'r' },
      { repo: 'r', projectNumber: 7 },
    ]) {
      assert.equal(
        (await readProjectStatuses(provider, [1], { github })).size,
        0,
      );
    }
    assert.equal((await readProjectStatuses({}, [1], config)).size, 0);
    assert.equal(calls.length, 0);
  });

  it('degrades to no Status when a read fails', async () => {
    const provider = {
      graphql: async () => {
        throw new Error('Your token has not been granted the required scopes');
      },
    };
    assert.equal((await readProjectStatuses(provider, [1], config)).size, 0);
  });
});
