/**
 * Fixture tests for `.agents/schemas/epic-spec.schema.json`
 * (Epic #1182 / Story #1490 / Task #1506).
 *
 * Contract:
 *   - Positive fixtures (minimal + full Epic) validate without errors.
 *   - Negative fixtures produce errors at expected JSON-Schema paths:
 *       missing-features      → required at `/features`
 *       missing-parent (epic) → required at `/epic`
 *       unknown-property      → additionalProperties under `/epic`
 *       bad-slug              → pattern violation under
 *                               `/features/0/slug`
 *
 * The schema is draft 2020-12, so the test uses Ajv2020 (the project's
 * existing ajv setup at version ^8.18.0). No new validator dependency
 * is introduced (Task #1506 AC).
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'epic-spec.schema.json',
);
const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'epic-specs');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function compileSchema() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function loadFixture(name) {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'),
  );
}

describe('epic-spec.schema.json — structural metadata', () => {
  it('declares draft 2020-12 and the canonical $id', () => {
    assert.equal(
      schema.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
    assert.match(schema.$id, /epic-spec\.schema\.json$/);
  });

  it('requires the top-level `epic` and `features` keys', () => {
    assert.deepEqual(schema.required, ['epic', 'features']);
  });

  it('disallows additional top-level properties (closed contract)', () => {
    assert.equal(schema.additionalProperties, false);
  });

  it('declares descriptions on every named property under properties/$defs', () => {
    const missing = [];
    const walk = (node, where) => {
      if (!node || typeof node !== 'object') return;
      if (where.endsWith('/properties') || where.endsWith('/$defs')) {
        for (const [key, value] of Object.entries(node)) {
          if (!value || typeof value !== 'object') continue;
          if (!('description' in value)) {
            missing.push(`${where}/${key}`);
          }
        }
      }
      for (const [k, v] of Object.entries(node)) {
        walk(v, `${where}/${k}`);
      }
    };
    walk(schema, '');
    assert.deepEqual(
      missing,
      [],
      `Found properties without description: ${missing.join(', ')}`,
    );
  });

  it('ships at least one fixture file (sanity guard against empty dir)', () => {
    const entries = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
    assert.ok(
      entries.length >= 2,
      `Expected >=2 fixture files, got ${entries.length}: ${entries.join(', ')}`,
    );
  });
});

describe('epic-spec.schema.json — positive fixtures', () => {
  it('validates the minimal Epic fixture (epic + empty features)', () => {
    const validate = compileSchema();
    const fixture = loadFixture('minimal');
    const ok = validate(fixture);
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('validates the full Epic fixture (multi-feature, wave deps, gates, labels)', () => {
    const validate = compileSchema();
    const fixture = loadFixture('full');
    const ok = validate(fixture);
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });
});

describe('epic-spec.schema.json — Story inline acceptance/verify (Epic #3078)', () => {
  it('validates a Story carrying inline acceptance[] and verify[] (3-tier shape)', () => {
    const validate = compileSchema();
    const fixture = loadFixture('story-inline-acceptance');
    const ok = validate(fixture);
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects a Story that contains a tasks[] field (4-tier shape removed)', () => {
    const validate = compileSchema();
    const spec = {
      version: '3.0.0',
      epic: { id: 3078, title: 'E', labels: ['type::epic'] },
      features: [
        {
          slug: 'f1',
          title: 'Feature 1',
          stories: [
            {
              slug: 's-with-tasks',
              title: 'Story illegally carrying tasks[]',
              wave: 0,
              acceptance: ['something'],
              verify: ['node --test'],
              tasks: [{ slug: 't1', title: 'A task' }],
            },
          ],
        },
      ],
    };
    const ok = validate(spec);
    assert.equal(ok, false, 'tasks[] under a Story must be rejected');
    const errors = validate.errors ?? [];
    const additional = errors.find(
      (e) =>
        e.keyword === 'additionalProperties' &&
        e.params?.additionalProperty === 'tasks',
    );
    assert.ok(
      additional,
      `Expected an additionalProperties violation for "tasks", got: ${JSON.stringify(errors)}`,
    );
  });

  it('exposes the schema-shape `version` identifier (identification-only)', () => {
    assert.equal(typeof schema.version, 'string');
    assert.match(schema.version, /^\d+\.\d+\.\d+$/);
    // Spec instances may optionally declare their own `version`; the schema
    // accepts strings matching semver triplet.
    const validate = compileSchema();
    const ok = validate({
      version: '3.0.0',
      epic: { id: 1, title: 'v' },
      features: [],
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });
});

describe('epic-spec.schema.json — negative fixtures', () => {
  it('rejects a spec missing the top-level features array (required violation)', () => {
    const validate = compileSchema();
    const fixture = loadFixture('invalid-missing-features');
    const ok = validate(fixture);
    assert.equal(ok, false);
    const errors = validate.errors ?? [];
    const required = errors.find(
      (e) =>
        e.keyword === 'required' && e.params?.missingProperty === 'features',
    );
    assert.ok(
      required,
      `Expected a required-violation for "features", got: ${JSON.stringify(errors)}`,
    );
  });

  it('rejects a spec missing the top-level epic object (required violation)', () => {
    const validate = compileSchema();
    const fixture = loadFixture('invalid-missing-parent');
    const ok = validate(fixture);
    assert.equal(ok, false);
    const errors = validate.errors ?? [];
    const required = errors.find(
      (e) => e.keyword === 'required' && e.params?.missingProperty === 'epic',
    );
    assert.ok(
      required,
      `Expected a required-violation for "epic", got: ${JSON.stringify(errors)}`,
    );
  });

  it('rejects an unknown property under epic (additionalProperties violation)', () => {
    const validate = compileSchema();
    const fixture = loadFixture('invalid-unknown-property');
    const ok = validate(fixture);
    assert.equal(ok, false);
    const errors = validate.errors ?? [];
    const additional = errors.find(
      (e) =>
        e.keyword === 'additionalProperties' &&
        String(e.instancePath ?? '').startsWith('/epic'),
    );
    assert.ok(
      additional,
      `Expected an additionalProperties violation under /epic, got: ${JSON.stringify(errors)}`,
    );
    assert.equal(additional.params?.additionalProperty, 'owner');
  });

  it('rejects a slug that violates the kebab-case pattern', () => {
    const validate = compileSchema();
    const fixture = loadFixture('invalid-bad-slug');
    const ok = validate(fixture);
    assert.equal(ok, false);
    const errors = validate.errors ?? [];
    const patternErr = errors.find(
      (e) =>
        e.keyword === 'pattern' &&
        String(e.instancePath ?? '').includes('/features/0/slug'),
    );
    assert.ok(
      patternErr,
      `Expected a pattern violation under /features/0/slug, got: ${JSON.stringify(errors)}`,
    );
  });
});
