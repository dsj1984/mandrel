/**
 * Schema validation tests for the structured Story body (2-tier world).
 *
 *   - rejects each empty-section variant (changes / acceptance / verify);
 *   - rejects bullets that name no path-shaped token;
 *   - rejects vague verbs without a named target;
 *   - allows manual:<reason> in verify;
 *   - skips legacy string / undefined bodies (only structured object
 *     bodies are inspected).
 *
 * Story-typed fixtures are used throughout this file; under the 2-tier
 * hierarchy (Epic → Story) only `type: 'story'` tickets carry
 * structured bodies the validator inspects.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectTaskBodyErrors,
  validateTaskBodies,
  validateTaskBodyShape,
} from '../.agents/scripts/lib/orchestration/task-body-validator.js';
import { serialize } from '../.agents/scripts/lib/story-body/story-body.js';

function story(slug, body) {
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    body,
  };
}

const validStoryBody = {
  goal: 'Wire X up to Y per story s1.',
  changes: [{ path: 'src/x.ts', assumption: 'refactors-existing' }],
  acceptance: ['npm run test exits 0'],
  verify: ['npm run test -- src/x.test.ts (unit)'],
};

describe('collectTaskBodyErrors — empty section detection', () => {
  it('passes a fully populated structured body', () => {
    assert.deepEqual(collectTaskBodyErrors([story('t1', validStoryBody)]), []);
  });

  it('rejects empty changes[]', () => {
    const errs = collectTaskBodyErrors([
      story('t1', { ...validStoryBody, changes: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.changes must list at least one bullet/);
  });

  it('rejects empty acceptance[]', () => {
    const errs = collectTaskBodyErrors([
      story('t1', { ...validStoryBody, acceptance: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.acceptance/);
  });

  it('rejects empty verify[]', () => {
    const errs = collectTaskBodyErrors([
      story('t1', { ...validStoryBody, verify: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.verify must list at least one entry/);
  });

  it('rejects empty goal string', () => {
    const errs = collectTaskBodyErrors([
      story('t1', { ...validStoryBody, goal: '   ' }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.goal must be a non-empty string/);
  });
});

describe('collectTaskBodyErrors — path-shape and string-bullet rejection', () => {
  it('rejects changes with no valid object entries', () => {
    const errs = collectTaskBodyErrors([
      story('t1', {
        ...validStoryBody,
        changes: [{ path: '   ', assumption: 'creates' }],
      }),
    ]);
    assert.ok(
      errs.some((e) =>
        /must declare at least one \{ path, assumption \} object/.test(e),
      ),
      errs.join('\n'),
    );
  });

  it('rejects plain string change bullets', () => {
    const errs = collectTaskBodyErrors([
      story('t1', {
        ...validStoryBody,
        changes: ['clean up the form'],
      }),
    ]);
    assert.ok(
      errs.some((e) => /plain string bullets are no longer accepted/.test(e)),
      errs.join('\n'),
    );
  });

  it('accepts vague verb when paired with a named target', () => {
    const errs = collectTaskBodyErrors([
      story('t1', {
        ...validStoryBody,
        changes: [
          { path: 'src/components/Form.tsx', assumption: 'refactors-existing' },
        ],
      }),
    ]);
    assert.deepEqual(errs, []);
  });

  it('accepts glob path shapes', () => {
    const errs = collectTaskBodyErrors([
      story('t1', {
        ...validStoryBody,
        changes: [
          { path: 'tests/e2e/*.spec.ts', assumption: 'refactors-existing' },
        ],
      }),
    ]);
    assert.deepEqual(errs, []);
  });
});

describe('collectTaskBodyErrors — verify entries', () => {
  it('accepts manual:<reason>', () => {
    const errs = collectTaskBodyErrors([
      story('t1', {
        ...validStoryBody,
        verify: ['manual: copy review by brand lead'],
      }),
    ]);
    assert.deepEqual(errs, []);
  });

  it('rejects manual: with no reason', () => {
    const errs = collectTaskBodyErrors([
      story('t1', { ...validStoryBody, verify: ['manual:'] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /"manual:" entry has no reason/);
  });
});

describe('collectTaskBodyErrors — body routing (Story #3906)', () => {
  it('skips Story tickets with undefined body', () => {
    assert.deepEqual(collectTaskBodyErrors([story('t1', undefined)]), []);
  });

  it('skips Story tickets with null body', () => {
    assert.deepEqual(collectTaskBodyErrors([story('t1', null)]), []);
  });

  it('skips Story tickets with an empty / whitespace-only string body', () => {
    assert.deepEqual(collectTaskBodyErrors([story('t1', '   ')]), []);
  });

  it('skips Feature tickets regardless of body shape', () => {
    const tickets = [
      { slug: 'f1', type: 'feature', title: 'F', body: 'string is fine' },
      { slug: 'f2', type: 'feature', title: 'F2', body: { weird: true } },
    ];
    assert.deepEqual(collectTaskBodyErrors(tickets), []);
  });

  it('validates Story tickets with structured (object) bodies (2-tier)', () => {
    // Under the 2-tier hierarchy Stories carry the implementation scope inline.
    // A Story with a structured body that violates the schema IS an error.
    const tickets = [
      { slug: 's1', type: 'story', title: 'S', body: { weird: true } },
    ];
    const errs = collectTaskBodyErrors(tickets);
    assert.ok(
      errs.length > 0,
      'expected validation errors for a malformed story body',
    );
  });

  it('validates a serialized (string) Story body — the canonical decompose shape', () => {
    // Story #3906: the canonical decomposition serializes the body to a
    // markdown string. The validator now parses it back and validates the
    // sections rather than skipping it.
    const serialized = serialize(validStoryBody);
    assert.deepEqual(collectTaskBodyErrors([story('s1', serialized)]), []);
  });

  it('rejects a serialized string body whose verify entry lacks a tier suffix', () => {
    const serialized = serialize({
      ...validStoryBody,
      verify: ['npm run test'],
    });
    const errs = collectTaskBodyErrors([story('s1', serialized)]);
    assert.ok(
      errs.some((e) => e.includes('tier in parentheses')),
      `expected a verify tier-suffix error, got: ${JSON.stringify(errs)}`,
    );
  });

  it('rejects a legacy unstructured string body (no sections → empty arrays)', () => {
    // A free-text string body with no `## Goal/Changes/Acceptance/Verify`
    // sections parses to empty arrays and now fails the section checks —
    // the skill mandates a serialized structured body end-to-end.
    const errs = collectTaskBodyErrors([
      { slug: 's1', type: 'story', title: 'S', body: 'a plain string body' },
    ]);
    assert.ok(
      errs.some((e) => e.includes('body.changes')),
      `expected a missing-changes error, got: ${JSON.stringify(errs)}`,
    );
  });
});

describe('validateTaskBodies', () => {
  it('throws batched error containing every offending slug', () => {
    const tickets = [
      story('t1', { ...validStoryBody, changes: [] }),
      story('t2', { ...validStoryBody, verify: [] }),
    ];
    assert.throws(
      () => validateTaskBodies(tickets),
      /2 story body schema violation\(s\)[\s\S]*t1[\s\S]*t2/,
    );
  });

  it('returns tickets unchanged when clean', () => {
    const tickets = [story('t1', validStoryBody)];
    assert.equal(validateTaskBodies(tickets), tickets);
  });
});

describe('validateTaskBodyShape (predicate)', () => {
  /**
   * Table-driven coverage of every branch in the per-task predicate. The
   * iterating wrapper (`collectTaskBodyErrors`) is already covered above;
   * these rows exercise the predicate directly so each defensive guard
   * has a named row.
   */
  const cases = [
    {
      name: 'happy path: every section populated',
      body: validStoryBody,
      expectErrors: 0,
    },
    {
      name: 'non-object body (number)',
      body: 42,
      expectIncludes: 'body must be an object, got number',
    },
    {
      name: 'goal missing',
      body: { ...validStoryBody, goal: undefined },
      expectIncludes: 'body.goal must be a non-empty string',
    },
    {
      name: 'goal blank',
      body: { ...validStoryBody, goal: '   ' },
      expectIncludes: 'body.goal must be a non-empty string',
    },
    {
      name: 'goal non-string',
      body: { ...validStoryBody, goal: 123 },
      expectIncludes: 'body.goal must be a non-empty string',
    },
    {
      name: 'changes empty array',
      body: { ...validStoryBody, changes: [] },
      expectIncludes: 'body.changes must list at least one bullet',
    },
    {
      name: 'changes not an array',
      body: { ...validStoryBody, changes: 'one bullet' },
      expectIncludes: 'body.changes must list at least one bullet',
    },
    {
      name: 'changes with no valid object entries',
      body: { ...validStoryBody, changes: [{ assumption: 'creates' }] },
      expectIncludes: 'must declare at least one { path, assumption } object',
    },
    {
      name: 'changes plain string bullet rejected',
      body: {
        ...validStoryBody,
        changes: [
          'clean up things',
          { path: 'src/x.ts', assumption: 'refactors-existing' },
        ],
      },
      expectIncludes: 'plain string bullets are no longer accepted',
    },
    {
      name: 'acceptance empty array',
      body: { ...validStoryBody, acceptance: [] },
      expectIncludes: 'body.acceptance must list at least one criterion',
    },
    {
      name: 'acceptance not an array',
      body: { ...validStoryBody, acceptance: 'one' },
      expectIncludes: 'body.acceptance must list at least one criterion',
    },
    {
      name: 'verify empty array',
      body: { ...validStoryBody, verify: [] },
      expectIncludes: 'body.verify must list at least one entry',
    },
    {
      name: 'verify manual: with no reason',
      body: { ...validStoryBody, verify: ['manual:'] },
      expectIncludes: '"manual:" entry has no reason after the colon',
    },
    {
      name: 'verify manual: with whitespace reason',
      body: { ...validStoryBody, verify: ['manual:   '] },
      expectIncludes: '"manual:" entry has no reason after the colon',
    },
    {
      name: 'verify manual: with valid reason is clean',
      body: { ...validStoryBody, verify: ['manual: see PR'] },
      expectErrors: 0,
    },
    {
      name: 'verify entries containing non-strings are tolerated',
      body: { ...validStoryBody, verify: [42, 'npm test (unit)'] },
      expectErrors: 0,
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const errors = validateTaskBodyShape(story('tX', tc.body));
      if (tc.expectErrors === 0) {
        assert.deepEqual(errors, []);
      } else {
        assert.ok(
          errors.some((e) => e.includes(tc.expectIncludes)),
          `expected errors to include ${JSON.stringify(tc.expectIncludes)}; got: ${JSON.stringify(errors)}`,
        );
      }
    });
  }
});

describe('v2 — optional `## Slicing` slice plan', () => {
  it('validates clean when a Story carries a folded slice plan', () => {
    const withSlicing = {
      ...validStoryBody,
      slicing: '- slice 1: schema\n- slice 2: handler on the schema',
    };
    assert.deepEqual(
      collectTaskBodyErrors([story('s-slice', withSlicing)]),
      [],
    );
  });

  it('validates clean through the serialized (string) body path', () => {
    const md = serialize({
      goal: 'Deliver the widget.',
      slicing: '- slice 1: do it',
      changes: [{ path: 'src/w.ts', assumption: 'creates' }],
      acceptance: ['widget renders'],
      verify: ['npm test (unit)'],
    });
    assert.deepEqual(validateTaskBodyShape(story('s-slice-md', md)), []);
  });
});
