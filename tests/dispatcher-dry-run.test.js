/**
 * dispatcher-dry-run.test.js
 *
 * After Story #3026 extracted the dispatch-manifest body into
 * `dispatch-manifest-render.js`, the `manifest-renderer.js` facade — the
 * code path dispatcher.js drives during `--dry-run` — must produce a
 * body byte-identical to the helper output. This is the regression net
 * that catches inline-builder drift in the facade.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderManifestFromManifest } from '../.agents/scripts/lib/presentation/dispatch-manifest-render.js';
import { postManifestEpicComment } from '../.agents/scripts/lib/presentation/manifest-renderer.js';

class CaptureProvider {
  constructor() {
    this.posted = [];
  }
  async getTicketComments() {
    return [];
  }
  async postComment(ticketId, payload) {
    this.posted.push({ ticketId, payload });
    return { id: 1 };
  }
  async deleteComment() {}
}

function makeFixtureManifest() {
  return {
    epicId: 7777,
    generatedAt: '2026-05-26T13:00:00.000Z',
    type: 'epic',
    storyManifest: [
      {
        storyId: 7001,
        storyTitle: 'Alpha story',
        type: 'story',
        earliestWave: 0,
      },
      {
        storyId: 7002,
        storyTitle: 'Beta story',
        type: 'story',
        earliestWave: 1,
      },
    ],
  };
}

describe('dispatcher dry-run body parity', () => {
  it('postManifestEpicComment posts the helper-rendered body byte-for-byte', async () => {
    const manifest = makeFixtureManifest();
    const provider = new CaptureProvider();

    const result = await postManifestEpicComment(manifest, provider);

    assert.equal(result.posted, true);
    assert.equal(provider.posted.length, 1);
    const expected = renderManifestFromManifest(manifest);
    // upsertStructuredComment prepends a marker line + blank line.
    const [ticketId, payload] = [
      provider.posted[0].ticketId,
      provider.posted[0].payload,
    ];
    assert.equal(ticketId, manifest.epicId);
    assert.equal(payload.type, 'dispatch-manifest');
    assert.ok(
      payload.body.endsWith(expected),
      `body should end with helper-rendered output; got:\n${payload.body}`,
    );
  });

  it('skips upsert when the manifest is a story-execution manifest', async () => {
    const provider = new CaptureProvider();
    const result = await postManifestEpicComment(
      { type: 'story-execution', epicId: 1 },
      provider,
    );
    assert.equal(result.posted, false);
    assert.equal(provider.posted.length, 0);
  });
});
