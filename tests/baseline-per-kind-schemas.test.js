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
//   3. reject an envelope whose rollup shape does not match its row shape.
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
  'lint.schema.json',
  'coverage.schema.json',
  'crap.schema.json',
  'maintainability.schema.json',
  'mutation.schema.json',
  'lighthouse.schema.json',
  'bundle-size.schema.json',
];

const CANONICAL_FIXTURES = {
  'lint.schema.json': {
    $schema: '.agents/schemas/baselines/lint.schema.json',
    kernelVersion: '1.0.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: { '*': { errorCount: 0, warningCount: 3 } },
    rows: [{ path: 'src/a.js', errorCount: 0, warningCount: 1 }],
  },
  'coverage.schema.json': {
    $schema: '.agents/schemas/baselines/coverage.schema.json',
    kernelVersion: '1.0.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: { '*': { lines: 90, branches: 85, functions: 88 } },
    rows: [{ path: 'src/a.js', lines: 91, branches: 80, functions: 100 }],
  },
  'crap.schema.json': {
    $schema: '.agents/schemas/baselines/crap.schema.json',
    kernelVersion: '1.1.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: { '*': { p50: 1.5, p95: 12, max: 25, methodsAbove20: 2 } },
    rows: [{ path: 'src/a.js', method: 'foo', startLine: 10, crap: 4.2 }],
  },
  'maintainability.schema.json': {
    $schema: '.agents/schemas/baselines/maintainability.schema.json',
    kernelVersion: '1.0.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: { '*': { min: 55, p50: 72, p95: 85 } },
    rows: [{ path: 'src/a.js', mi: 72 }],
  },
  'mutation.schema.json': {
    $schema: '.agents/schemas/baselines/mutation.schema.json',
    kernelVersion: '1.0.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: { '*': { score: 75, killed: 30, survived: 10, noCoverage: 2 } },
    rows: [{ path: 'src/a.js', score: 80, killed: 8, survived: 2 }],
  },
  'lighthouse.schema.json': {
    $schema: '.agents/schemas/baselines/lighthouse.schema.json',
    kernelVersion: '1.0.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: {
      '*': { performance: 90, accessibility: 95, bestPractices: 92, seo: 100 },
    },
    rows: [
      {
        route: '/',
        performance: 90,
        accessibility: 95,
        bestPractices: 92,
        seo: 100,
      },
    ],
  },
  'bundle-size.schema.json': {
    $schema: '.agents/schemas/baselines/bundle-size.schema.json',
    kernelVersion: '1.0.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: { '*': { totalKb: 250, gzippedKb: 80 } },
    rows: [{ bundle: 'main', rawKb: 250, gzippedKb: 80 }],
  },
};

// Cross-kind rollup-shape used to prove each schema rejects a rollup whose
// keys do not match its own row shape. Picked so it never matches any of
// the seven kinds' rollup contracts.
const MISMATCHED_ROLLUP = { '*': { mystery: 1, totallyUnknown: 'no' } };

describe('per-kind baseline schemas (Story #1888)', () => {
  it('exposes all seven schema files plus the envelope on disk', () => {
    const files = readdirSync(SCHEMAS_DIR).filter((f) =>
      f.endsWith('.schema.json'),
    );
    for (const f of [...KIND_FILES, 'baseline-envelope.schema.json']) {
      assert.ok(files.includes(f), `missing schema file: ${f}`);
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

      it('rejects an envelope whose rollup keys do not match its row shape', () => {
        const ajv = buildAjv();
        const validate = ajv.compile(schema);
        const envelopeWithBadRollup = {
          ...CANONICAL_FIXTURES[filename],
          rollup: MISMATCHED_ROLLUP,
        };
        const ok = validate(envelopeWithBadRollup);
        assert.equal(
          ok,
          false,
          `${filename} should reject a mismatched rollup shape, but accepted it`,
        );
      });
    });
  }
});
