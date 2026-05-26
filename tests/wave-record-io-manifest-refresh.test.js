/**
 * wave-record-io-manifest-refresh.test.js
 *
 * Story #3026 — verifies that `refreshDispatchManifest` runs in-process
 * (no `child_process.spawn` / `spawnSync`) and produces a comment body
 * byte-identical to the helper-rendered output.
 */

import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import { describe, it, mock } from 'node:test';

import { renderManifestFromManifest } from '../.agents/scripts/lib/presentation/dispatch-manifest-render.js';
import { refreshDispatchManifest } from '../.agents/scripts/lib/orchestration/wave-record-io.js';

const FIXTURE_MANIFEST = {
  epicId: 4242,
  generatedAt: '2026-05-26T14:00:00.000Z',
  type: 'epic',
  storyManifest: [
    {
      storyId: 4101,
      storyTitle: 'Refresh story A',
      type: 'story',
      earliestWave: 0,
    },
    {
      storyId: 4102,
      storyTitle: 'Refresh story B',
      type: 'story',
      earliestWave: 1,
    },
  ],
};

function buildProvider() {
  return {
    postComment: mock.fn(async () => ({ id: 99 })),
  };
}

describe('refreshDispatchManifest', () => {
  it('renders + upserts the dispatch-manifest comment in-process', async () => {
    const provider = buildProvider();
    const dispatch = mock.fn(async () => FIXTURE_MANIFEST);
    const upsertComment = mock.fn(async () => ({ commentId: 1 }));
    const persist = mock.fn(() => {});

    const result = await refreshDispatchManifest({
      epicId: FIXTURE_MANIFEST.epicId,
      provider,
      dispatch,
      upsertComment,
      persist,
    });

    assert.equal(result.posted, true);
    assert.equal(result.epicId, FIXTURE_MANIFEST.epicId);
    assert.equal(result.body, renderManifestFromManifest(FIXTURE_MANIFEST));

    assert.equal(dispatch.mock.callCount(), 1);
    const dispatchArg = dispatch.mock.calls[0].arguments[0];
    assert.equal(dispatchArg.ticketId, FIXTURE_MANIFEST.epicId);
    assert.equal(dispatchArg.dryRun, true);
    assert.strictEqual(dispatchArg.provider, provider);

    assert.equal(persist.mock.callCount(), 1);
    assert.strictEqual(persist.mock.calls[0].arguments[0], FIXTURE_MANIFEST);

    assert.equal(upsertComment.mock.callCount(), 1);
    const [calledProvider, ticketId, type, body] =
      upsertComment.mock.calls[0].arguments;
    assert.strictEqual(calledProvider, provider);
    assert.equal(ticketId, FIXTURE_MANIFEST.epicId);
    assert.equal(type, 'dispatch-manifest');
    assert.equal(body, renderManifestFromManifest(FIXTURE_MANIFEST));
  });

  it('never invokes child_process.spawn or spawnSync', async () => {
    const spawnSpy = mock.method(child_process, 'spawn', () => {
      throw new Error(
        'refreshDispatchManifest must not call child_process.spawn',
      );
    });
    const spawnSyncSpy = mock.method(child_process, 'spawnSync', () => {
      throw new Error(
        'refreshDispatchManifest must not call child_process.spawnSync',
      );
    });

    try {
      await refreshDispatchManifest({
        epicId: FIXTURE_MANIFEST.epicId,
        provider: buildProvider(),
        dispatch: async () => FIXTURE_MANIFEST,
        upsertComment: async () => ({ commentId: 1 }),
        persist: () => {},
      });
    } finally {
      spawnSpy.mock.restore();
      spawnSyncSpy.mock.restore();
    }

    assert.equal(spawnSpy.mock.callCount(), 0);
    assert.equal(spawnSyncSpy.mock.callCount(), 0);
  });

  it('returns {posted:false, reason:"no-provider"} when no provider is supplied', async () => {
    const result = await refreshDispatchManifest({
      epicId: FIXTURE_MANIFEST.epicId,
      dispatch: async () => FIXTURE_MANIFEST,
      persist: () => {},
    });
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'no-provider');
    assert.equal(result.body, renderManifestFromManifest(FIXTURE_MANIFEST));
  });

  it('downgrades comment upsert failures to a non-fatal {posted:false} result', async () => {
    const result = await refreshDispatchManifest({
      epicId: FIXTURE_MANIFEST.epicId,
      provider: buildProvider(),
      dispatch: async () => FIXTURE_MANIFEST,
      upsertComment: async () => {
        throw new Error('github 502');
      },
      persist: () => {},
    });
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'github 502');
  });

  it('rejects non-positive epicId inputs', async () => {
    await assert.rejects(
      () => refreshDispatchManifest({ epicId: 0 }),
      /epicId must be a positive integer/,
    );
    await assert.rejects(
      () => refreshDispatchManifest({}),
      /epicId must be a positive integer/,
    );
  });
});
