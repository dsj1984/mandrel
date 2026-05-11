/**
 * Unit tests for the optional `dispatchModel` field added to
 * `mostFrictionStories[]` items in `epic-perf-report.schema.json`
 * (Epic #1185 / Story #1329 / Task #1341).
 *
 * Contract:
 *   - Pre-existing records without `dispatchModel` still validate (back-compat).
 *   - Records with `dispatchModel: 'haiku' | 'sonnet' | 'opus'` validate.
 *   - Records with any other string (e.g. `'gpt-4'`) fail with a clear
 *     enum-violation error.
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

describe('epic-perf-report.schema.json — dispatchModel field (Epic #1185)', () => {
  it('still validates pre-existing records that omit dispatchModel (back-compat)', () => {
    const validate = compileSchema();
    const ok = validate(
      basePayload({
        mostFrictionStories: [{ storyId: 1042, frictionCount: 4 }],
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  for (const value of ['haiku', 'sonnet', 'opus']) {
    it(`validates records carrying dispatchModel: '${value}'`, () => {
      const validate = compileSchema();
      const ok = validate(
        basePayload({
          mostFrictionStories: [
            { storyId: 1042, frictionCount: 4, dispatchModel: value },
          ],
        }),
      );
      assert.equal(ok, true, JSON.stringify(validate.errors));
    });
  }

  it('rejects an unknown dispatchModel value with an enum-violation error', () => {
    const validate = compileSchema();
    const ok = validate(
      basePayload({
        mostFrictionStories: [
          { storyId: 1042, frictionCount: 4, dispatchModel: 'gpt-4' },
        ],
      }),
    );
    assert.equal(ok, false);
    const errors = validate.errors ?? [];
    const enumError = errors.find((e) => e.keyword === 'enum');
    assert.ok(
      enumError,
      `expected an enum-violation error, got: ${JSON.stringify(errors)}`,
    );
    assert.match(
      String(enumError.instancePath ?? ''),
      /dispatchModel/,
      `expected enum error to point at dispatchModel, got: ${JSON.stringify(enumError)}`,
    );
  });

  it('rejects null dispatchModel (omit-not-null contract)', () => {
    const validate = compileSchema();
    const ok = validate(
      basePayload({
        mostFrictionStories: [
          { storyId: 1042, frictionCount: 4, dispatchModel: null },
        ],
      }),
    );
    assert.equal(ok, false);
  });
});
