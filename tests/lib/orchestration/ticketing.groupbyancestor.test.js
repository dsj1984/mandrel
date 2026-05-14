import assert from 'node:assert/strict';
import test from 'node:test';
import { groupByAncestor } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Build a minimal fake provider whose `getTicket(id)` returns a body that
 * encodes a parent chain via `parent: #N` markers. Other ITicketingProvider
 * surface is left absent — `groupByAncestor` only needs the body reader.
 */
function makeProvider(chains) {
  return {
    async getTicket(id) {
      const parents = chains[id] ?? [];
      const body = parents.map((p) => `parent: #${p}`).join('\n');
      return { id, body, labels: [], state: 'open' };
    },
  };
}

test('groupByAncestor', async (t) => {
  await t.test('single parent returns one group', async () => {
    const provider = makeProvider({ 10: [] });
    const groups = await groupByAncestor([10], provider);
    assert.deepEqual(groups, [[10]]);
  });

  await t.test('two disjoint parents return two singleton groups', async () => {
    // #10 climbs to #100; #20 climbs to #200. No overlap.
    const provider = makeProvider({
      10: [100],
      20: [200],
      100: [],
      200: [],
    });
    const groups = await groupByAncestor([10, 20], provider);
    assert.equal(
      groups.length,
      2,
      `expected 2 groups, got ${JSON.stringify(groups)}`,
    );
    assert.deepEqual(groups[0], [10]);
    assert.deepEqual(groups[1], [20]);
  });

  await t.test(
    'two parents sharing a grandparent end up in the same group',
    async () => {
      // #10 → #100; #20 → #100. Shared grandparent #100 unions the group.
      const provider = makeProvider({
        10: [100],
        20: [100],
        100: [],
      });
      const groups = await groupByAncestor([10, 20], provider);
      assert.equal(
        groups.length,
        1,
        `expected 1 group, got ${JSON.stringify(groups)}`,
      );
      assert.deepEqual(groups[0], [10, 20]);
    },
  );

  await t.test(
    'three parents: two share an ancestor, one is disjoint',
    async () => {
      const provider = makeProvider({
        10: [100],
        20: [100],
        30: [300],
        100: [],
        300: [],
      });
      const groups = await groupByAncestor([10, 20, 30], provider);
      assert.equal(groups.length, 2);
      assert.deepEqual(groups[0], [10, 20]);
      assert.deepEqual(groups[1], [30]);
    },
  );

  await t.test(
    'union of returned groups equals input set; within-group order preserved',
    async () => {
      const provider = makeProvider({
        10: [100],
        20: [200],
        30: [100],
        40: [200],
        50: [500],
        100: [],
        200: [],
        500: [],
      });
      const input = [10, 20, 30, 40, 50];
      const groups = await groupByAncestor(input, provider);
      const flat = groups.flat();
      assert.deepEqual(
        [...flat].sort((a, b) => a - b),
        [...input].sort((a, b) => a - b),
        'union of groups must equal input set',
      );
      // #10 and #30 share #100; #20 and #40 share #200; #50 is alone.
      assert.equal(groups.length, 3);
      // Order within each group preserves input order.
      const group10 = groups.find((g) => g.includes(10));
      assert.deepEqual(group10, [10, 30]);
      const group20 = groups.find((g) => g.includes(20));
      assert.deepEqual(group20, [20, 40]);
    },
  );

  await t.test('cycle-safe: cyclic parent chain terminates', async () => {
    // #10 → #20 → #10 (cycle). The walker must not loop.
    const provider = makeProvider({
      10: [20],
      20: [10],
    });
    // If the walker loops, this call will hang the test. Wrap in a timeout
    // race so a regression fails loudly rather than stalling CI.
    const result = await Promise.race([
      groupByAncestor([10], provider),
      new Promise((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error('groupByAncestor did not terminate on cyclic chain'),
            ),
          2000,
        ),
      ),
    ]);
    assert.deepEqual(result, [[10]]);
  });

  await t.test('empty input returns empty group list', async () => {
    const provider = makeProvider({});
    const groups = await groupByAncestor([], provider);
    assert.deepEqual(groups, []);
  });

  await t.test(
    'ancestor chain caching avoids duplicate provider reads',
    async () => {
      const reads = [];
      const provider = {
        async getTicket(id) {
          reads.push(id);
          // #10 and #20 both climb through #100 to #200. The shared tail
          // (#100 → #200) should be walked once and reused.
          if (id === 10) return { id, body: 'parent: #100' };
          if (id === 20) return { id, body: 'parent: #100' };
          if (id === 100) return { id, body: 'parent: #200' };
          if (id === 200) return { id, body: '' };
          return { id, body: '' };
        },
      };
      await groupByAncestor([10, 20], provider);
      // #10 walks 10→100→200 (3 reads). #20 should re-read itself (#20)
      // but reuse the cached chain starting at #100, so #100 and #200 are
      // not re-read for the second parent.
      const count100 = reads.filter((r) => r === 100).length;
      const count200 = reads.filter((r) => r === 200).length;
      assert.equal(count100, 1, `expected #100 read once, got ${count100}`);
      assert.equal(count200, 1, `expected #200 read once, got ${count200}`);
    },
  );
});
