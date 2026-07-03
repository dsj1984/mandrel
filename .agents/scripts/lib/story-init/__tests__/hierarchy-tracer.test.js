/**
 * hierarchy-tracer.test.js — Story #4253 (thread --tech-spec to skip getEpic).
 *
 * Colocated under the module's `__tests__/` directory per the named
 * `/single-story-deliver` Verify command for this Story and the unit-tier
 * colocation convention in `rules/testing-standards.md`.
 *
 * The binding assertion is a `getEpic` call count: when the /deliver fan-out
 * threads the pre-resolved id in (`input.techSpecId`), the tracer MUST
 * short-circuit and issue **zero** `getEpic` round-trips. When the id is
 * absent it falls back to the legacy single `getEpic` resolution, preserving
 * its graceful degradation on a missing Epic.
 *
 * Story #4314 retired the PRD artifact class, so only the Tech Spec is traced
 * and threaded — the tracer no longer resolves or returns a `prdId`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { traceHierarchy } from '../hierarchy-tracer.js';

/**
 * Recording provider whose `getEpic` counts every call and returns a fixed
 * linkedIssues map. The call count is the contract under test.
 */
function makeRecordingProvider({ techSpec = 7002 } = {}) {
  const calls = { getEpic: [] };
  return {
    calls,
    async getEpic(epicId) {
      calls.getEpic.push(epicId);
      return { linkedIssues: { techSpec } };
    },
  };
}

/** A logger that swallows warnings so the fetch-failure path stays quiet. */
const silentLogger = { warn: () => {} };

describe('traceHierarchy', () => {
  it('short-circuits with zero getEpic calls when the tech-spec id is threaded', async () => {
    const provider = makeRecordingProvider();

    const result = await traceHierarchy({
      provider,
      logger: silentLogger,
      input: { epicId: 100, techSpecId: 43 },
    });

    assert.equal(
      provider.calls.getEpic.length,
      0,
      'getEpic must not be called when --tech-spec is supplied',
    );
    assert.deepEqual(result, { techSpecId: 43 });
  });

  it('falls back to getEpic when no id is threaded (legacy path)', async () => {
    const provider = makeRecordingProvider({ techSpec: 5002 });

    const result = await traceHierarchy({
      provider,
      logger: silentLogger,
      input: { epicId: 100 },
    });

    assert.equal(provider.calls.getEpic.length, 1);
    assert.deepEqual(result, { techSpecId: 5002 });
  });

  it('falls back to getEpic when the tech-spec id is null', async () => {
    const provider = makeRecordingProvider({ techSpec: 5002 });

    const result = await traceHierarchy({
      provider,
      logger: silentLogger,
      input: { epicId: 100, techSpecId: null },
    });

    assert.equal(
      provider.calls.getEpic.length,
      1,
      'an absent threaded id must still resolve via getEpic',
    );
    assert.deepEqual(result, { techSpecId: 5002 });
  });

  it('degrades gracefully (null linkage) when getEpic throws on the legacy path', async () => {
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
    assert.deepEqual(result, { techSpecId: null });
  });
});
