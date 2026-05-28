/**
 * Unit tests for `.agents/schemas/story-plan-comment.schema.json`.
 *
 * Story #3258 (Epic #3212) — Verifies:
 *   1. The schema file exists, parses, and declares draft-07.
 *   2. A representative valid payload round-trips cleanly through AJV.
 *   3. Required fields are enforced.
 *   4. Structural invariants (plan_revision >= 1, ac_mapping shape) hold.
 *   5. `additionalProperties: false` rejects unknown top-level keys.
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
  'story-plan-comment.schema.json',
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function compile() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Canonical valid payload — all required fields present. */
function validPayload(overrides = {}) {
  return {
    files_to_touch: [
      '.agents/schemas/story-plan-comment.schema.json',
      '.agents/scripts/post-story-plan.js',
      'tests/schemas/story-plan-comment.schema.test.js',
      'tests/post-story-plan-cli.test.js',
    ],
    ac_mapping: {
      0: {
        tests: ['tests/schemas/story-plan-comment.schema.test.js'],
        notes: 'Schema file existence and field presence',
      },
      1: {
        tests: ['tests/schemas/story-plan-comment.schema.test.js'],
      },
      2: {
        tests: ['tests/post-story-plan-cli.test.js'],
      },
    },
    open_questions: [],
    plan_revision: 1,
    ...overrides,
  };
}

describe('story-plan-comment.schema.json — metadata', () => {
  it('exists and parses as JSON', () => {
    assert.ok(schema, 'schema loaded');
  });

  it('declares draft-07', () => {
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  });

  it('compiles cleanly under AJV', () => {
    assert.doesNotThrow(() => compile());
  });
});

describe('story-plan-comment.schema.json — required fields', () => {
  const validate = compile();

  it('accepts the canonical representative payload', () => {
    const ok = validate(validPayload());
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  for (const field of [
    'files_to_touch',
    'ac_mapping',
    'open_questions',
    'plan_revision',
  ]) {
    it(`rejects a payload missing required field: ${field}`, () => {
      const payload = validPayload();
      delete payload[field];
      const ok = validate(payload);
      assert.equal(
        ok,
        false,
        `expected validation failure for missing ${field}`,
      );
    });
  }
});

describe('story-plan-comment.schema.json — field shapes', () => {
  const validate = compile();

  it('accepts an empty files_to_touch array', () => {
    const ok = validate(validPayload({ files_to_touch: [] }));
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects a files_to_touch item that is empty string', () => {
    const ok = validate(validPayload({ files_to_touch: [''] }));
    assert.equal(ok, false);
  });

  it('accepts an empty open_questions array', () => {
    const ok = validate(validPayload({ open_questions: [] }));
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts non-empty open_questions strings', () => {
    const ok = validate(
      validPayload({ open_questions: ['Should this call existing helper X?'] }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts plan_revision = 1 (minimum)', () => {
    const ok = validate(validPayload({ plan_revision: 1 }));
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects plan_revision = 0 (below minimum)', () => {
    const ok = validate(validPayload({ plan_revision: 0 }));
    assert.equal(ok, false);
  });

  it('rejects non-integer plan_revision', () => {
    const ok = validate(validPayload({ plan_revision: 1.5 }));
    assert.equal(ok, false);
  });

  it('accepts plan_revision > 1 (re-post scenario)', () => {
    const ok = validate(validPayload({ plan_revision: 3 }));
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });
});

describe('story-plan-comment.schema.json — ac_mapping shape', () => {
  const validate = compile();

  it('accepts an empty ac_mapping object', () => {
    const ok = validate(validPayload({ ac_mapping: {} }));
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts ac_mapping entry with tests array only (notes optional)', () => {
    const ok = validate(
      validPayload({
        ac_mapping: {
          0: { tests: ['tests/foo.test.js'] },
        },
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts ac_mapping entry with notes included', () => {
    const ok = validate(
      validPayload({
        ac_mapping: {
          0: { tests: ['tests/foo.test.js'], notes: 'some note' },
        },
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects ac_mapping entry missing required tests field', () => {
    const ok = validate(
      validPayload({
        ac_mapping: {
          0: { notes: 'no tests provided' },
        },
      }),
    );
    assert.equal(ok, false);
  });

  it('rejects ac_mapping entry with extra unknown key (additionalProperties:false)', () => {
    const ok = validate(
      validPayload({
        ac_mapping: {
          0: { tests: ['foo.test.js'], mystery: true },
        },
      }),
    );
    assert.equal(ok, false);
  });
});

describe('story-plan-comment.schema.json — additionalProperties', () => {
  const validate = compile();

  it('rejects an unknown top-level key', () => {
    const ok = validate(validPayload({ unknown_field: 'surprise' }));
    assert.equal(ok, false);
    const extra = (validate.errors ?? []).find(
      (e) => e.keyword === 'additionalProperties',
    );
    assert.ok(
      extra,
      `expected additionalProperties error, got: ${JSON.stringify(validate.errors)}`,
    );
  });
});

describe('story-plan-comment.schema.json — round-trip parity with story-body conventions', () => {
  it('a plan with all fields serialises to JSON and validates on re-parse', () => {
    const validate = compile();
    const original = validPayload({
      files_to_touch: ['src/a.js', 'tests/a.test.js'],
      ac_mapping: {
        0: { tests: ['tests/a.test.js'], notes: 'covers AC-0' },
        1: { tests: ['tests/a.test.js'] },
      },
      open_questions: ['Is this the right helper to reuse?'],
      plan_revision: 2,
    });

    // Simulate a serialize → parse round-trip via JSON.
    const serialized = JSON.stringify(original);
    const reparsed = JSON.parse(serialized);
    const ok = validate(reparsed);
    assert.equal(ok, true, JSON.stringify(validate.errors));
    assert.deepEqual(reparsed, original);
  });
});
