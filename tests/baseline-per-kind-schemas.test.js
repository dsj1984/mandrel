import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// ---------------------------------------------------------------------------
// Fixture tests for the seven per-kind baseline schemas (Story #1888).
//
// Every per-kind schema (lint, coverage, crap, maintainability, mutation,
// lighthouse, bundle-size) MUST:
//   1. extend baseline-envelope.schema.json via allOf,
//   2. accept its canonical envelope shape, and
//   3. reject the retired `generatedAt` and `rollup` keys (Story #5400): both
//      were rewritten on every refresh, so disjoint refreshes always
//      conflicted textually; readers derive the rollup from rows[].
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(
  __dirname,
  '..',
  '.agents',
  'schemas',
  'baselines',
);

const loadSchema = (filename) =>
  JSON.parse(readFileSync(path.join(SCHEMAS_DIR, filename), 'utf8'));

const envelope = loadSchema('baseline-envelope.schema.json');

const buildAjv = () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(envelope, 'baseline-envelope.schema.json');
  return ajv;
};

const KIND_FILES = [
  'coverage.schema.json',
  'crap.schema.json',
  'maintainability.schema.json',
  'mutation.schema.json',
  'bundle-size.schema.json',
  'duplication.schema.json',
];

const CANONICAL_FIXTURES = {
  'coverage.schema.json': {
    $schema: '.agents/schemas/baselines/coverage.schema.json',
    kernelVersion: '1.0.0',
    rows: [{ path: 'src/a.js', lines: 91, branches: 80, functions: 100 }],
  },
  'crap.schema.json': {
    $schema: '.agents/schemas/baselines/crap.schema.json',
    kernelVersion: '1.1.0',
    rows: [{ path: 'src/a.js', method: 'foo', startLine: 10, crap: 4.2 }],
  },
  'maintainability.schema.json': {
    $schema: '.agents/schemas/baselines/maintainability.schema.json',
    kernelVersion: '1.0.0',
    rows: [{ path: 'src/a.js', mi: 72 }],
  },
  'mutation.schema.json': {
    $schema: '.agents/schemas/baselines/mutation.schema.json',
    kernelVersion: '1.0.0',
    rows: [{ path: 'src/a.js', score: 80, killed: 8, survived: 2 }],
  },
  'bundle-size.schema.json': {
    $schema: '.agents/schemas/baselines/bundle-size.schema.json',
    kernelVersion: '1.0.0',
    rows: [{ bundle: 'main', rawKb: 250, gzippedKb: 80 }],
  },
  'duplication.schema.json': {
    $schema: '.agents/schemas/baselines/duplication.schema.json',
    kernelVersion: '1.0.0',
    rows: [
      {
        path: 'src/a.js',
        duplicatedLines: 21,
        totalLines: 200,
        percentage: 10.5,
      },
    ],
  },
};

// Retired top-level keys every per-kind schema must now reject.
const RETIRED_KEYS = {
  generatedAt: '2026-05-15T00:00:00Z',
  rollup: { '*': {} },
};

describe('per-kind baseline schemas (Story #1888)', () => {
  it('exposes all six schema files plus the envelope on disk', () => {
    const files = readdirSync(SCHEMAS_DIR).filter((f) =>
      f.endsWith('.schema.json'),
    );
    for (const f of [...KIND_FILES, 'baseline-envelope.schema.json']) {
      assert.ok(files.includes(f), `missing schema file: ${f}`);
    }
    // Story #5382 removed the lint and lighthouse gates end to end.
    for (const gone of ['lint.schema.json', 'lighthouse.schema.json']) {
      assert.equal(files.includes(gone), false, `${gone} should be deleted`);
    }
  });

  for (const filename of KIND_FILES) {
    describe(filename, () => {
      const schema = loadSchema(filename);

      it('references baseline-envelope.schema.json via allOf', () => {
        assert.ok(Array.isArray(schema.allOf), `${filename} missing allOf`);
        const refs = schema.allOf.map((entry) => entry.$ref).filter(Boolean);
        assert.ok(
          refs.some((r) => r.endsWith('baseline-envelope.schema.json')),
          `${filename} allOf must reference baseline-envelope.schema.json`,
        );
      });

      it('accepts the canonical envelope shape', () => {
        const ajv = buildAjv();
        const validate = ajv.compile(schema);
        const ok = validate(CANONICAL_FIXTURES[filename]);
        assert.equal(
          ok,
          true,
          `${filename} rejected its canonical fixture: ${JSON.stringify(validate.errors)}`,
        );
      });

      for (const [key, value] of Object.entries(RETIRED_KEYS)) {
        it(`rejects an envelope carrying the retired "${key}" key`, () => {
          const ajv = buildAjv();
          const validate = ajv.compile(schema);
          const ok = validate({
            ...CANONICAL_FIXTURES[filename],
            [key]: value,
          });
          assert.equal(
            ok,
            false,
            `${filename} should reject a "${key}" key, but accepted it`,
          );
          assert.ok(
            validate.errors.some(
              (e) =>
                e.keyword === 'additionalProperties' &&
                e.params.additionalProperty === key,
            ),
            `${filename} rejected for the wrong reason: ${JSON.stringify(validate.errors)}`,
          );
        });
      }
    });
  }
});
