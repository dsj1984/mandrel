/**
 * Round-trip tests for the four JSON schemas published by Story #1039
 * under Epic #1030 — signal-event, story-perf-summary, epic-perf-report,
 * and the agentrc `agentSettings.limits.signals` block.
 *
 * The schemas are draft-07 JSON Schema files consumed by the signals
 * writer, the analyzer, and config validation. These tests assert:
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

  it('accepts a representative friction signal', () => {
    const validate = compile(schema);
    const ok = validate({
      ts: '2026-05-07T18:42:11.045Z',
      kind: 'friction',
      source: { tool: 'Bash', script: 'diagnose-friction.js' },
      epicId: 1030,
      storyId: 1042,
      taskId: 1071,
      phase: 'implement',
      details: {
        category: 'Execution Error',
        command: 'npm test',
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
      source: { tool: 'Bash' },
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
      source: { tool: 'Bash' },
      epicId: 1030,
      storyId: 1042,
    });
    assert.equal(ok, false);
  });

  it('rejects a missing required source.tool', () => {
    const validate = compile(schema);
    const ok = validate({
      ts: '2026-05-07T18:42:11.045Z',
      kind: 'friction',
      source: {},
      epicId: 1030,
      storyId: 1042,
    });
    assert.equal(ok, false);
  });
});

describe('story-perf-summary.schema.json', () => {
  const schema = loadSchema('story-perf-summary.schema.json');

  it('declares draft-07', () => {
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  });

  it('compiles cleanly', () => {
    assert.doesNotThrow(() => compile(schema));
  });

  it('accepts the canonical payload from the Tech Spec', () => {
    const validate = compile(schema);
    const ok = validate({
      kind: 'story-perf-summary',
      storyId: 1042,
      epicId: 1030,
      closedAt: '2026-05-07T19:10:22Z',
      frictionByCategory: { 'Prompt Ambiguity': 1, 'Execution Error': 3 },
      phaseTimingsMs: {
        bootstrap: 8421,
        implement: 412300,
        test: 65120,
        close: 14200,
      },
      topSlowPhasesVsBaseline: [
        {
          phase: 'implement',
          elapsedMs: 412300,
          baselineP95Ms: 320000,
          ratio: 1.29,
        },
      ],
      reworkScore: {
        filesEditedBeyondThreshold: 2,
        topPath: 'lib/foo.js',
        topPathEdits: 7,
      },
      retryDensity: { retries: 4, uniqueCommands: 2 },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects a wrong kind discriminator', () => {
    const validate = compile(schema);
    const ok = validate({
      kind: 'epic-perf-report',
      storyId: 1042,
      epicId: 1030,
      closedAt: '2026-05-07T19:10:22Z',
      frictionByCategory: {},
      phaseTimingsMs: {},
      topSlowPhasesVsBaseline: [],
      reworkScore: { filesEditedBeyondThreshold: 0 },
      retryDensity: { retries: 0, uniqueCommands: 0 },
    });
    assert.equal(ok, false);
  });
});

describe('epic-perf-report.schema.json', () => {
  const schema = loadSchema('epic-perf-report.schema.json');

  it('declares draft-07', () => {
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  });

  it('compiles cleanly', () => {
    assert.doesNotThrow(() => compile(schema));
  });

  it('accepts the canonical payload from the Tech Spec', () => {
    const validate = compile(schema);
    const ok = validate({
      kind: 'epic-perf-report',
      epicId: 1030,
      generatedAt: '2026-05-07T22:14:00Z',
      signalCounts: {
        friction: 12,
        hotspot: 4,
        rework: 3,
        churn: 6,
        idle: 2,
        retry: 9,
      },
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 720000,
          summedStoryMs: 1800000,
          utilisation: 0.4,
          capBinding: false,
          verifyConcurrencyCap: 4,
        },
      ],
      topHotspots: [{ phase: 'implement', occurrences: 3, avgRatio: 1.31 }],
      mostFrictionStories: [{ storyId: 1042, frictionCount: 4 }],
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects an unknown signalCounts key', () => {
    const validate = compile(schema);
    const ok = validate({
      kind: 'epic-perf-report',
      epicId: 1030,
      generatedAt: '2026-05-07T22:14:00Z',
      signalCounts: { mystery: 1 },
      waveParallelism: [],
      topHotspots: [],
      mostFrictionStories: [],
    });
    assert.equal(ok, false);
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

  it('accepts a fully-populated three-detector signals block', () => {
    const ok = validate({
      ...REQ,
      delivery: {
        signals: {
          hotspot: { p95Multiplier: 1.25 },
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

  it('accepts a partial signals block (single detector override)', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { hotspot: { p95Multiplier: 1.5 } } },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects a typo under signals.* (additionalProperties: false)', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { hotpsot: { p95Multiplier: 1 } } },
    });
    assert.equal(ok, false);
  });

  it('rejects a typo inside a detector block', () => {
    const ok = validate({
      ...REQ,
      limits: { signals: { hotspot: { p95multiplier: 1.25 } } },
    });
    assert.equal(ok, false);
  });

  it('rejects non-numeric p95Multiplier', () => {
    const ok = validate({
      ...REQ,
      delivery: { signals: { hotspot: { p95Multiplier: 'high' } } },
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
