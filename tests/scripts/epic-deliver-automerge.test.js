// tests/scripts/epic-deliver-automerge.test.js
/**
 * Unit tests for the thin-shim `epic-deliver-automerge.js`
 * (Story #2336 / Task #2340 / Epic #2306).
 *
 * After Task #2340 collapsed the CLI to a pure emit shim, only
 * `runEpicDeliverAutomerge` is exported. The merge-lockout invariant
 * (zero `gh pr merge` literals outside `automerge-armer.js`) is
 * enforced by the lifecycle lint rule and pinned at the contract tier
 * by `tests/lib/orchestration/lifecycle/merge-gate-ordering.test.js`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runEpicDeliverAutomerge } from '../../.agents/scripts/epic-deliver-automerge.js';
import { Bus } from '../../.agents/scripts/lib/orchestration/lifecycle/bus.js';

describe('runEpicDeliverAutomerge (thin shim)', () => {
  it('emits epic.automerge.start onto the supplied bus and returns the seqId', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.automerge.start', async (ctx) =>
      emits.push({ event: ctx.event, payload: ctx.payload }),
    );
    const out = await runEpicDeliverAutomerge({
      epicId: 1178,
      prNumber: 1272,
      bus,
    });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.automerge.start');
    assert.match(emits[0].payload.prUrl, /1272/);
    assert.equal(out.epicId, 1178);
    assert.equal(out.prNumber, 1272);
    assert.equal(typeof out.seqId, 'number');
  });

  it('rejects invalid arguments', async () => {
    await assert.rejects(
      () => runEpicDeliverAutomerge({ epicId: 0, prNumber: 1 }),
      /epicId must be a positive integer/,
    );
    await assert.rejects(
      () => runEpicDeliverAutomerge({ epicId: 1, prNumber: 0 }),
      /prNumber must be a positive integer/,
    );
  });
});
