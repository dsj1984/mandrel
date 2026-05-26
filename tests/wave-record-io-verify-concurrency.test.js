// tests/wave-record-io-verify-concurrency.test.js
/**
 * Story #3024 / Task #3031 — bounded-concurrency verifyWaveResults.
 *
 * Confirms:
 *   - Results array larger than the cap completes with one outcome per
 *     row, preserving input order and the same discrepancy surface the
 *     serial implementation produced.
 *   - A per-row `provider.getTicket` throw degrades that row to a
 *     `verify-error` discrepancy rather than aborting the whole wave.
 *   - The cap is honoured at runtime: never more than `cap` mappers in
 *     flight at once.
 *   - The default cap is 4 when `concurrencyCap` is omitted.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { verifyWaveResults } from '../.agents/scripts/lib/orchestration/wave-record-io.js';

/**
 * Build a provider whose `getTicket` is gated on a manually-released
 * promise per story. Returns the provider + a `release(storyId, ticket)`
 * helper plus an `inFlight()` probe so the test can assert the cap.
 */
function buildGatedProvider() {
  const gates = new Map(); // storyId → { resolve, reject, promise }
  let inFlight = 0;
  let maxInFlight = 0;
  const provider = {
    async getTicket(storyId) {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        let gate = gates.get(storyId);
        if (!gate) {
          gate = {};
          gate.promise = new Promise((resolve, reject) => {
            gate.resolve = resolve;
            gate.reject = reject;
          });
          gates.set(storyId, gate);
        }
        const outcome = await gate.promise;
        if (outcome && outcome.throw) throw outcome.throw;
        return outcome.ticket;
      } finally {
        inFlight -= 1;
      }
    },
  };
  return {
    provider,
    release(storyId, ticket) {
      let gate = gates.get(storyId);
      if (!gate) {
        gate = {};
        gate.promise = new Promise((resolve, reject) => {
          gate.resolve = resolve;
          gate.reject = reject;
        });
        gates.set(storyId, gate);
      }
      gate.resolve({ ticket });
    },
    failWith(storyId, err) {
      let gate = gates.get(storyId);
      if (!gate) {
        gate = {};
        gate.promise = new Promise((resolve, reject) => {
          gate.resolve = resolve;
          gate.reject = reject;
        });
        gates.set(storyId, gate);
      }
      gate.resolve({ throw: err });
    },
    maxInFlight: () => maxInFlight,
  };
}

/** Build a simple non-gated provider that returns a label map synchronously. */
function buildLabelMapProvider(labelsByStory, throwForStory) {
  return {
    async getTicket(storyId) {
      if (throwForStory && throwForStory.has(storyId)) {
        throw throwForStory.get(storyId);
      }
      const labels = labelsByStory.get(storyId) ?? ['agent::done'];
      return { labels, state: 'open' };
    },
  };
}

describe('verifyWaveResults — bounded concurrency (Story #3024)', () => {
  it('verifies every Story when results length exceeds cap, preserving discrepancies', async () => {
    const results = [];
    for (let i = 0; i < 10; i += 1) {
      results.push({ storyId: 100 + i, status: 'done' });
    }
    // Half the rows are *not* actually done on GitHub → discrepancy.
    const labelsByStory = new Map();
    for (let i = 0; i < 10; i += 1) {
      labelsByStory.set(100 + i, i % 2 === 0 ? ['agent::done'] : ['agent::executing']);
    }
    const provider = buildLabelMapProvider(labelsByStory);
    const { verified, discrepancies } = await verifyWaveResults({
      provider,
      results,
      concurrencyCap: 3,
    });
    assert.equal(verified.length, 10, 'one verified row per input');
    // Order preserved: storyIds in input order.
    for (let i = 0; i < 10; i += 1) {
      assert.equal(verified[i].storyId, 100 + i);
    }
    // Five odd-indexed Stories should be discrepancies.
    assert.equal(discrepancies.length, 5);
    const disStoryIds = discrepancies.map((d) => d.storyId).sort((a, b) => a - b);
    assert.deepEqual(disStoryIds, [101, 103, 105, 107, 109]);
    for (const d of discrepancies) {
      assert.equal(d.claimed, 'done');
      assert.equal(d.actual, 'agent::executing');
    }
    // Verified rows for the discrepant Stories are downgraded to failed.
    for (const sid of [101, 103, 105, 107, 109]) {
      const row = verified.find((r) => r.storyId === sid);
      assert.equal(row.status, 'failed');
    }
  });

  it('continues verifying other Stories when one provider.getTicket throws', async () => {
    const results = [
      { storyId: 200, status: 'done' },
      { storyId: 201, status: 'done' },
      { storyId: 202, status: 'done' },
    ];
    const labelsByStory = new Map([
      [200, ['agent::done']],
      // 201 → throws
      [202, ['agent::done']],
    ]);
    const throwForStory = new Map([[201, new Error('boom-network')]]);
    const provider = buildLabelMapProvider(labelsByStory, throwForStory);

    const { verified, discrepancies } = await verifyWaveResults({
      provider,
      results,
      concurrencyCap: 2,
    });
    assert.equal(verified.length, 3, 'all three rows present');
    // Order preserved.
    assert.deepEqual(
      verified.map((r) => r.storyId),
      [200, 201, 202],
    );
    // The throwing row is the only discrepancy.
    assert.equal(discrepancies.length, 1);
    assert.equal(discrepancies[0].storyId, 201);
    assert.equal(discrepancies[0].actual, 'verify-error');
    assert.equal(discrepancies[0].verifyError, 'boom-network');
    // Row 201 downgraded to failed + carries verifyError.
    assert.equal(verified[1].status, 'failed');
    assert.equal(verified[1].verifyError, 'boom-network');
    // Rows 200 / 202 remain done.
    assert.equal(verified[0].status, 'done');
    assert.equal(verified[2].status, 'done');
  });

  it('honours the concurrencyCap at runtime', async () => {
    const cap = 2;
    const n = 6;
    const results = [];
    for (let i = 0; i < n; i += 1) {
      results.push({ storyId: 300 + i, status: 'done' });
    }
    const gate = buildGatedProvider();

    // Kick off verifyWaveResults; do not await yet — we need to release gates.
    const verifyPromise = verifyWaveResults({
      provider: gate.provider,
      results,
      concurrencyCap: cap,
    });

    // Give the scheduler a turn to spin up the first batch of workers.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      gate.maxInFlight() <= cap,
      `inFlight (${gate.maxInFlight()}) must never exceed cap (${cap})`,
    );

    // Release every gate so the test terminates.
    for (let i = 0; i < n; i += 1) {
      gate.release(300 + i, { labels: ['agent::done'], state: 'open' });
    }
    const { verified, discrepancies } = await verifyPromise;
    assert.equal(verified.length, n);
    assert.equal(discrepancies.length, 0);
    assert.ok(
      gate.maxInFlight() <= cap,
      `inFlight (${gate.maxInFlight()}) must never exceed cap (${cap}) across the full run`,
    );
  });

  it('defaults the cap to 4 when concurrencyCap is omitted', async () => {
    const cap = 4;
    const n = 8;
    const results = [];
    for (let i = 0; i < n; i += 1) {
      results.push({ storyId: 400 + i, status: 'done' });
    }
    const gate = buildGatedProvider();

    const verifyPromise = verifyWaveResults({
      provider: gate.provider,
      results,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      gate.maxInFlight() <= cap,
      `inFlight (${gate.maxInFlight()}) must never exceed default cap (${cap})`,
    );
    assert.equal(
      gate.maxInFlight(),
      cap,
      `expected default cap (${cap}) workers to be in flight, saw ${gate.maxInFlight()}`,
    );
    for (let i = 0; i < n; i += 1) {
      gate.release(400 + i, { labels: ['agent::done'], state: 'open' });
    }
    const { verified } = await verifyPromise;
    assert.equal(verified.length, n);
  });

  it('passes through rows whose status is not done without calling getTicket', async () => {
    let callCount = 0;
    const provider = {
      async getTicket() {
        callCount += 1;
        return { labels: ['agent::done'], state: 'open' };
      },
    };
    const results = [
      { storyId: 500, status: 'blocked' },
      { storyId: 501, status: 'failed' },
      { storyId: 502, status: 'done' },
    ];
    const { verified, discrepancies } = await verifyWaveResults({
      provider,
      results,
      concurrencyCap: 4,
    });
    assert.equal(callCount, 1, 'only the done row triggers a fetch');
    assert.equal(verified.length, 3);
    assert.equal(discrepancies.length, 0);
    assert.equal(verified[0].status, 'blocked');
    assert.equal(verified[1].status, 'failed');
    assert.equal(verified[2].status, 'done');
  });

  it('returns inputs unchanged when provider has no getTicket', async () => {
    const results = [
      { storyId: 600, status: 'done' },
      { storyId: 601, status: 'done' },
    ];
    const out = await verifyWaveResults({ provider: {}, results });
    assert.deepEqual(out.verified, results);
    assert.deepEqual(out.discrepancies, []);
  });
});
