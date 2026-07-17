/**
 * Round-trip tests for the JSON schemas published by Story #1039 under
 * Epic #1030 — signal-event and the agentrc `agentSettings.limits.signals`
 * block. (The `story-perf-summary` / `epic-perf-report` schemas were deleted
 * in Story #4545 along with the execution-analysis surface that produced
 * them — the analyzer they fed had no workflow invoker.)
 *
 * The schemas are draft-07 JSON Schema files consumed by the signals
 * writer and config validation. These tests assert:
 *   1. Each `.json` file parses as a JSON Schema draft-07 document Ajv can
 *      compile without errors.
 *   2. A representative valid example for each schema validates clean.
 *   3. A known-bad payload for each schema fails — guarding against
 *      schema drift accidentally weakening the contract.
 *   4. The agentrc `signals` block round-trips through the runtime
 *      `getSettingsValidator()` (the source-of-truth AJV schema) so the
 *      agentrc.schema.json static mirror cannot diverge undetected.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '..', '..', '.agents', 'schemas');

const loadSchema = (filename) =>
  JSON.parse(readFileSync(path.join(SCHEMAS_DIR, filename), 'utf8'));

const compile = (schema) => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
};

describe('signal-event.schema.json', () => {
  const schema = loadSchema('signal-event.schema.json');

  it('declares draft-07', () => {
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  });

  it('compiles cleanly', () => {
    assert.doesNotThrow(() => compile(schema));
  });

  it('accepts a representative friction signal (canonical envelope)', () => {
    const validate = compile(schema);
    const ok = validate({
      ts: '2026-05-07T18:42:11.045Z',
      kind: 'friction',
      emitter: { tool: 'diagnose-friction.js', command: 'npm test' },
      source: 'consumer',
      category: 'Execution Error',
      epicId: 1030,
      storyId: 1042,
      phase: 'implement',
      details: {
        errorPreview: 'boom',
        elapsedMs: 41020,
      },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts a raw trace line with optional fields omitted', () => {
    const validate = compile(schema);
    const ok = validate({
      ts: '2026-05-07T18:42:11.045Z',
      kind: 'trace',
      emitter: { tool: 'Bash' },
      epicId: 1030,
      storyId: 1042,
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects an unknown kind', () => {
    const validate = compile(schema);
    const ok = validate({
      ts: '2026-05-07T18:42:11.045Z',
      kind: 'cosmic-ray',
      emitter: { tool: 'Bash' },
      epicId: 1030,
      storyId: 1042,
    });
    assert.equal(ok, false);
  });

  it('rejects a record missing the required `ts`', () => {
    const validate = compile(schema);
    const ok = validate({
      kind: 'friction',
      emitter: { tool: 'x' },
      epicId: 1030,
      storyId: 1042,
    });
    assert.equal(ok, false);
  });

  it('rejects a non-canonical `source` (must be the framework/consumer classifier tag, not an object)', () => {
    const validate = compile(schema);
    const ok = validate({
      ts: '2026-05-07T18:42:11.045Z',
      kind: 'friction',
      source: { tool: 'Bash' },
      epicId: 1030,
      storyId: 1042,
    });
    assert.equal(
      ok,
      false,
      '`source` is reserved for the framework|consumer string; provenance lives in `emitter`',
    );
  });

  // Epic #4406 canonical envelope: `taskId` (nullable) is a first-class
  // field again — every trace / detector writer emits `taskId: null`, so
  // the schema that "validates every writer's real output" MUST accept it.
  it('accepts a 2-tier signal event with taskId: null', () => {
    const validate = compile(schema);
    const ok = validate({
      ts: '2026-05-27T16:00:00.000Z',
      kind: 'trace',
      emitter: { tool: 'Bash' },
      epicId: 3078,
      storyId: 3143,
      taskId: null,
      phase: null,
      details: { tool: 'Bash', durationMs: 12, exitCode: 1 },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts an epic-level wave record (no storyId)', () => {
    const validate = compile(schema);
    const ok = validate({
      ts: '2026-05-27T16:00:00.000Z',
      kind: 'wave-start',
      epicId: 3078,
      index: 0,
      stories: [{ id: 3143, title: 'x' }],
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });
});

describe('agentrc delivery.signals — runtime AJV schema (post-reshape)', () => {
  const validate = getAgentrcValidator();
  const REQ = Object.freeze({
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
  });

  it('accepts a doc without the signals block', () => {
    assert.equal(validate({ ...REQ }), true);
    assert.equal(validate({ ...REQ, delivery: {} }), true);
  });

  it('accepts a fully-populated two-detector signals block', () => {
    const ok = validate({
      ...REQ,
      delivery: {
        signals: {
          rework: { editsPerFile: 5 },
          retry: { repeatCount: 3 },
        },
      },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects the dropped churn detector', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { churn: { repeatCount: 4 } } },
    });
    assert.equal(ok, false);
  });

  it('rejects the dropped idle detector', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { idle: { gapSeconds: 120 } } },
    });
    assert.equal(ok, false);
  });

  it('rejects the retired hotspot detector', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { hotspot: { p95Multiplier: 1.25 } } },
    });
    assert.equal(ok, false);
  });

  it('accepts a partial signals block (single detector override)', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { rework: { editsPerFile: 7 } } },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects a typo under signals.* (additionalProperties: false)', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { rewrk: { editsPerFile: 1 } } },
    });
    assert.equal(ok, false);
  });

  it('rejects a typo inside a detector block', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { rework: { editsPerFil: 5 } } },
    });
    assert.equal(ok, false);
  });

  it('rejects sub-1 editsPerFile (integer minimum 1)', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { rework: { editsPerFile: 0 } } },
    });
    assert.equal(ok, false);
  });
});
