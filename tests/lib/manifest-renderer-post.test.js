/**
 * Tests for the comment-persistence side of manifest-renderer.js:
 *
 *   - postManifestEpicComment        (lines 84-138)
 *   - postParkedFollowOnsComment     (lines 140-202)
 *
 * Both functions are wrappers around `upsertStructuredComment` from
 * `lib/orchestration/ticketing.js`. The latter calls
 * `findStructuredComment` then `provider.postComment` — tests pass
 * fully stubbed providers so no real network or filesystem touches.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  postManifestEpicComment,
  postParkedFollowOnsComment,
} from '../../.agents/scripts/lib/presentation/manifest-renderer.js';

function buildProvider(overrides = {}) {
  return {
    // upsertStructuredComment → findStructuredComment → getTicketComments.
    getTicketComments: mock.fn(async () => []),
    postComment: mock.fn(async () => ({ id: 1 })),
    getTickets: mock.fn(async () => []),
    primeTicketCache: mock.fn(() => {}),
    deleteComment: mock.fn(async () => {}),
    ...overrides,
  };
}

const baseManifest = {
  epicId: 42,
  generatedAt: '2026-05-08T00:00:00Z',
  storyManifest: [
    { storyId: 100, storyTitle: 'A', storyType: 'story', earliestWave: 0 },
    { storyId: 101, storyTitle: 'B', storyType: 'story', earliestWave: 1 },
  ],
};

describe('postManifestEpicComment', () => {
  it("skips with reason 'not-an-epic-manifest' when manifest has no epicId", async () => {
    const provider = buildProvider();
    const result = await postManifestEpicComment(
      { ...baseManifest, epicId: undefined },
      provider,
    );
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'not-an-epic-manifest');
  });

  it("skips with reason 'no-provider' when provider lacks postComment", async () => {
    const result = await postManifestEpicComment(baseManifest, {});
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'no-provider');
  });

  it('posts the manifest body and returns posted: true on success', async () => {
    const provider = buildProvider();
    const result = await postManifestEpicComment(baseManifest, provider);
    assert.equal(result.posted, true);
    assert.equal(provider.postComment.mock.callCount(), 1);
    const [ticketId, payload] = provider.postComment.mock.calls[0].arguments;
    assert.equal(ticketId, 42);
    assert.equal(payload.type, 'dispatch-manifest');
    assert.match(payload.body, /Dispatch Manifest — Epic #42/);
    assert.match(payload.body, /Waves:/);
  });

  it('returns posted: false with the error message on postComment failure', async () => {
    const provider = buildProvider({
      postComment: mock.fn(async () => {
        throw new Error('rate limited');
      }),
    });
    const result = await postManifestEpicComment(baseManifest, provider);
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'rate limited');
  });

  it('filters __ungrouped__ stories out of the JSON body', async () => {
    const provider = buildProvider();
    const manifestWithUngrouped = {
      ...baseManifest,
      storyManifest: [
        ...baseManifest.storyManifest,
        { storyId: '__ungrouped__', storyTitle: 'orphan', earliestWave: 0 },
      ],
    };
    await postManifestEpicComment(manifestWithUngrouped, provider);
    const body = provider.postComment.mock.calls[0].arguments[1].body;
    assert.equal(body.includes('__ungrouped__'), false);
  });

  it('skips feature stories from the wave / story counts', async () => {
    const provider = buildProvider();
    const manifestWithFeature = {
      ...baseManifest,
      storyManifest: [
        ...baseManifest.storyManifest,
        { storyId: 200, type: 'feature', storyTitle: 'F', earliestWave: 5 },
      ],
    };
    await postManifestEpicComment(manifestWithFeature, provider);
    const body = provider.postComment.mock.calls[0].arguments[1].body;
    assert.match(body, /\*\*Stories:\*\* 2/);
  });
});

describe('postParkedFollowOnsComment', () => {
  it("skips with reason 'not-an-epic-manifest' when manifest has no epicId", async () => {
    const provider = buildProvider();
    const result = await postParkedFollowOnsComment(
      { ...baseManifest, epicId: undefined },
      provider,
    );
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'not-an-epic-manifest');
    assert.equal(result.recuts, 0);
    assert.equal(result.parked, 0);
  });

  it("skips with reason 'no-provider' when provider lacks postComment", async () => {
    const result = await postParkedFollowOnsComment(baseManifest, {});
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'no-provider');
  });

  it('returns posted: false with the error message when getTickets fails', async () => {
    const provider = buildProvider({
      getTickets: mock.fn(async () => {
        throw new Error('graphql 502');
      }),
    });
    const result = await postParkedFollowOnsComment(baseManifest, provider);
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'graphql 502');
  });

  it('happy path: posts body and surfaces recuts/parked counts (zero when no extras)', async () => {
    const provider = buildProvider({
      getTickets: mock.fn(async () => [
        {
          id: 100,
          labels: ['type::story'],
          state: 'open',
          body: '',
        },
        {
          id: 101,
          labels: ['type::story'],
          state: 'open',
          body: '',
        },
      ]),
    });
    const result = await postParkedFollowOnsComment(baseManifest, provider);
    assert.equal(result.posted, true);
    assert.equal(result.recuts, 0);
    assert.equal(result.parked, 0);
    assert.equal(provider.postComment.mock.callCount(), 1);
  });

  it('returns posted: false when postComment throws after a successful classification', async () => {
    const provider = buildProvider({
      getTickets: mock.fn(async () => []),
      postComment: mock.fn(async () => {
        throw new Error('boom');
      }),
    });
    const result = await postParkedFollowOnsComment(baseManifest, provider);
    assert.equal(result.posted, false);
    assert.equal(result.reason, 'boom');
  });

  it('does not call primeTicketCache when getTickets returns null/undefined', async () => {
    const provider = buildProvider({
      getTickets: mock.fn(async () => null),
    });
    const result = await postParkedFollowOnsComment(baseManifest, provider);
    assert.equal(provider.primeTicketCache.mock.callCount(), 0);
    assert.equal(result.posted, true);
  });
});
