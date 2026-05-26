/**
 * dispatch-manifest-render.test.js
 *
 * Unit coverage for the pure `renderManifest` helper extracted from
 * `manifest-renderer.js::postManifestEpicComment`. The fixture-derived
 * expected body is the byte-for-byte string the inline builder produced
 * before extraction — any drift in this snapshot is a contract change.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countWaves,
  projectStoriesFromManifest,
  renderManifest,
  renderManifestFromManifest,
} from '../.agents/scripts/lib/presentation/dispatch-manifest-render.js';

const FIXTURE_GENERATED_AT = '2026-05-26T12:00:00.000Z';

function makeFixtureManifest() {
  return {
    epicId: 9001,
    generatedAt: FIXTURE_GENERATED_AT,
    storyManifest: [
      {
        storyId: 9002,
        storyTitle: 'First story',
        storySlug: 'first-story',
        type: 'story',
        earliestWave: 0,
      },
      {
        storyId: 9003,
        storyTitle: 'Second story',
        storySlug: 'second-story',
        type: 'story',
        earliestWave: 1,
      },
      {
        // feature rows are filtered out
        storyId: 9000,
        storyTitle: 'Parent feature',
        type: 'feature',
        earliestWave: 0,
      },
      {
        // ungrouped sentinel is filtered out
        storyId: '__ungrouped__',
        storyTitle: 'Ungrouped',
        type: 'story',
        earliestWave: -1,
      },
    ],
  };
}

const EXPECTED_BODY = [
  '## 📋 Dispatch Manifest — Epic #9001',
  '',
  '- **Waves:** 2',
  '- **Stories:** 2',
  `- **Generated:** ${FIXTURE_GENERATED_AT}`,
  '',
  'Source of truth for the wave-completeness gate run at `/epic-deliver`.',
  '',
  '```json',
  JSON.stringify(
    {
      stories: [
        { storyId: 9002, wave: 0, title: 'First story' },
        { storyId: 9003, wave: 1, title: 'Second story' },
      ],
    },
    null,
    2,
  ),
  '```',
].join('\n');

describe('renderManifest', () => {
  it('renders the dispatch-manifest body byte-for-byte from a fixture Epic', () => {
    const manifest = makeFixtureManifest();
    const body = renderManifest({
      epicId: manifest.epicId,
      stories: projectStoriesFromManifest(manifest),
      generatedAt: manifest.generatedAt,
    });
    assert.equal(body, EXPECTED_BODY);
  });

  it('renderManifestFromManifest matches the deconstructed call', () => {
    const manifest = makeFixtureManifest();
    assert.equal(renderManifestFromManifest(manifest), EXPECTED_BODY);
  });

  it('reports `Waves: 1` when no story carries a real wave index', () => {
    const body = renderManifest({
      epicId: 9001,
      stories: [{ storyId: 1, wave: -1, title: 't' }],
      generatedAt: FIXTURE_GENERATED_AT,
    });
    assert.match(body, /- \*\*Waves:\*\* 1$/m);
    assert.match(body, /- \*\*Stories:\*\* 1$/m);
  });

  it('throws when epicId is missing', () => {
    assert.throws(
      () =>
        renderManifest({
          stories: [],
          generatedAt: FIXTURE_GENERATED_AT,
        }),
      /epicId is required/,
    );
  });
});

describe('projectStoriesFromManifest', () => {
  it('filters features and the ungrouped sentinel, projects {storyId, wave, title}', () => {
    const projected = projectStoriesFromManifest(makeFixtureManifest());
    assert.deepEqual(projected, [
      { storyId: 9002, wave: 0, title: 'First story' },
      { storyId: 9003, wave: 1, title: 'Second story' },
    ]);
  });

  it('falls back to storySlug when storyTitle is absent', () => {
    const projected = projectStoriesFromManifest({
      storyManifest: [
        {
          storyId: 1,
          type: 'story',
          storySlug: 'fallback-slug',
          earliestWave: 0,
        },
      ],
    });
    assert.equal(projected[0].title, 'fallback-slug');
  });

  it('returns [] for a manifest with no storyManifest', () => {
    assert.deepEqual(projectStoriesFromManifest({}), []);
    assert.deepEqual(projectStoriesFromManifest(null), []);
  });
});

describe('countWaves', () => {
  it('counts distinct non-(-1) wave indexes', () => {
    assert.equal(
      countWaves([
        { wave: 0 },
        { wave: 0 },
        { wave: 1 },
        { wave: -1 },
      ]),
      2,
    );
  });

  it('returns 0 for an empty list', () => {
    assert.equal(countWaves([]), 0);
    assert.equal(countWaves(null), 0);
  });
});
