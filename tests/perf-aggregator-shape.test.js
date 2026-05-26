/**
 * Schema-shape tests for the extended `waveParallelism[]` row (Epic #3019
 * / Story #3025 / Task #3034).
 *
 * Pins the post-reshape contract: rows now carry
 * `{ waveIndex, wallClockMs, summedStoryMs, utilisation, capBinding,
 * verifyConcurrencyCap }`, with `summedStoryMs` as a required field.
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
  '.agents',
  'schemas',
  'epic-perf-report.schema.json',
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function compile() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function basePayload(overrides = {}) {
  return {
    kind: 'epic-perf-report',
    epicId: 3019,
    generatedAt: '2026-05-26T21:00:00.000Z',
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

describe('epic-perf-report.schema.json — waveParallelism utilisation row shape (Story #3025)', () => {
  it('validates a row with { waveIndex, wallClockMs, summedStoryMs, utilisation, capBinding, verifyConcurrencyCap }', () => {
    const validate = compile();
    const ok = validate(
      basePayload({
        waveParallelism: [
          {
            waveIndex: 0,
            wallClockMs: 60000,
            summedStoryMs: 90000,
            utilisation: 0.75,
            capBinding: false,
            verifyConcurrencyCap: 4,
          },
        ],
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects a row missing summedStoryMs', () => {
    const validate = compile();
    const ok = validate(
      basePayload({
        waveParallelism: [
          {
            waveIndex: 0,
            wallClockMs: 60000,
            // summedStoryMs intentionally omitted
            utilisation: 0.5,
            capBinding: false,
            verifyConcurrencyCap: 4,
          },
        ],
      }),
    );
    assert.equal(ok, false);
    const errors = validate.errors ?? [];
    const missing = errors.find(
      (e) =>
        e.keyword === 'required' &&
        e.params?.missingProperty === 'summedStoryMs',
    );
    assert.ok(
      missing,
      `expected missing summedStoryMs error, got: ${JSON.stringify(errors)}`,
    );
  });
});
