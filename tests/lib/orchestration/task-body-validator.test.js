/**
 * tests/lib/orchestration/task-body-validator.test.js
 *
 * Plan-time validation coverage for the Story-body shape (2-tier world).
 * Story #5312 deleted the verify[] tier-suffix contract (and the
 * `manual:<reason>` escape with it): a verify entry is any command.
 *   - Story tickets with structured bodies are validated; Feature tickets
 *     and string-bodied Story tickets still pass through.
 *   - assumption enum values in changes[] / references[] are validated for
 *     story bodies.
 *
 * The root-level tests/task-body-validator.test.js covers the core
 * validation surface using Story fixtures; this file extends coverage for
 * the Story-body and tier-suffix paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeStoryTicket } from '../../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import {
  collectTaskBodyErrors,
  validateTaskBodyShape,
} from '../../../.agents/scripts/lib/orchestration/task-body-validator.js';
import { serialize } from '../../../.agents/scripts/lib/story-body/story-body.js';

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

// ---------------------------------------------------------------------------
// Story body: shouldSkipTicket routing
// ---------------------------------------------------------------------------

describe('collectTaskBodyErrors — Story ticket routing (2-tier)', () => {
  it('validates a Story with a structured body', () => {
    const errs = collectTaskBodyErrors([story('s1', VALID_STORY_BODY)]);
    assert.deepEqual(errs, []);
  });

  it('validates a serialized string body — parses then applies section rules (Story #3906)', () => {
    const serialized = serialize(VALID_STORY_BODY);
    const errs = collectTaskBodyErrors([story('s1', serialized)]);
    assert.deepEqual(errs, []);
  });

  it('rejects a legacy unstructured string body (no sections → empty arrays)', () => {
    const errs = collectTaskBodyErrors([story('s1', 'a plain string body')]);
    assert.ok(
      errs.some((e) => e.includes('body.changes')),
      `expected a missing-changes error, got: ${JSON.stringify(errs)}`,
    );
  });

  it('skips a Story with an empty / whitespace-only string body', () => {
    assert.deepEqual(collectTaskBodyErrors([story('s1', '   ')]), []);
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

  it('skips non-Story typed tickets with structured bodies', () => {
    const tickets = [
      { slug: 'e1', type: 'epic', title: 'E', body: { weird: true } },
    ];
    assert.deepEqual(collectTaskBodyErrors(tickets), []);
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
    assert.match(errs[0], /acceptance must list at least one criterion/);
  });

  it('rejects empty verify[]', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: [] }),
    ]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /verify must list at least one entry/);
  });

  it('prefixes errors with "Story" for story tickets', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, goal: '' }),
    ]);
    assert.ok(
      errs.some((e) => /^Story "/.test(e)),
      errs.join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// verify[] tier-suffix validation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// verify[] tier auto-append (Story #5005)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// assumption enum validation for Story changes[]
// ---------------------------------------------------------------------------

describe('collectTaskBodyErrors — verify[] entries are commands (Story #5312)', () => {
  it('accepts a tier-less command, a tagged one, and a former manual: escape alike', () => {
    for (const entry of [
      'npm test',
      'npm run test (unit)',
      'manual: an auditor eyeballs the copy',
      'grep -n "x" lib/y.js',
    ]) {
      const errs = collectTaskBodyErrors([
        story('s1', { ...VALID_STORY_BODY, verify: [entry] }),
      ]);
      assert.deepEqual(errs, [], entry);
    }
  });

  it('tolerates non-string verify entries', () => {
    const errs = collectTaskBodyErrors([
      story('s1', { ...VALID_STORY_BODY, verify: [42, 'npm test'] }),
    ]);
    assert.deepEqual(errs, []);
  });
});

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
    const errors = validateTaskBodyShape(
      story('s1', { ...VALID_STORY_BODY, goal: '' }),
    );
    assert.ok(
      errors.some((e) => e.startsWith('Story "Story s1" (s1)')),
      errors.join('\n'),
    );
  });
});
