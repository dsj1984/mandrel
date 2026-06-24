/**
 * hierarchy-tracer.test.js — Story #4253 (thread --prd/--tech-spec to skip getEpic).
 *
 * Colocated under the module's `__tests__/` directory per the named
 * `/single-story-deliver` Verify command for this Story and the unit-tier
 * colocation convention in `rules/testing-standards.md`.
 *
 * The binding assertion is a `getEpic` call count: when the /deliver fan-out
 * threads both pre-resolved ids in (`input.prdId` + `input.techSpecId`), the
 * tracer MUST short-circuit and issue **zero** `getEpic` round-trips. When
 * either id is absent it falls back to the legacy single `getEpic` resolution,
 * preserving its graceful degradation on a missing Epic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { traceHierarchy } from '../hierarchy-tracer.js';

/**
 * Recording provider whose `getEpic` counts every call and returns a fixed
 * linkedIssues map. The call count is the contract under test.
 */
function makeRecordingProvider({ prd = 7001, techSpec = 7002 } = {}) {
  const calls = { getEpic: [] };
  return {
    calls,
    async getEpic(epicId) {
      calls.getEpic.push(epicId);
      return { linkedIssues: { prd, techSpec } };
    },
  };
}

/** A logger that swallows warnings so the fetch-failure path stays quiet. */
const silentLogger = { warn: () => {} };

describe('traceHierarchy', () => {
  it('short-circuits with zero getEpic calls when both ids are threaded', async () => {
    const provider = makeRecordingProvider();

    const result = await traceHierarchy({
      provider,
      logger: silentLogger,
      input: { epicId: 100, prdId: 42, techSpecId: 43 },
    });

    assert.equal(
      provider.calls.getEpic.length,
      0,
      'getEpic must not be called when both --prd and --tech-spec are supplied',
    );
    assert.deepEqual(result, { prdId: 42, techSpecId: 43 });
  });

  it('falls back to getEpic when no ids are threaded (legacy path)', async () => {
    const provider = makeRecordingProvider({ prd: 5001, techSpec: 5002 });

    const result = await traceHierarchy({
      provider,
      logger: silentLogger,
      input: { epicId: 100 },
    });

    assert.equal(provider.calls.getEpic.length, 1);
    assert.deepEqual(result, { prdId: 5001, techSpecId: 5002 });
  });

  it('falls back to getEpic when only --prd is supplied (partial)', async () => {
    const provider = makeRecordingProvider({ prd: 5001, techSpec: 5002 });

    const result = await traceHierarchy({
      provider,
      logger: silentLogger,
      input: { epicId: 100, prdId: 42, techSpecId: null },
    });

    assert.equal(
      provider.calls.getEpic.length,
      1,
      'a partial threading (one id missing) must still resolve via getEpic',
    );
    assert.deepEqual(result, { prdId: 5001, techSpecId: 5002 });
  });

  it('falls back to getEpic when only --tech-spec is supplied (partial)', async () => {
    const provider = makeRecordingProvider({ prd: 5001, techSpec: 5002 });

    const result = await traceHierarchy({
      provider,
      logger: silentLogger,
      input: { epicId: 100, prdId: null, techSpecId: 43 },
    });

    assert.equal(provider.calls.getEpic.length, 1);
    assert.deepEqual(result, { prdId: 5001, techSpecId: 5002 });
  });

  it('degrades gracefully (null linkages) when getEpic throws on the legacy path', async () => {
    const provider = {
      calls: { getEpic: [] },
      async getEpic(epicId) {
        this.calls.getEpic.push(epicId);
        throw new Error('boom');
      },
    };

    const result = await traceHierarchy({
      provider,
      logger: silentLogger,
      input: { epicId: 100 },
    });

    assert.equal(provider.calls.getEpic.length, 1);
    assert.deepEqual(result, { prdId: null, techSpecId: null });
  });
});
