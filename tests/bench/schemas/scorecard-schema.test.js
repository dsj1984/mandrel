// tests/bench/schemas/scorecard-schema.test.js
//
// Contract tier for the benchmark scorecard JSON schema (Epic #4211,
// Story #4215). Proves the schema at bench/schemas/scorecard.schema.json
// validates the committed fixture (the binding acceptance item) and that it
// genuinely constrains the record shape — required fields, enums, ranges,
// and additionalProperties: false all reject malformed scorecards.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/bench/schemas/ → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'bench',
  'schemas',
  'scorecard.schema.json',
);
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'bench',
  'fixtures',
  'sample-scorecard.json',
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

function buildValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Deep clone so each negative case starts from a known-valid record. */
const clone = (obj) => JSON.parse(JSON.stringify(obj));

describe('scorecard schema — meta', () => {
  it('compiles under draft 2020-12 in strict mode', () => {
    assert.doesNotThrow(buildValidator);
  });

  it('declares the draft 2020-12 meta-schema and an $id', () => {
    assert.equal(
      schema.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
    assert.equal(schema.$id, 'mandrel-bench-scorecard');
  });
});

describe('scorecard schema — validates the committed fixture', () => {
  it('accepts bench/fixtures/sample-scorecard.json', () => {
    const validate = buildValidator();
    const ok = validate(fixture);
    assert.ok(
      ok,
      `fixture failed validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });

  it('the fixture exercises all five dimensions', () => {
    assert.deepEqual(
      Object.keys(fixture.dimensions).sort(),
      [
        'autonomy',
        'efficiency',
        'overheadRatio',
        'planningFidelity',
        'quality',
      ].sort(),
    );
  });
});

describe('scorecard schema — rejects malformed records', () => {
  const validate = buildValidator();

  it('rejects a record missing a top-level required field', () => {
    const bad = clone(fixture);
    delete bad.dimensions;
    assert.equal(validate(bad), false);
  });

  it('rejects a record missing one of the five dimensions', () => {
    const bad = clone(fixture);
    delete bad.dimensions.overheadRatio;
    assert.equal(validate(bad), false);
  });

  it('rejects an unknown top-level property (additionalProperties: false)', () => {
    const bad = clone(fixture);
    bad.surpriseField = 'nope';
    assert.equal(validate(bad), false);
  });

  it('rejects an unknown property inside a dimension', () => {
    const bad = clone(fixture);
    bad.dimensions.quality.extra = 1;
    assert.equal(validate(bad), false);
  });

  it('rejects a wrong schemaVersion const', () => {
    const bad = clone(fixture);
    bad.schemaVersion = 2;
    assert.equal(validate(bad), false);
  });

  it('rejects an out-of-enum scenario', () => {
    const bad = clone(fixture);
    bad.scenario = 'auth-flow';
    assert.equal(validate(bad), false);
  });

  it('rejects an out-of-enum arm', () => {
    const bad = clone(fixture);
    bad.arm = 'baseline';
    assert.equal(validate(bad), false);
  });

  it('rejects a quality.score above its [0,1] range', () => {
    const bad = clone(fixture);
    bad.dimensions.quality.score = 1.5;
    assert.equal(validate(bad), false);
  });

  it('rejects a negative efficiency.wallClockMs', () => {
    const bad = clone(fixture);
    bad.dimensions.efficiency.wallClockMs = -1;
    assert.equal(validate(bad), false);
  });

  it('rejects a non-RFC3339 timestamp', () => {
    const bad = clone(fixture);
    bad.timestamp = 'last tuesday';
    assert.equal(validate(bad), false);
  });

  it('rejects a runId with whitespace (pattern violation)', () => {
    const bad = clone(fixture);
    bad.runId = 'run with spaces';
    assert.equal(validate(bad), false);
  });
});

describe('scorecard schema — control-arm nullable dimensions', () => {
  const validate = buildValidator();

  it('accepts null planningFidelity.score and null quality.acceptanceEvalScore for the control arm', () => {
    const control = clone(fixture);
    control.runId = 'hello-world-control-2026-06-16-r03';
    control.arm = 'control';
    control.dimensions.planningFidelity.score = null;
    control.dimensions.quality.acceptanceEvalScore = null;
    control.dimensions.efficiency.costUsd = null;
    control.dimensions.overheadRatio.timeRatio = null;
    const ok = validate(control);
    assert.ok(
      ok,
      `control-arm record failed: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });
});
