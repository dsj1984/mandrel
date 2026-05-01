import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CONCURRENCY,
  resolveConcurrency,
} from '../.agents/scripts/lib/orchestration/concurrency.js';
import { CommitAssertion } from '../.agents/scripts/lib/orchestration/epic-runner/commit-assertion.js';
import { ProgressReporter } from '../.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js';
import { createRuntimeContext } from '../.agents/scripts/lib/runtime-context.js';
import { runWaveGate } from '../.agents/scripts/wave-gate.js';

// ---------------------------------------------------------------------------
// resolveConcurrency — default fallback + coercion contract
// ---------------------------------------------------------------------------

describe('resolveConcurrency — defaults preserve v5.21.0 constants', () => {
  it('returns DEFAULT_CONCURRENCY when source is null / undefined / not-an-object', () => {
    assert.deepEqual(resolveConcurrency(null), DEFAULT_CONCURRENCY);
    assert.deepEqual(resolveConcurrency(undefined), DEFAULT_CONCURRENCY);
    assert.deepEqual(resolveConcurrency(42), DEFAULT_CONCURRENCY);
    assert.deepEqual(resolveConcurrency('foo'), DEFAULT_CONCURRENCY);
  });

  it('returns defaults when orchestration lacks a concurrency block', () => {
    assert.deepEqual(
      resolveConcurrency({ provider: 'github' }),
      DEFAULT_CONCURRENCY,
    );
  });

  it('DEFAULT_CONCURRENCY matches the v5.21.0 constants', () => {
    assert.equal(DEFAULT_CONCURRENCY.waveGate, 0);
    assert.equal(DEFAULT_CONCURRENCY.commitAssertion, 4);
    assert.equal(DEFAULT_CONCURRENCY.progressReporter, 8);
  });

  it('DEFAULT_CONCURRENCY is frozen', () => {
    assert.throws(() => {
      DEFAULT_CONCURRENCY.waveGate = 999;
    });
  });
});

describe('resolveConcurrency — overrides flow through', () => {
  it('accepts the orchestration block carrying runners.concurrency', () => {
    const out = resolveConcurrency({
      runners: {
        concurrency: {
          waveGate: 12,
          commitAssertion: 2,
          progressReporter: 16,
        },
      },
    });
    assert.deepEqual(out, {
      waveGate: 12,
      commitAssertion: 2,
      progressReporter: 16,
    });
  });

  it('accepts a pre-narrowed concurrency block', () => {
    const out = resolveConcurrency({
      waveGate: 4,
      commitAssertion: 6,
      progressReporter: 10,
    });
    assert.equal(out.waveGate, 4);
    assert.equal(out.commitAssertion, 6);
    assert.equal(out.progressReporter, 10);
  });

  it('falls back per-field on malformed overrides', () => {
    const out = resolveConcurrency({
      runners: {
        concurrency: {
          waveGate: -5,
          commitAssertion: 0,
          progressReporter: Number.NaN,
        },
      },
    });
    // Negative waveGate → default 0. commitAssertion 0 violates ≥1 → 4.
    // NaN → 8.
    assert.deepEqual(out, DEFAULT_CONCURRENCY);
  });

  it('returns a frozen object', () => {
    const out = resolveConcurrency({
      runners: { concurrency: { waveGate: 5 } },
    });
    assert.throws(() => {
      out.waveGate = 999;
    });
  });
});

// ---------------------------------------------------------------------------
// createRuntimeContext — ctx.concurrency wiring
// ---------------------------------------------------------------------------

describe('createRuntimeContext — ctx.concurrency', () => {
  it('exposes DEFAULT_CONCURRENCY when no overrides are supplied', () => {
    const ctx = createRuntimeContext();
    assert.deepEqual(ctx.concurrency, DEFAULT_CONCURRENCY);
  });

  it('resolves from overrides.orchestration', () => {
    const ctx = createRuntimeContext({
      orchestration: {
        runners: {
          concurrency: {
            waveGate: 7,
            commitAssertion: 3,
            progressReporter: 12,
          },
        },
      },
    });
    assert.equal(ctx.concurrency.waveGate, 7);
    assert.equal(ctx.concurrency.commitAssertion, 3);
    assert.equal(ctx.concurrency.progressReporter, 12);
  });

  it('overrides.concurrency takes precedence over overrides.orchestration', () => {
    const ctx = createRuntimeContext({
      concurrency: { waveGate: 99, commitAssertion: 99, progressReporter: 99 },
      orchestration: {
        runners: {
          concurrency: { waveGate: 1, commitAssertion: 1, progressReporter: 1 },
        },
      },
    });
    assert.equal(ctx.concurrency.waveGate, 99);
  });

  it('preserves v5.21.0 behaviour when no orchestration block at all', () => {
    const ctx = createRuntimeContext({ orchestration: null });
    assert.deepEqual(ctx.concurrency, DEFAULT_CONCURRENCY);
  });
});

// ---------------------------------------------------------------------------
// CommitAssertion — cap derived from ctx.concurrency.commitAssertion
// ---------------------------------------------------------------------------

describe('CommitAssertion — concurrency cap wiring', () => {
  async function probeMaxInFlight({ ctxOpts, explicitOpts, ids }) {
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = [];
    const adapter = async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((resolve) => {
        gates.push(resolve);
      });
      inFlight--;
      return 1;
    };
    const assertion = new CommitAssertion({
      gitAdapter: adapter,
      ...ctxOpts,
      ...explicitOpts,
    });
    const pending = assertion.check(ids, { epicId: 1 });
    // Wait until the gates saturate or all items fit within the cap.
    const target = Math.min(
      ids.length,
      explicitOpts?.concurrency ??
        ctxOpts?.ctx?.concurrency?.commitAssertion ??
        DEFAULT_CONCURRENCY.commitAssertion,
    );
    while (gates.length < target) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(gates.length, target);
    while (gates.length > 0) {
      const batch = gates.splice(0, gates.length);
      for (const release of batch) release();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    await pending;
    return maxInFlight;
  }

  it('defaults to 4 in-flight adapter calls when ctx is absent (v5.21.0 preservation)', async () => {
    const max = await probeMaxInFlight({
      ctxOpts: {},
      ids: Array.from({ length: 10 }, (_, i) => 1000 + i),
    });
    assert.equal(max, 4);
  });

  it('honours ctx.concurrency.commitAssertion = 2', async () => {
    const max = await probeMaxInFlight({
      ctxOpts: {
        ctx: {
          gitAdapter: null,
          logger: { warn: () => {} },
          concurrency: { commitAssertion: 2 },
        },
      },
      ids: Array.from({ length: 10 }, (_, i) => 2000 + i),
    });
    assert.equal(max, 2);
  });

  it('explicit opts.concurrency overrides ctx.concurrency.commitAssertion', async () => {
    const max = await probeMaxInFlight({
      ctxOpts: {
        ctx: {
          gitAdapter: null,
          logger: { warn: () => {} },
          concurrency: { commitAssertion: 8 },
        },
      },
      explicitOpts: { concurrency: 3 },
      ids: Array.from({ length: 10 }, (_, i) => 3000 + i),
    });
    assert.equal(max, 3);
  });

  it('falls back to default when ctx.concurrency.commitAssertion is malformed', async () => {
    // Malformed ctx values (e.g. -1) must fall back to DEFAULT_CONCURRENCY.
    // Verified via the constructor-exposed `concurrency` field rather than a
    // live probe because the probe's saturation assertion can't read the
    // fallback value from inside the helper.
    const assertion = new CommitAssertion({
      gitAdapter: async () => 0,
      ctx: {
        concurrency: { commitAssertion: -1 },
      },
    });
    assert.equal(assertion.concurrency, DEFAULT_CONCURRENCY.commitAssertion);
  });
});

// ---------------------------------------------------------------------------
// ProgressReporter — cap derived from ctx.concurrency.progressReporter
// ---------------------------------------------------------------------------

describe('ProgressReporter — concurrency cap wiring', () => {
  function buildReporter({ ctxConcurrency, explicitCap, storyIds }) {
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = {
      async getTicket(id) {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield multiple turns so the concurrency cap has a chance to bite.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return { id, state: 'open', labels: [], title: `Story #${id}` };
      },
    };
    const reporter = new ProgressReporter({
      provider,
      epicId: 500,
      intervalSec: 0,
      logger: { info: () => {}, warn: () => {} },
      ctx: ctxConcurrency
        ? { provider, epicId: 500, concurrency: ctxConcurrency }
        : undefined,
      ...(explicitCap != null ? { concurrency: explicitCap } : {}),
      // Disable comment upsert by throwing silently — reporter warn-swallows.
    });
    // Provide stub upsert via provider to avoid real HTTP surface.
    provider.upsertStructuredComment = async () => {};
    // The reporter calls upsertStructuredComment via the ticketing module;
    // stub the comment fetch methods too so we don't hit the real path.
    provider.getTicketComments = async () => [];
    provider.updateComment = async () => {};
    provider.createComment = async () => ({ id: 1 });
    reporter.setWave({
      index: 0,
      totalWaves: 1,
      stories: storyIds,
    });
    return { reporter, getMax: () => maxInFlight };
  }

  it('defaults to 8 concurrent ticket reads when ctx is absent', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => 6000 + i);
    const { reporter, getMax } = buildReporter({ storyIds: ids });
    await reporter.fire();
    assert.equal(getMax(), 8);
  });

  it('honours ctx.concurrency.progressReporter = 3', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => 7000 + i);
    const { reporter, getMax } = buildReporter({
      ctxConcurrency: { progressReporter: 3 },
      storyIds: ids,
    });
    await reporter.fire();
    assert.equal(getMax(), 3);
  });

  it('explicit opts.concurrency overrides ctx.concurrency.progressReporter', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => 8000 + i);
    const { reporter, getMax } = buildReporter({
      ctxConcurrency: { progressReporter: 16 },
      explicitCap: 2,
      storyIds: ids,
    });
    await reporter.fire();
    assert.equal(getMax(), 2);
  });
});

// ---------------------------------------------------------------------------
// sprint-wave-gate — waveGate cap affects the fanout
// ---------------------------------------------------------------------------

function manifestComment(stories) {
  const body = [
    '<!-- ap:structured-comment type="dispatch-manifest" -->',
    '```json',
    JSON.stringify({ stories }),
    '```',
  ].join('\n');
  return { id: 1, body };
}

class CountingProvider {
  constructor({ tickets, comments }) {
    this.tickets = tickets;
    this.comments = comments;
    this.inFlight = 0;
    this.maxInFlight = 0;
  }
  async getTicketComments() {
    return this.comments;
  }
  async getTicket(id) {
    this.inFlight++;
    if (this.inFlight > this.maxInFlight) this.maxInFlight = this.inFlight;
    // yield a few turns so the cap has time to bite
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    this.inFlight--;
    const t = this.tickets[id];
    if (!t) throw new Error(`missing ${id}`);
    return { ...t };
  }
}

describe('sprint-wave-gate — waveGate cap', () => {
  it('omitting concurrency (default 0) keeps Promise.all fanout — all N starts before any resolves', async () => {
    const storyIds = Array.from({ length: 12 }, (_, i) => 9000 + i);
    const tickets = Object.fromEntries(
      storyIds.map((id) => [id, { id, state: 'closed' }]),
    );
    const provider = new CountingProvider({
      tickets,
      comments: [
        manifestComment(
          storyIds.map((id) => ({ storyId: id, title: `S${id}`, wave: 1 })),
        ),
      ],
    });
    await runWaveGate({ epicId: 1, injectedProvider: provider });
    // Uncapped fanout: every call starts before any finishes → max = N.
    assert.equal(provider.maxInFlight, storyIds.length);
  });

  it('honours waveGate = 3 by capping in-flight provider reads', async () => {
    const storyIds = Array.from({ length: 12 }, (_, i) => 10000 + i);
    const tickets = Object.fromEntries(
      storyIds.map((id) => [id, { id, state: 'closed' }]),
    );
    const provider = new CountingProvider({
      tickets,
      comments: [
        manifestComment(
          storyIds.map((id) => ({ storyId: id, title: `S${id}`, wave: 1 })),
        ),
      ],
    });
    await runWaveGate({
      epicId: 1,
      injectedProvider: provider,
      injectedConcurrency: {
        waveGate: 3,
        commitAssertion: 4,
        progressReporter: 8,
      },
    });
    assert.ok(
      provider.maxInFlight <= 3,
      `expected maxInFlight ≤ 3 under waveGate=3, got ${provider.maxInFlight}`,
    );
    assert.ok(
      provider.maxInFlight >= 2,
      `expected the cap to be saturated (≥2), got ${provider.maxInFlight}`,
    );
  });
});
