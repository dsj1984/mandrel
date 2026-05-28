/**
 * Schema validation tests for the v5.33 structured task body.
 *
 *   - rejects each empty-section variant (changes / acceptance / verify);
 *   - rejects bullets that name no path-shaped token;
 *   - rejects vague verbs without a named target;
 *   - allows manual:<reason> in verify;
 *   - skips legacy string / undefined bodies (Feature/Story compat).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectTaskBodyErrors,
  validateTaskBodies,
  validateTaskBodyShape,
} from '../.agents/scripts/lib/orchestration/task-body-validator.js';

function task(slug, body) {
  return {
    slug,
    type: 'task',
    title: `Task ${slug}`,
    parent_slug: 's1',
    body,
  };
}

const validTaskBody = {
  goal: 'Wire X up to Y per story s1.',
  changes: ['src/x.ts: extract handleSubmit'],
  acceptance: ['npm run test exits 0'],
  verify: ['npm run test -- src/x.test.ts (unit)'],
};

describe('collectTaskBodyErrors — empty section detection', () => {
  it('passes a fully populated structured body', () => {
    assert.deepEqual(collectTaskBodyErrors([task('t1', validTaskBody)]), []);
  });

  it('rejects empty changes[]', () => {
    const errs = collectTaskBodyErrors([
      task('t1', { ...validTaskBody, changes: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.changes must list at least one bullet/);
  });

  it('rejects empty acceptance[]', () => {
    const errs = collectTaskBodyErrors([
      task('t1', { ...validTaskBody, acceptance: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.acceptance/);
  });

  it('rejects empty verify[]', () => {
    const errs = collectTaskBodyErrors([
      task('t1', { ...validTaskBody, verify: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.verify must list at least one entry/);
  });

  it('rejects empty goal string', () => {
    const errs = collectTaskBodyErrors([
      task('t1', { ...validTaskBody, goal: '   ' }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.goal must be a non-empty string/);
  });
});

describe('collectTaskBodyErrors — path-shape and vague-verb detection', () => {
  it('rejects bullets with no path-shaped token', () => {
    const errs = collectTaskBodyErrors([
      task('t1', {
        ...validTaskBody,
        changes: ['the form should be cleaner'],
      }),
    ]);
    assert.ok(
      errs.some((e) => /name no path-shaped token/.test(e)),
      errs.join('\n'),
    );
  });

  it('rejects vague verb without a path target', () => {
    const errs = collectTaskBodyErrors([
      task('t1', {
        ...validTaskBody,
        changes: ['clean up the form'],
      }),
    ]);
    assert.ok(
      errs.some((e) => /vague verb "clean up"/.test(e)),
      errs.join('\n'),
    );
  });

  it('accepts vague verb when paired with a named target', () => {
    const errs = collectTaskBodyErrors([
      task('t1', {
        ...validTaskBody,
        changes: ['src/components/Form.tsx: refactor handleSubmit'],
      }),
    ]);
    assert.deepEqual(errs, []);
  });

  it('accepts glob path shapes', () => {
    const errs = collectTaskBodyErrors([
      task('t1', {
        ...validTaskBody,
        changes: ['tests/e2e/*.spec.ts: add testid coverage'],
      }),
    ]);
    assert.deepEqual(errs, []);
  });
});

describe('collectTaskBodyErrors — verify entries', () => {
  it('accepts manual:<reason>', () => {
    const errs = collectTaskBodyErrors([
      task('t1', {
        ...validTaskBody,
        verify: ['manual: copy review by brand lead'],
      }),
    ]);
    assert.deepEqual(errs, []);
  });

  it('rejects manual: with no reason', () => {
    const errs = collectTaskBodyErrors([
      task('t1', { ...validTaskBody, verify: ['manual:'] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /"manual:" entry has no reason/);
  });
});

describe('collectTaskBodyErrors — legacy / non-structured bodies pass through', () => {
  it('skips tasks with string body (legacy)', () => {
    assert.deepEqual(
      collectTaskBodyErrors([task('t1', 'a plain string body')]),
      [],
    );
  });

  it('skips tasks with undefined body', () => {
    assert.deepEqual(collectTaskBodyErrors([task('t1', undefined)]), []);
  });

  it('skips Feature tickets regardless of body shape', () => {
    const tickets = [
      { slug: 'f1', type: 'feature', title: 'F', body: 'string is fine' },
      { slug: 'f2', type: 'feature', title: 'F2', body: { weird: true } },
    ];
    assert.deepEqual(collectTaskBodyErrors(tickets), []);
  });

  it('validates Story tickets with structured bodies (3-tier)', () => {
    // Under the 3-tier hierarchy Stories carry the implementation scope inline.
    // A Story with a structured body that violates the schema IS an error.
    const tickets = [
      { slug: 's1', type: 'story', title: 'S', body: { weird: true } },
    ];
    const errs = collectTaskBodyErrors(tickets);
    assert.ok(errs.length > 0, 'expected validation errors for a malformed story body');
  });

  it('skips Story tickets with string bodies (legacy pass-through)', () => {
    assert.deepEqual(
      collectTaskBodyErrors([{ slug: 's1', type: 'story', title: 'S', body: 'string body' }]),
      [],
    );
  });
});

describe('validateTaskBodies', () => {
  it('throws batched error containing every offending slug', () => {
    const tickets = [
      task('t1', { ...validTaskBody, changes: [] }),
      task('t2', { ...validTaskBody, verify: [] }),
    ];
    assert.throws(
      () => validateTaskBodies(tickets),
      /2 task body schema violation\(s\)[\s\S]*t1[\s\S]*t2/,
    );
  });

  it('returns tickets unchanged when clean', () => {
    const tickets = [task('t1', validTaskBody)];
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
      body: validTaskBody,
      expectErrors: 0,
    },
    {
      name: 'non-object body (number)',
      body: 42,
      expectIncludes: 'body must be an object, got number',
    },
    {
      name: 'goal missing',
      body: { ...validTaskBody, goal: undefined },
      expectIncludes: 'body.goal must be a non-empty string',
    },
    {
      name: 'goal blank',
      body: { ...validTaskBody, goal: '   ' },
      expectIncludes: 'body.goal must be a non-empty string',
    },
    {
      name: 'goal non-string',
      body: { ...validTaskBody, goal: 123 },
      expectIncludes: 'body.goal must be a non-empty string',
    },
    {
      name: 'changes empty array',
      body: { ...validTaskBody, changes: [] },
      expectIncludes: 'body.changes must list at least one bullet',
    },
    {
      name: 'changes not an array',
      body: { ...validTaskBody, changes: 'one bullet' },
      expectIncludes: 'body.changes must list at least one bullet',
    },
    {
      name: 'changes bullets name no path',
      body: { ...validTaskBody, changes: ['do the thing'] },
      expectIncludes: 'name no path-shaped token',
    },
    {
      name: 'changes bullet uses vague verb without target',
      body: {
        ...validTaskBody,
        changes: ['clean up things', 'src/x.ts: extract handleSubmit'],
      },
      expectIncludes: 'vague verb "clean up"',
    },
    {
      name: 'acceptance empty array',
      body: { ...validTaskBody, acceptance: [] },
      expectIncludes: 'body.acceptance must list at least one criterion',
    },
    {
      name: 'acceptance not an array',
      body: { ...validTaskBody, acceptance: 'one' },
      expectIncludes: 'body.acceptance must list at least one criterion',
    },
    {
      name: 'verify empty array',
      body: { ...validTaskBody, verify: [] },
      expectIncludes: 'body.verify must list at least one entry',
    },
    {
      name: 'verify manual: with no reason',
      body: { ...validTaskBody, verify: ['manual:'] },
      expectIncludes: '"manual:" entry has no reason after the colon',
    },
    {
      name: 'verify manual: with whitespace reason',
      body: { ...validTaskBody, verify: ['manual:   '] },
      expectIncludes: '"manual:" entry has no reason after the colon',
    },
    {
      name: 'verify manual: with valid reason is clean',
      body: { ...validTaskBody, verify: ['manual: see PR'] },
      expectErrors: 0,
    },
    {
      name: 'verify entries containing non-strings are tolerated',
      body: { ...validTaskBody, verify: [42, 'npm test'] },
      expectErrors: 0,
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const errors = validateTaskBodyShape(task('tX', tc.body));
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
