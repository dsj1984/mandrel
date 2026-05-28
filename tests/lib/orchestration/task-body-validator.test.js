/**
 * tests/lib/orchestration/task-body-validator.test.js
 *
 * Plan-time validation coverage for the Story-body shape (3-tier world) and
 * the verify[] tier-suffix contract introduced by Story #3232:
 *
 *   - verify[] entries must name a testing tier in parentheses drawn from
 *     VERIFY_TIER_VALUES (unit / contract / e2e / validate) OR use the
 *     `manual:<reason>` escape hatch.
 *   - Story tickets with structured bodies are now validated the same way
 *     Tasks were; Feature tickets and string-bodied Story tickets still
 *     pass through.
 *   - assumption enum values in changes[] / references[] are validated for
 *     both task and story bodies.
 *
 * The existing root-level tests/task-body-validator.test.js covers the
 * original task-only surface; this file extends coverage for the new
 * Story-body and tier-suffix paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectTaskBodyErrors,
  validateTaskBodyShape,
  VERIFY_TIER_VALUES,
} from '../../../.agents/scripts/lib/orchestration/task-body-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function story(slug, body) {
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    body,
  };
}

function task(slug, body) {
  return {
    slug,
    type: 'task',
    title: `Task ${slug}`,
    parent_slug: 's1',
    body,
  };
}

const VALID_STORY_BODY = {
  goal: 'Wire X up to Y per feature f1.',
  changes: [
    { path: 'src/x.ts', assumption: 'creates' },
    { path: 'src/y.ts', assumption: 'refactors-existing' },
  ],
  acceptance: ['npm run test exits 0', 'the feature works end-to-end'],
  verify: ['npm run test -- src/x.test.ts (unit)'],
};

// ---------------------------------------------------------------------------
// VERIFY_TIER_VALUES export
// ---------------------------------------------------------------------------

describe('VERIFY_TIER_VALUES — exported constant', () => {
  it('exports the canonical tier list', () => {
    assert.deepEqual([...VERIFY_TIER_VALUES], ['unit', 'contract', 'e2e', 'validate']);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(VERIFY_TIER_VALUES));
  });
});

// ---------------------------------------------------------------------------
// Story body: shouldSkipTicket routing
// ---------------------------------------------------------------------------

describe('collectTaskBodyErrors — Story ticket routing (3-tier)', () => {
  it('validates a Story with a structured body', () => {
    const errs = collectTaskBodyErrors([story('s1', VALID_STORY_BODY)]);
    assert.deepEqual(errs, []);
  });

  it('skips a Story with a string body (legacy pass-through)', () => {
    const errs = collectTaskBodyErrors([story('s1', 'a plain string body')]);
    assert.deepEqual(errs, []);
  });

  it('skips a Story with a null body', () => {
    const errs = collectTaskBodyErrors([story('s1', null)]);
    assert.deepEqual(errs, []);
  });

  it('skips a Story with an undefined body', () => {
    const errs = collectTaskBodyErrors([story('s1', undefined)]);
    assert.deepEqual(errs, []);
  });

  it('skips Feature tickets regardless of body', () => {
    const tickets = [
      { slug: 'f1', type: 'feature', title: 'F', body: { weird: true } },
    ];
    assert.deepEqual(collectTaskBodyErrors(tickets), []);
  });

  it('still validates Task tickets with structured bodies', () => {
    const taskBody = { ...VALID_STORY_BODY };
    const errs = collectTaskBodyErrors([task('t1', taskBody)]);
    assert.deepEqual(errs, []);
  });
});

// ---------------------------------------------------------------------------
// Story body: required section validation
// ---------------------------------------------------------------------------

describe('collectTaskBodyErrors — Story body required sections', () => {
  it('rejects an empty goal', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, goal: '   ' }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.goal must be a non-empty string/);
  });

  it('rejects empty changes[]', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, changes: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.changes must list at least one bullet/);
  });

  it('rejects empty acceptance[]', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, acceptance: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.acceptance must list at least one criterion/);
  });

  it('rejects empty verify[]', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.verify must list at least one entry/);
  });

  it('prefixes errors with "Story" for story tickets', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, goal: '' }),
    ]);
    assert.ok(errs.some((e) => /^Story "/.test(e)), errs.join('\n'));
  });

  it('prefixes errors with "Task" for task tickets', () => {
    const errs = collectTaskBodyErrors([
      task('t1', { ...VALID_STORY_BODY, goal: '' }),
    ]);
    assert.ok(errs.some((e) => /^Task "/.test(e)), errs.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// verify[] tier-suffix validation
// ---------------------------------------------------------------------------

describe('collectTaskBodyErrors — verify[] tier-suffix (Story bodies)', () => {
  for (const tier of VERIFY_TIER_VALUES) {
    it(`accepts a verify entry ending with (${tier})`, () => {
      const errs = collectTaskBodyErrors([
        story('s1', {
          ...VALID_STORY_BODY,
          verify: [`npm run test (${tier})`],
        }),
      ]);
      assert.deepEqual(errs, []);
    });
  }

  it('rejects a verify entry with no tier suffix', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: ['npm run test'] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /must end with a tier in parentheses/);
  });

  it('includes the offending entry in the error message', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: ['npm run test'] }),
    ]);
    assert.match(errs[0], /"npm run test"/);
  });

  it('rejects a verify entry with an unknown tier (e.g. (smoke))', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: ['npm run test (smoke)'] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /must end with a tier in parentheses/);
  });

  it('accepts manual:<reason> as the unverifiable escape hatch', () => {
    const errs = collectTaskBodyErrors([
      story('s1', {
        ...VALID_STORY_BODY,
        verify: ['manual: brand-lead approval required'],
      }),
    ]);
    assert.deepEqual(errs, []);
  });

  it('rejects manual: with no reason after the colon', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: ['manual:'] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /"manual:" entry has no reason/);
  });

  it('rejects manual: with only whitespace after the colon', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: ['manual:   '] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /"manual:" entry has no reason/);
  });

  it('tolerates non-string verify entries without emitting a tier error', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: [42, 'npm run test (unit)'] }),
    ]);
    assert.deepEqual(errs, []);
  });

  it('batches tier errors across multiple invalid entries', () => {
    const errs = collectTaskBodyErrors([
      story('s1', {
        ...VALID_STORY_BODY,
        verify: ['npm run test', 'npm run lint'],
      }),
    ]);
    assert.equal(errs.length, 2);
    for (const e of errs) {
      assert.match(e, /must end with a tier in parentheses/);
    }
  });

  it('does not apply the tier-suffix rule to Task verify[] entries (legacy tier)', () => {
    // Task tickets are a legacy shape — their verify[] entries may be free-form.
    // Only Story tickets (3-tier implementation unit) require a tier suffix.
    const errs = collectTaskBodyErrors([
      task('t1', { ...VALID_STORY_BODY, verify: ['npm run test'] }),
    ]);
    assert.deepEqual(errs, []);
  });
});

// ---------------------------------------------------------------------------
// assumption enum validation for Story changes[]
// ---------------------------------------------------------------------------

describe('collectTaskBodyErrors — assumption enum (Story changes[])', () => {
  it('accepts all valid assumption values in Story changes[]', () => {
    const errs = collectTaskBodyErrors([
      story('s1', {
        ...VALID_STORY_BODY,
        changes: [
          { path: 'src/a.ts', assumption: 'creates' },
          { path: 'src/b.ts', assumption: 'refactors-existing' },
          { path: 'src/c.ts', assumption: 'deletes' },
        ],
      }),
    ]);
    assert.deepEqual(errs, []);
  });

  it('rejects a Story changes[] object entry with an unknown assumption', () => {
    const errs = collectTaskBodyErrors([
      story('s1', {
        ...VALID_STORY_BODY,
        changes: [{ path: 'src/x.ts', assumption: 'rewires' }],
      }),
    ]);
    assert.ok(
      errs.some((e) => /assumption: one of/.test(e)),
      errs.join('\n'),
    );
  });

  it('rejects a Story changes[] object entry missing the path field', () => {
    const errs = collectTaskBodyErrors([
      story('s1', {
        ...VALID_STORY_BODY,
        changes: [{ assumption: 'creates' }],
      }),
    ]);
    assert.ok(
      errs.some((e) => /assumption: one of/.test(e)),
      errs.join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// assumption enum validation for Story references[]
// ---------------------------------------------------------------------------

describe('collectTaskBodyErrors — assumption enum (Story references[])', () => {
  it('accepts valid references[] entries on a Story', () => {
    const errs = collectTaskBodyErrors([
      story('s1', {
        ...VALID_STORY_BODY,
        references: [
          { path: 'tests/fixtures/auth.json', assumption: 'exists' },
        ],
      }),
    ]);
    assert.deepEqual(errs, []);
  });

  it('rejects Story references[] entries with invalid assumption values', () => {
    const errs = collectTaskBodyErrors([
      story('s1', {
        ...VALID_STORY_BODY,
        references: [{ path: 'tests/fixtures/auth.json', assumption: 'bogus' }],
      }),
    ]);
    assert.ok(
      errs.some((e) => /body\.references entry/.test(e)),
      errs.join('\n'),
    );
  });

  it('rejects Story references[] that is not an array', () => {
    const errs = collectTaskBodyErrors([
      story('s1', {
        ...VALID_STORY_BODY,
        references: 'not-an-array',
      }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /body\.references must be an array/);
  });
});

// ---------------------------------------------------------------------------
// validateTaskBodyShape direct predicate — Story-specific prefix
// ---------------------------------------------------------------------------

describe('validateTaskBodyShape — Story prefix in error messages', () => {
  it('uses "Story" as the prefix for type::story tickets', () => {
    const errors = validateTaskBodyShape(story('s1', { ...VALID_STORY_BODY, goal: '' }));
    assert.ok(
      errors.some((e) => e.startsWith('Story "Story s1" (s1)')),
      errors.join('\n'),
    );
  });

  it('uses "Task" as the prefix for type::task tickets', () => {
    const errors = validateTaskBodyShape(task('t1', { ...VALID_STORY_BODY, goal: '' }));
    assert.ok(
      errors.some((e) => e.startsWith('Task "Task t1" (t1)')),
      errors.join('\n'),
    );
  });
});
