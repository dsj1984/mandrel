/**
 * Unit tests for the plan-persist Epic **adoption** path (Story #5155),
 * covering the read-then-PATCH window Story #5280 narrows.
 *
 * The checklist write is a whole-body PATCH, so a stale base is not a merge
 * conflict — it is a silent revert of everything another writer added in
 * between. These tests pin that the base is re-read `fresh` immediately before
 * the write, and that the write is skipped when it would change nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adoptContainerEpic } from '../../../.agents/scripts/lib/orchestration/plan-persist/epic-adoption.js';

/**
 * A provider double whose `getTicket` can answer differently depending on
 * whether the caller asked for a cached or a fresh read — which is the entire
 * property under test.
 */
function provider({ freshBody, cachedBody }) {
  const reads = [];
  const updates = [];
  return {
    reads,
    updates,
    async getTicket(id, opts = {}) {
      reads.push({ id, fresh: opts.fresh === true });
      return {
        id,
        body: opts.fresh ? freshBody : cachedBody,
        labels: ['type::epic'],
        state: 'open',
      };
    },
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
    },
    // No sub-issue write surface: `mirrorSubIssueEdges` warns and returns
    // null, which keeps these tests about the checklist half alone.
  };
}

const target = (body) => ({ id: 90, title: 'Container', body });

describe('adoptContainerEpic — the checklist base is re-read fresh', () => {
  it('re-reads the Epic with fresh: true immediately before the PATCH', async () => {
    const p = provider({
      cachedBody: '## Stories\n\n- [ ] #1\n',
      freshBody: '## Stories\n\n- [ ] #1\n',
    });

    await adoptContainerEpic({
      provider: p,
      target: target('## Stories\n\n- [ ] #1\n'),
      created: [{ id: 500 }],
    });

    assert.deepEqual(
      p.reads,
      [{ id: 90, fresh: true }],
      'a cached read would hand back the snapshot this exists to replace',
    );
  });

  it('keeps a child another writer added after the snapshot was taken', async () => {
    // The live shape: `resolveAdoptionTarget` read the body before the first
    // Story was created. On a cohort of any size that is many seconds and
    // several writes ago, and a concurrent persist run — or an operator
    // linking a child by hand — has since appended to the same body.
    const p = provider({
      cachedBody: '## Stories\n\n- [ ] #1\n',
      freshBody: '## Stories\n\n- [ ] #1\n- [ ] #2\n',
    });

    await adoptContainerEpic({
      provider: p,
      target: target('## Stories\n\n- [ ] #1\n'),
      created: [{ id: 500 }],
    });

    assert.equal(p.updates.length, 1);
    const body = p.updates[0].mutations.body;
    assert.match(body, /- \[ \] #2/, "the other writer's child survives");
    assert.match(body, /- \[ \] #500/, "the run's own child is appended");
    assert.match(body, /- \[ \] #1/);
  });

  it('writes nothing when the fresh body already lists every child', async () => {
    // Re-running an adoption that already landed must be a true no-op, not a
    // rewrite of an identical body.
    const listed = '## Stories\n\n- [ ] #1\n- [ ] #500\n';
    const p = provider({ cachedBody: listed, freshBody: listed });

    await adoptContainerEpic({
      provider: p,
      target: target('## Stories\n\n- [ ] #1\n'),
      created: [{ id: 500 }],
    });

    assert.deepEqual(p.updates, [], 'no PATCH when the append changes nothing');
  });

  it('falls back to the snapshot when the fresh re-read throws', async () => {
    // A stale base still appends this run's own children, which beats not
    // linking them at all.
    const p = provider({
      cachedBody: '## Stories\n\n- [ ] #1\n',
      freshBody: '## Stories\n\n- [ ] #1\n',
    });
    p.getTicket = async () => {
      throw new Error('HTTP 502');
    };

    await adoptContainerEpic({
      provider: p,
      target: target('## Stories\n\n- [ ] #1\n'),
      created: [{ id: 500 }],
    });

    assert.equal(p.updates.length, 1);
    assert.match(p.updates[0].mutations.body, /- \[ \] #500/);
  });
});
