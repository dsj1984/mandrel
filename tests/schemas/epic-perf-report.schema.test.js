/**
 * Unit tests for `epic-perf-report.schema.json` — `mostFrictionStories[]`
 * item shape.
 *
 * Story #2590 removed the `dispatchModel` field from the schema after the
 * audit found no production producer wrote it. The tests below pin the
 * post-removal contract:
 *   - Records with just `{ storyId, frictionCount }` validate.
 *   - Records that smuggle a `dispatchModel` key (any value) are rejected
 *     by `additionalProperties: false`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'epic-perf-report.schema.json',
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function compileSchema() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function basePayload(overrides = {}) {
  return {
    kind: 'epic-perf-report',
    epicId: 1185,
    generatedAt: '2026-05-11T16:00:00.000Z',
    signalCounts: {
      friction: 0,
      hotspot: 0,
      rework: 0,
      churn: 0,
      idle: 0,
      retry: 0,
    },
    waveParallelism: [],
    topHotspots: [],
    mostFrictionStories: [],
    ...overrides,
  };
}

describe('epic-perf-report.schema.json — mostFrictionStories item shape', () => {
  it('validates the canonical { storyId, frictionCount } shape', () => {
    const validate = compileSchema();
    const ok = validate(
      basePayload({
        mostFrictionStories: [{ storyId: 1042, frictionCount: 4 }],
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects records carrying a dispatchModel key (Story #2590 removal)', () => {
    const validate = compileSchema();
    const ok = validate(
      basePayload({
        mostFrictionStories: [
          { storyId: 1042, frictionCount: 4, dispatchModel: 'haiku' },
        ],
      }),
    );
    assert.equal(ok, false);
    const errors = validate.errors ?? [];
    const extra = errors.find((e) => e.keyword === 'additionalProperties');
    assert.ok(
      extra,
      `expected additionalProperties error, got: ${JSON.stringify(errors)}`,
    );
  });
});
