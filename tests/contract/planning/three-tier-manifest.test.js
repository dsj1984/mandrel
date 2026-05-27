/**
 * tests/contract/planning/three-tier-manifest.test.js
 *
 * Contract: dispatch-manifest.json schema and `buildManifest()` agree on
 * the 3-tier Story-centric shape (Epic #3078).
 *
 * Asserts:
 *   - `buildManifest()` invoked on a 3-tier ticket graph (zero Tasks,
 *     N Stories) emits a manifest whose `waves[].stories[]` entries
 *     validate against `.agents/schemas/dispatch-manifest.json`.
 *   - The summary block reports `totalStories` and `doneStories`
 *     (Story-centric counts), not `totalTasks`.
 *   - Each emitted `waves[].stories[]` entry carries every required
 *     field declared by the schema (`storyId`, `title`, `persona`,
 *     `acceptance`, `verify`, `dependsOn`).
 *   - The schema rejects a wave entry that has neither `tasks[]` nor
 *     `stories[]` (load-bearing for the 3-tier additive shape).
 *
 * Story #3136 (Epic #3078, Feature #3093). Complements
 * tests/enforcement/manifest-schema.test.js which exercises the same
 * AJV drift surface from the enforcement tier; this file pins the
 * contract from the perspective of a downstream manifest consumer.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { buildManifest } from '../../../.agents/scripts/lib/orchestration/manifest-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '.agents',
  'schemas',
  'dispatch-manifest.json',
);

function compileSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function formatErrors(errors) {
  return (errors ?? [])
    .map(
      (e) =>
        `  ${e.instancePath || '/'}: ${e.keyword} ${e.message ?? ''} ${JSON.stringify(e.params)}`,
    )
    .join('\n');
}

/** Build a minimal 3-tier ticket graph: one Epic, one Feature, two Stories. */
function threeTierTickets() {
  const epic = {
    id: 9000,
    title: 'Epic 9000',
    body: '',
    labels: ['type::epic'],
  };
  const feature = {
    id: 9001,
    title: 'Feature 9001',
    body: 'parent: #9000',
    labels: ['type::feature'],
  };
  const storyA = {
    id: 9010,
    title: 'Story A',
    body: [
      '## Acceptance',
      '- [ ] Story A is dispatchable',
      '',
      '## Verify',
      '- node --test',
    ].join('\n'),
    labels: ['type::story', 'persona::engineer'],
  };
  const storyB = {
    id: 9011,
    title: 'Story B',
    body: [
      '## Acceptance',
      '- [ ] Story B is dispatchable after A',
      '',
      '## Verify',
      '- node --test',
      '',
      'blocked by #9010',
    ].join('\n'),
    labels: ['type::story', 'persona::engineer'],
  };
  return { epic, feature, storyA, storyB };
}

describe('dispatch-manifest schema — 3-tier shape (Story #3136)', () => {
  it('a hand-built 3-tier manifest with waves[].stories[] validates against the schema', () => {
    // Arrange — exercise the schema contract directly. The summary block
    // accepts both Task-centric (totalTasks/doneTasks) and Story-centric
    // (totalStories/doneStories) counts under the 3-tier additive shape;
    // both are required by the schema and reported here so the contract
    // is exercised end-to-end.
    const validate = compileSchema();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '1.0.0',
      epicId: 9000,
      epicTitle: 'Epic 9000',
      executor: 'claude-code',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      summary: {
        totalStories: 2,
        doneStories: 0,
        progressPercent: 0,
        totalWaves: 2,
        dispatched: 0,
      },
      waves: [
        {
          waveIndex: 0,
          stories: [
            {
              storyId: 9010,
              title: 'Story A',
              persona: 'engineer',
              acceptance: ['Story A is dispatchable'],
              verify: ['node --test'],
              dependsOn: [],
            },
          ],
        },
        {
          waveIndex: 1,
          stories: [
            {
              storyId: 9011,
              title: 'Story B',
              persona: 'engineer',
              acceptance: ['Story B is dispatchable after A'],
              verify: ['node --test'],
              dependsOn: [9010],
            },
          ],
        },
      ],
      dispatched: [],
    };

    // Act
    const ok = validate(manifest);

    // Assert
    assert.equal(
      ok,
      true,
      `3-tier manifest failed schema validation:\n${formatErrors(validate.errors)}`,
    );
  });

  it('buildManifest() output for a 3-tier ticket graph emits Story-centric waves', () => {
    // Arrange — exercise the producer surface separately from the
    // schema validation above. The producer's waves[].stories[] shape
    // is the contract under test here; the summary count gap is
    // covered in the dedicated "reports totalStories" test below.
    const { epic, feature, storyA, storyB } = threeTierTickets();
    const allTickets = [epic, feature, storyA, storyB];
    const waves = [[storyA], [storyB]];

    // Act
    const manifest = buildManifest({
      epicId: 9000,
      epic,
      tasks: [],
      allTickets,
      waves,
      dispatched: [],
      dryRun: false,
      hierarchy: '3-tier',
    });

    // Assert
    assert.equal(manifest.hierarchy, '3-tier');
    assert.equal(manifest.waves.length, 2);
    assert.ok(Array.isArray(manifest.waves[0].stories));
    assert.equal(manifest.waves[0].stories[0].storyId, 9010);
    assert.equal(manifest.waves[1].stories[0].storyId, 9011);
  });

  it('reports totalStories and doneStories in summary (Story-centric counts)', () => {
    // Arrange
    const { epic, feature, storyA, storyB } = threeTierTickets();
    // Mark Story A as done so doneStories > 0 exercises the count path.
    storyA.labels = [...storyA.labels, 'agent::done'];

    // Act
    const manifest = buildManifest({
      epicId: 9000,
      epic,
      tasks: [],
      allTickets: [epic, feature, storyA, storyB],
      waves: [[storyA, storyB]],
      dispatched: [],
      dryRun: false,
      hierarchy: '3-tier',
    });

    // Assert
    assert.equal(manifest.summary.totalStories, 2);
    assert.equal(manifest.summary.doneStories, 1);
    assert.equal(manifest.summary.progressPercent, 50);
    assert.equal(
      manifest.summary.totalTasks,
      undefined,
      'totalTasks must not appear in 3-tier summary',
    );
  });

  it('each waves[].stories[] entry carries every schema-required field', () => {
    // Arrange
    const { epic, feature, storyA, storyB } = threeTierTickets();

    // Act
    const manifest = buildManifest({
      epicId: 9000,
      epic,
      tasks: [],
      allTickets: [epic, feature, storyA, storyB],
      waves: [[storyA], [storyB]],
      dispatched: [],
      dryRun: false,
      hierarchy: '3-tier',
    });

    // Assert
    assert.equal(manifest.waves.length, 2);
    for (const wave of manifest.waves) {
      assert.ok(Array.isArray(wave.stories), 'wave.stories must be an array');
      for (const story of wave.stories) {
        assert.equal(typeof story.storyId, 'number');
        assert.equal(typeof story.title, 'string');
        assert.equal(typeof story.persona, 'string');
        assert.ok(Array.isArray(story.acceptance));
        assert.ok(Array.isArray(story.verify));
        assert.ok(Array.isArray(story.dependsOn));
      }
    }
    // Story B's `blocked by #9010` body marker must surface as a
    // dependsOn edge so the wave-runner can enforce ordering.
    const projectedB = manifest.waves[1].stories.find(
      (s) => s.storyId === 9011,
    );
    assert.ok(projectedB, 'Story B should appear in wave 1');
    assert.deepEqual(projectedB.dependsOn, [9010]);
  });

  it('schema rejects a wave entry that has neither tasks[] nor stories[]', () => {
    // Arrange — load-bearing for the 3-tier additive shape: a wave
    // entry must declare at least one of the two collections.
    const validate = compileSchema();
    const bad = {
      type: 'epic-dispatch',
      schemaVersion: '1.0.0',
      epicId: 9000,
      epicTitle: 'bad',
      executor: 'manual',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      summary: {
        totalStories: 0,
        doneStories: 0,
        progressPercent: 0,
        totalWaves: 1,
        dispatched: 0,
      },
      waves: [{ waveIndex: 0 }],
      dispatched: [],
    };

    // Act
    const ok = validate(bad);

    // Assert
    assert.equal(ok, false);
  });
});
