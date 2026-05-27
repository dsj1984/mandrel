import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * Fixture-based AJV drift test for `.agents/schemas/dispatch-manifest.json`.
 *
 * Exercises representative manifest payloads against the dispatch-manifest
 * schema. The schema is the open-root variant adopted in ADR 20260427-868a
 * — the AJV drift test here is the enforcement boundary. After Epic #3078
 * Task #3156 the schema only admits the 3-tier Story-centric shape; the
 * legacy 4-tier Task-centric shape (waves[].tasks[], storyManifest[],
 * stories[].tasks[]) is rejected.
 *
 * On failure, the assertion message is the verbatim AJV error list
 * (`{instancePath, schemaPath, keyword, params, message}` per error) so the
 * schema author / runtime author can see exactly which field/value broke.
 */

const SCHEMA_PATH = path.resolve('.agents/schemas/dispatch-manifest.json');

function loadValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  return ajv.compile(schema);
}

function formatErrors(errors) {
  return (errors ?? [])
    .map(
      (e) =>
        `  ${e.instancePath || '/'}: ${e.keyword} ${
          e.message ?? ''
        } ${JSON.stringify(e.params)}`,
    )
    .join('\n');
}

function assertValid(validator, payload, label) {
  const ok = validator(payload);
  assert.equal(
    ok,
    true,
    `[${label}] manifest failed schema validation:\n${formatErrors(
      validator.errors,
    )}\n--- payload ---\n${JSON.stringify(payload, null, 2)}`,
  );
}

describe('dispatch-manifest schema drift (AJV fixture)', () => {
  it('accepts an epic-dispatch manifest with waves[].stories[] (3-tier)', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '2.0.0',
      epicId: 3078,
      epicTitle: 'Collapse to 3-tier',
      executor: 'manual',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      summary: {
        totalStories: 2,
        doneStories: 0,
        progressPercent: 0,
        totalWaves: 1,
        dispatched: 0,
      },
      waves: [
        {
          waveIndex: 0,
          stories: [
            {
              storyId: 3098,
              title: 'S1.2: dispatch-manifest accepts stories',
              persona: 'engineer',
              acceptance: ['Schema accepts waves[].stories[]'],
              verify: ['node --test tests/enforcement/manifest-schema.test.js'],
              dependsOn: [],
            },
            {
              storyId: 3099,
              title: 'S1.3: builder emits stories',
              persona: 'engineer',
              acceptance: ['Builder produces waves[].stories[]'],
              verify: ['node --test'],
              dependsOn: [3098],
              branch: 'story-3099',
              status: 'agent::ready',
            },
          ],
        },
      ],
      dispatched: [],
    };
    assertValid(validator, manifest, 'epic-dispatch with stories[]');
  });

  it('accepts an empty epic-dispatch manifest (zero waves, zero dispatched)', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '2.0.0',
      epicId: 60,
      epicTitle: 'Epic Sixty',
      executor: 'manual',
      generatedAt: new Date().toISOString(),
      dryRun: true,
      summary: {
        totalStories: 0,
        doneStories: 0,
        progressPercent: 0,
        totalWaves: 0,
        dispatched: 0,
      },
      waves: [],
      dispatched: [],
      agentTelemetry: null,
    };
    assertValid(validator, manifest, 'epic-dispatch (empty)');
  });

  it('accepts a story-execution manifest', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'story-execution',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      stories: [
        {
          storyId: 700,
          storyTitle: 'Story Seven Hundred',
          epicId: 50,
          epicBranch: 'epic/50',
          branchName: 'story-700',
          status: 'agent::ready',
        },
      ],
    };
    assertValid(validator, manifest, 'story-execution');
  });

  it('rejects an epic-dispatch manifest missing required summary', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '2.0.0',
      epicId: 70,
      epicTitle: 'Epic Seventy',
      executor: 'manual',
      generatedAt: new Date().toISOString(),
      dryRun: true,
      waves: [],
      dispatched: [],
    };
    const ok = validator(manifest);
    assert.equal(ok, false, 'missing summary should fail validation');
    const messages = formatErrors(validator.errors);
    assert.match(messages, /summary/);
  });

  it('rejects an epic-dispatch manifest with legacy waves[].tasks[] (4-tier removed)', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '2.0.0',
      epicId: 3078,
      epicTitle: 'Legacy shape rejected',
      executor: 'manual',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      summary: {
        totalStories: 1,
        doneStories: 0,
        progressPercent: 0,
        totalWaves: 1,
        dispatched: 0,
      },
      waves: [
        {
          waveIndex: 0,
          tasks: [
            {
              taskId: 1,
              title: 'Legacy task',
              status: 'agent::ready',
              branch: 'story-1',
              persona: 'engineer',
              mode: 'fast',
              skills: [],
              focusAreas: [],
              dependsOn: [],
            },
          ],
        },
      ],
      dispatched: [],
    };
    const ok = validator(manifest);
    assert.equal(ok, false, 'waves[].tasks[] must be rejected');
  });

  it('rejects an epic-dispatch manifest carrying storyManifest[] (4-tier removed)', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '2.0.0',
      epicId: 3078,
      epicTitle: 'storyManifest removed',
      executor: 'manual',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      summary: {
        totalStories: 0,
        doneStories: 0,
        progressPercent: 0,
        totalWaves: 0,
        dispatched: 0,
      },
      waves: [],
      storyManifest: [
        {
          storyId: 100,
          storyTitle: 'X',
          storySlug: 'x',
          type: 'story',
          branchName: 'story-100',
          earliestWave: 0,
          tasks: [],
        },
      ],
      dispatched: [],
    };
    const ok = validator(manifest);
    assert.equal(ok, false, 'storyManifest[] must be rejected');
  });

  it('rejects summary carrying totalTasks/doneTasks (Task counters removed)', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '2.0.0',
      epicId: 3078,
      epicTitle: 'task-counters-removed',
      executor: 'manual',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      summary: {
        totalTasks: 5,
        doneTasks: 2,
        totalStories: 3,
        doneStories: 1,
        progressPercent: 40,
        totalWaves: 2,
        dispatched: 0,
      },
      waves: [],
      dispatched: [],
    };
    const ok = validator(manifest);
    assert.equal(ok, false, 'summary.totalTasks/doneTasks must be rejected');
  });

  it('rejects a wave entry that lacks stories[]', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '2.0.0',
      epicId: 3078,
      epicTitle: 'No-stories',
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
    const ok = validator(manifest);
    assert.equal(ok, false, 'wave without stories must fail');
  });

  it('rejects a waves[].stories[] entry that is missing required fields', () => {
    const validator = loadValidator();
    const manifest = {
      type: 'epic-dispatch',
      schemaVersion: '2.0.0',
      epicId: 3078,
      epicTitle: 'bad-story-entry',
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
      waves: [
        {
          waveIndex: 0,
          stories: [
            // Missing persona / acceptance / verify / dependsOn
            { storyId: 3098, title: 'Bad entry' },
          ],
        },
      ],
      dispatched: [],
    };
    const ok = validator(manifest);
    assert.equal(ok, false, 'story entry missing required fields must fail');
  });

  it('rejects a story-execution manifest carrying nested tasks[] (4-tier removed)', () => {
    const validator = loadValidator();
    const bad = {
      type: 'story-execution',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      stories: [
        {
          storyId: 800,
          storyTitle: 'Story Eight Hundred',
          epicId: 50,
          epicBranch: 'epic/50',
          branchName: 'story-800',
          tasks: [{ taskId: 101, title: 'X', status: 'open' }],
        },
      ],
    };
    const ok = validator(bad);
    assert.equal(ok, false, 'nested tasks[] under stories must be rejected');
  });
});
