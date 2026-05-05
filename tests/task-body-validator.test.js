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

  it('skips Features and Stories regardless of body shape', () => {
    const tickets = [
      { slug: 'f1', type: 'feature', title: 'F', body: 'string is fine' },
      { slug: 's1', type: 'story', title: 'S', body: { weird: true } },
    ];
    assert.deepEqual(collectTaskBodyErrors(tickets), []);
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
