/**
 * tests/contract/planning/three-tier-schema.test.js
 *
 * Contract: `.agents/schemas/epic-spec.schema.json` accepts the 3-tier
 * collapse shape (Epic #3078): a Story object that carries inline
 * `acceptance[]` and `verify[]` arrays with no `tasks[]`, plus the
 * coexistence case where a Story carries both shapes simultaneously.
 *
 * Asserts (this file owns the contract surface under tests/contract/):
 *   - A Story object containing inline acceptance[] + verify[] (no
 *     tasks[]) validates against epic-spec.schema.json.
 *   - A Story object containing both inline acceptance[] + verify[]
 *     AND a tasks[] decomposition validates (coexistence).
 *   - The legacy 4-tier shape (Story with only tasks[]) continues to
 *     validate, so the additive change is non-breaking.
 *   - A Story object whose inline acceptance[] entry is the empty string
 *     fails validation (minLength: 1 is load-bearing).
 *
 * Story #3136 (Epic #3078, Feature #3093). Mirrors / complements the
 * fixture-based test under tests/scripts/epic-spec-schema.test.js with a
 * minimal, in-line spec object so the contract surface is exercised
 * without an external fixture file.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  '..',
  '.agents',
  'schemas',
  'epic-spec.schema.json',
);

function compileSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function formatErrors(errors) {
  return JSON.stringify(errors ?? [], null, 2);
}

describe('epic-spec.schema.json — 3-tier Story shape (Story #3136)', () => {
  it('accepts a Story with inline acceptance[] + verify[] and no tasks[]', () => {
    // Arrange
    const validate = compileSchema();
    const spec = {
      version: '2.0.0',
      epic: { id: 3078, title: 'E', labels: ['type::epic'] },
      features: [
        {
          slug: 'f1',
          title: 'Feature 1',
          stories: [
            {
              slug: 's1',
              title: 'Inline-only Story',
              wave: 0,
              acceptance: [
                'A Story with inline acceptance validates',
                'A second criterion proves arrays are accepted',
              ],
              verify: [
                'node --test tests/contract/planning/three-tier-schema.test.js',
              ],
            },
          ],
        },
      ],
    };

    // Act
    const ok = validate(spec);

    // Assert
    assert.equal(ok, true, formatErrors(validate.errors));
  });

  it('accepts a Story carrying BOTH inline acceptance/verify AND tasks[] (coexistence)', () => {
    // Arrange
    const validate = compileSchema();
    const spec = {
      version: '2.0.0',
      epic: { id: 3078, title: 'E', labels: ['type::epic'] },
      features: [
        {
          slug: 'f1',
          title: 'Feature 1',
          stories: [
            {
              slug: 's-both',
              title: 'Coexistence Story',
              wave: 0,
              acceptance: ['Both shapes coexist on the same Story'],
              verify: ['node --test'],
              tasks: [
                {
                  slug: 't1',
                  title: 'Decomposed task',
                  labels: ['type::task'],
                },
              ],
            },
          ],
        },
      ],
    };

    // Act
    const ok = validate(spec);

    // Assert
    assert.equal(ok, true, formatErrors(validate.errors));
  });

  it('accepts the legacy 4-tier Story shape (tasks[] only, no inline arrays)', () => {
    // Arrange — regression guard: the additive change must not break the
    // pre-3-tier shape that consumers still emit.
    const validate = compileSchema();
    const spec = {
      epic: { id: 3078, title: 'E', labels: ['type::epic'] },
      features: [
        {
          slug: 'f1',
          title: 'Feature 1',
          stories: [
            {
              slug: 's-legacy',
              title: 'Legacy 4-tier Story',
              wave: 0,
              tasks: [{ slug: 't1', title: 'Legacy decomposed task' }],
            },
          ],
        },
      ],
    };

    // Act
    const ok = validate(spec);

    // Assert
    assert.equal(ok, true, formatErrors(validate.errors));
  });

  it('rejects a Story whose inline acceptance[] entry is the empty string', () => {
    // Arrange — minLength: 1 is the only constraint on individual
    // acceptance[]/verify[] items; assert it holds so empty checklist
    // lines cannot sneak through.
    const validate = compileSchema();
    const spec = {
      version: '2.0.0',
      epic: { id: 3078, title: 'E', labels: ['type::epic'] },
      features: [
        {
          slug: 'f1',
          title: 'Feature 1',
          stories: [
            {
              slug: 's-bad',
              title: 'Story with empty acceptance entry',
              wave: 0,
              acceptance: [''],
              verify: ['node --test'],
            },
          ],
        },
      ],
    };

    // Act
    const ok = validate(spec);

    // Assert
    assert.equal(ok, false);
    const errors = validate.errors ?? [];
    const minLen = errors.find(
      (e) =>
        e.keyword === 'minLength' &&
        String(e.instancePath ?? '').includes('/acceptance/0'),
    );
    assert.ok(
      minLen,
      `Expected a minLength violation under /features/0/stories/0/acceptance/0, got: ${formatErrors(errors)}`,
    );
  });
});
