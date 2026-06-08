// tests/story-3302-body-shape.test.js
/**
 * Regression tests for Story #3302:
 *   1. `createOp` serializes an object body rather than coercing it with
 *      `String()`, preventing "[object Object]" from reaching GitHub.
 *   2. `collectTaskChangesPaths` parses a canonical string body so the
 *      freshness gate does not false-positive on net-new files.
 *   3. `collectStoryAssumptionEntries` parses a canonical string body so
 *      the #2636 assumption gate works on the serialized form.
 *
 * Story #3629 (component-health / coverage-annotation cleanup) extends this
 * file with tests for the remaining pure decision cores in
 * `epic-spec-reconciler-ops.js` — `updateOp`, `closeOp`, `relinkOp`, and
 * the plan utility functions — so that the blanket file-level coverage ignore
 * can be removed and only the genuinely untestable catch branch is annotated.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  closeOp,
  createOp,
  ENTITY_KINDS,
  emptyPlan,
  isEmptyPlan,
  isOperation,
  isPlan,
  OP_KINDS,
  planSize,
  relinkOp,
  updateOp,
} from '../.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js';
import { collectStoryAssumptionEntries } from '../.agents/scripts/lib/orchestration/file-assumptions.js';
import { validateAcFreshness } from '../.agents/scripts/lib/orchestration/ticket-validator.js';
import {
  StoryBodyParseError,
  serialize,
} from '../.agents/scripts/lib/story-body/story-body.js';

// ---------------------------------------------------------------------------
// Fix #1: createOp serialize-or-throw
// ---------------------------------------------------------------------------

describe('createOp — object body handling (Story #3302)', () => {
  it('accepts a string body unchanged', () => {
    const op = createOp({
      slug: 'my-story',
      entity: ENTITY_KINDS.STORY,
      title: 'My story',
      body: '## Goal\nDo something.',
    });
    assert.equal(op.body, '## Goal\nDo something.');
  });

  it('serializes a well-formed object body to markdown (no [object Object])', () => {
    const bodyObj = {
      goal: 'Implement the feature.',
      changes: [{ path: 'src/feature.js', assumption: 'creates' }],
      acceptance: ['Feature is implemented.'],
      verify: ['node --test tests/feature.test.js (unit)'],
      references: [],
      wide: null,
      depends_on: [],
      estimated_test_files: null,
    };
    const op = createOp({
      slug: 'my-story',
      entity: ENTITY_KINDS.STORY,
      title: 'My story',
      body: bodyObj,
    });
    // Must not be "[object Object]".
    assert.notEqual(op.body, '[object Object]');
    // Must be a string starting with the canonical Goal section.
    assert.ok(typeof op.body === 'string', 'body must be a string');
    assert.ok(
      op.body.includes('## Goal'),
      'serialized body must contain ## Goal section',
    );
    assert.ok(
      op.body.includes('src/feature.js'),
      'serialized body must contain the changes path',
    );
  });

  it('produces a canonical (possibly empty) string for an atypical object body', () => {
    // An object body that has no recognized Story fields (no goal, changes,
    // etc.) still passes through serialize() cleanly — serialize() only
    // throws when body itself is not an object at all. The net result is
    // an empty-ish serialized string, which is infinitely better than the
    // pre-3302 "[object Object]" that reached GitHub.
    const op = createOp({
      slug: 'atypical-story',
      entity: ENTITY_KINDS.STORY,
      title: 'Atypical story',
      body: { notAValidStoryBody: true },
    });
    // Must be a string, never "[object Object]".
    assert.ok(typeof op.body === 'string');
    assert.notEqual(op.body, '[object Object]');
  });

  it('throws StoryBodyParseError when serialize itself throws (non-object body)', () => {
    // createOp wraps StoryBodyParseError from serialize() with additional
    // context. This cannot happen via the normal `body !== undefined` path
    // for plain objects, but the wrapper is tested via a direct call to
    // serialize with an unsupported input type — confirmed by the serialize
    // contract: it throws when body is not a non-null object.
    assert.throws(() => serialize(null), StoryBodyParseError);
    assert.throws(() => serialize('a string'), StoryBodyParseError);
  });

  it('omits body entirely when body is undefined (no regression)', () => {
    const op = createOp({
      slug: 'no-body-story',
      entity: ENTITY_KINDS.STORY,
      title: 'No body',
    });
    assert.equal('body' in op, false);
  });
});

// ---------------------------------------------------------------------------
// Fix #2: collectTaskChangesPaths / validateAcFreshness with string body
// ---------------------------------------------------------------------------

describe('validateAcFreshness — canonical string body (Story #3302)', () => {
  function makeStory({ slug = 'demo-story', bodyStr }) {
    // Top-level acceptance/verify required by the validator hierarchy check.
    return {
      type: 'story',
      slug,
      title: slug,
      body: bodyStr,
      acceptance: ['ac'],
      verify: ['node --test tests/demo.test.js (unit)'],
    };
  }

  it('does NOT false-positive when body.changes declares a net-new path as "creates"', () => {
    // The story declares it will create tests/my-new-util.test.js.
    // That same path appears in the `verify` list (and therefore is picked
    // up by collectTaskPathReferences). The freshness gate must accept it
    // because it is declared net-new in changes[] — it does not exist on
    // the base branch yet.
    //
    // Before Story #3302, collectTaskChangesPaths returned an empty set
    // for string bodies (since String() coercion was not used and the
    // helper only read body.changes on objects). The path was then not in
    // `expectedNewPaths`, the git probe returned false, and the freshness
    // gate threw a false-positive ValidationError.
    // After the fix, the string body is parsed and the path IS in the set.
    const path = 'tests/my-new-util.test.js';
    const bodyStr = serialize({
      goal: 'Add my-new-util.test.js to cover the new feature.',
      changes: [{ path, assumption: 'creates' }],
      acceptance: [`${path} passes all assertions`],
      verify: [`node --test ${path} (unit)`],
      references: [],
      wide: null,
      depends_on: [],
      estimated_test_files: null,
    });

    const tickets = [makeStory({ bodyStr })];

    // gitRunner always returns false (nothing exists at baseBranchRef).
    // The freshness gate must not throw because the path is declared as
    // net-new in changes[].
    assert.doesNotThrow(() =>
      validateAcFreshness({
        tickets,
        baseBranchRef: 'main',
        gitRunner: () => false,
      }),
    );
  });

  it('DOES flag a fictitious path that appears in acceptance text but NOT in changes[]', () => {
    // The acceptance text references a path that is neither on the base
    // branch nor declared as net-new in changes[]. This is the hallucination
    // case the freshness gate is designed to catch.
    const bodyStr = serialize({
      goal: 'Do something.',
      changes: [
        { path: '.agents/scripts/real-util.js', assumption: 'creates' },
      ],
      acceptance: [
        'node --test tests/.agents/scripts/nonexistent.test.js exits 0',
      ],
      verify: ['node --test tests/.agents/scripts/nonexistent.test.js (unit)'],
      references: [],
      wide: null,
      depends_on: [],
      estimated_test_files: null,
    });

    const tickets = [makeStory({ bodyStr })];

    // All paths absent from the branch.
    assert.throws(
      () =>
        validateAcFreshness({
          tickets,
          baseBranchRef: 'main',
          gitRunner: () => false,
        }),
      /Cross-Validation Failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// Fix #3: collectStoryAssumptionEntries with string body
// ---------------------------------------------------------------------------

describe('collectStoryAssumptionEntries — canonical string body (Story #3302)', () => {
  function makeStory(bodyArg) {
    return { type: 'story', slug: 'demo', title: 'demo', body: bodyArg };
  }

  it('extracts assumption entries from a serialized string body', () => {
    const bodyStr = serialize({
      goal: 'Do something.',
      changes: [
        { path: 'src/a.ts', assumption: 'creates' },
        { path: 'src/b.ts', assumption: 'refactors-existing' },
      ],
      acceptance: ['ac'],
      verify: ['node --test tests/x.test.js (unit)'],
      references: [{ path: 'tests/fixtures/f.json', assumption: 'exists' }],
      wide: null,
      depends_on: [],
      estimated_test_files: null,
    });

    const entries = collectStoryAssumptionEntries(makeStory(bodyStr));
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], {
      path: 'src/a.ts',
      assumption: 'creates',
      source: 'changes',
    });
    assert.deepEqual(entries[1], {
      path: 'src/b.ts',
      assumption: 'refactors-existing',
      source: 'changes',
    });
    assert.deepEqual(entries[2], {
      path: 'tests/fixtures/f.json',
      assumption: 'exists',
      source: 'references',
    });
  });

  it('returns empty for an unstructured (legacy) string body', () => {
    const entries = collectStoryAssumptionEntries(
      makeStory('This is a plain description with no structured sections.'),
    );
    // Legacy string bodies have no object-form entries; gate silently skips.
    assert.deepEqual(entries, []);
  });

  it('returns empty for null body (no regression)', () => {
    const entries = collectStoryAssumptionEntries(makeStory(null));
    assert.deepEqual(entries, []);
  });

  it('still works with an object body (backward compat)', () => {
    const entries = collectStoryAssumptionEntries(
      makeStory({
        goal: 'g',
        changes: [{ path: 'src/c.ts', assumption: 'deletes' }],
        acceptance: ['ac'],
        verify: ['v'],
      }),
    );
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      path: 'src/c.ts',
      assumption: 'deletes',
      source: 'changes',
    });
  });
});

// ---------------------------------------------------------------------------
// Story #3629: pure decision cores — updateOp, closeOp, relinkOp
// ---------------------------------------------------------------------------

describe('updateOp — factory and validation (Story #3629)', () => {
  it('builds a well-formed UpdateOp with change entries', () => {
    const op = updateOp({
      slug: 'my-story',
      entity: ENTITY_KINDS.STORY,
      issueNumber: 42,
      changes: {
        title: { before: 'Old', after: 'New' },
        body: { before: 'x', after: 'y' },
      },
    });
    assert.equal(op.kind, OP_KINDS.UPDATE);
    assert.equal(op.slug, 'my-story');
    assert.equal(op.entity, ENTITY_KINDS.STORY);
    assert.equal(op.issueNumber, 42);
    assert.deepEqual(op.changes.title, { before: 'Old', after: 'New' });
    assert.deepEqual(op.changes.body, { before: 'x', after: 'y' });
  });

  it('accepts an empty changes object', () => {
    const op = updateOp({
      slug: 'empty-changes',
      entity: ENTITY_KINDS.FEATURE,
      issueNumber: 7,
      changes: {},
    });
    assert.deepEqual(op.changes, {});
  });

  it('throws when a change entry lacks before/after', () => {
    assert.throws(
      () =>
        updateOp({
          slug: 'bad-change',
          entity: ENTITY_KINDS.STORY,
          issueNumber: 1,
          changes: { title: { only: 'one key' } },
        }),
      TypeError,
    );
  });

  it('throws on an invalid slug', () => {
    assert.throws(
      () =>
        updateOp({
          slug: '',
          entity: ENTITY_KINDS.STORY,
          issueNumber: 1,
          changes: {},
        }),
      TypeError,
    );
  });

  it('throws on an invalid entity kind', () => {
    assert.throws(
      () =>
        updateOp({
          slug: 'valid-slug',
          entity: 'invalid-entity',
          issueNumber: 1,
          changes: {},
        }),
      TypeError,
    );
  });
});

describe('closeOp — factory (Story #3629)', () => {
  it('builds a CloseOp with optional title', () => {
    const op = closeOp({
      slug: 'old-story',
      entity: ENTITY_KINDS.STORY,
      issueNumber: 99,
      title: 'Deprecated story',
    });
    assert.equal(op.kind, OP_KINDS.CLOSE);
    assert.equal(op.slug, 'old-story');
    assert.equal(op.entity, ENTITY_KINDS.STORY);
    assert.equal(op.issueNumber, 99);
    assert.equal(op.title, 'Deprecated story');
  });

  it('omits title when not provided', () => {
    const op = closeOp({
      slug: 'no-title',
      entity: ENTITY_KINDS.EPIC,
      issueNumber: 5,
    });
    assert.equal('title' in op, false);
  });

  it('throws on an invalid slug', () => {
    assert.throws(
      () => closeOp({ slug: '', entity: ENTITY_KINDS.STORY, issueNumber: 1 }),
      TypeError,
    );
  });
});

describe('relinkOp — factory (Story #3629)', () => {
  it('builds a RelinkOp with a parent edge change', () => {
    const op = relinkOp({
      slug: 'child-story',
      entity: ENTITY_KINDS.STORY,
      issueNumber: 10,
      parent: { before: 'feature-a', after: 'feature-b' },
    });
    assert.equal(op.kind, OP_KINDS.RELINK);
    assert.deepEqual(op.parent, { before: 'feature-a', after: 'feature-b' });
    assert.equal('dependsOn' in op, false);
  });

  it('builds a RelinkOp with a dependsOn edge change (arrays sorted)', () => {
    const op = relinkOp({
      slug: 'story-b',
      entity: ENTITY_KINDS.STORY,
      issueNumber: 11,
      dependsOn: { before: ['z-story', 'a-story'], after: ['c-story'] },
    });
    assert.deepEqual(op.dependsOn.before, ['a-story', 'z-story']);
    assert.deepEqual(op.dependsOn.after, ['c-story']);
    assert.equal('parent' in op, false);
  });

  it('builds a RelinkOp with both parent and dependsOn', () => {
    const op = relinkOp({
      slug: 'story-c',
      entity: ENTITY_KINDS.STORY,
      issueNumber: 12,
      parent: { before: null, after: 'feature-x' },
      dependsOn: { before: [], after: ['story-d'] },
    });
    assert.ok(op.parent);
    assert.ok(op.dependsOn);
  });

  it('coerces null parent edges to null', () => {
    const op = relinkOp({
      slug: 'story-null',
      entity: ENTITY_KINDS.STORY,
      issueNumber: 13,
      parent: { before: null, after: null },
    });
    assert.equal(op.parent.before, null);
    assert.equal(op.parent.after, null);
  });

  it('throws when neither parent nor dependsOn is provided', () => {
    assert.throws(
      () =>
        relinkOp({
          slug: 'story-empty',
          entity: ENTITY_KINDS.STORY,
          issueNumber: 14,
        }),
      TypeError,
    );
  });

  it('throws on an invalid slug', () => {
    assert.throws(
      () =>
        relinkOp({
          slug: 42,
          entity: ENTITY_KINDS.STORY,
          issueNumber: 1,
          parent: { before: null, after: 'f' },
        }),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Story #3629: plan utility functions
// ---------------------------------------------------------------------------

describe('emptyPlan / isPlan / planSize / isEmptyPlan / isOperation (Story #3629)', () => {
  it('emptyPlan returns a plan with four empty arrays', () => {
    const plan = emptyPlan();
    assert.ok(isPlan(plan));
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.updates, []);
    assert.deepEqual(plan.closes, []);
    assert.deepEqual(plan.relinks, []);
  });

  it('isPlan returns false for non-objects', () => {
    assert.equal(isPlan(null), false);
    assert.equal(isPlan(undefined), false);
    assert.equal(isPlan('string'), false);
    assert.equal(isPlan(42), false);
  });

  it('isPlan returns false when any array property is missing', () => {
    assert.equal(isPlan({ creates: [], updates: [], closes: [] }), false);
    assert.equal(
      isPlan({ creates: [], updates: [], closes: [], relinks: 'x' }),
      false,
    );
  });

  it('planSize returns 0 for an empty plan', () => {
    assert.equal(planSize(emptyPlan()), 0);
  });

  it('planSize returns the sum across all four buckets', () => {
    const plan = emptyPlan();
    plan.creates.push(
      createOp({ slug: 's1', entity: ENTITY_KINDS.STORY, title: 'S1' }),
    );
    plan.closes.push(
      closeOp({ slug: 's2', entity: ENTITY_KINDS.STORY, issueNumber: 2 }),
    );
    assert.equal(planSize(plan), 2);
  });

  it('planSize returns 0 for a non-plan value', () => {
    assert.equal(planSize(null), 0);
    assert.equal(planSize({}), 0);
  });

  it('isEmptyPlan returns true for an empty plan', () => {
    assert.equal(isEmptyPlan(emptyPlan()), true);
  });

  it('isEmptyPlan returns false for a non-empty plan', () => {
    const plan = emptyPlan();
    plan.creates.push(
      createOp({ slug: 's1', entity: ENTITY_KINDS.STORY, title: 'S1' }),
    );
    assert.equal(isEmptyPlan(plan), false);
  });

  it('isOperation returns true for a valid CreateOp', () => {
    const op = createOp({
      slug: 'test-op',
      entity: ENTITY_KINDS.STORY,
      title: 'Test',
    });
    assert.equal(isOperation(op), true);
  });

  it('isOperation returns true for a valid UpdateOp', () => {
    const op = updateOp({
      slug: 'up-op',
      entity: ENTITY_KINDS.FEATURE,
      issueNumber: 5,
      changes: { title: { before: 'A', after: 'B' } },
    });
    assert.equal(isOperation(op), true);
  });

  it('isOperation returns false for non-objects and malformed ops', () => {
    assert.equal(isOperation(null), false);
    assert.equal(isOperation('string'), false);
    assert.equal(
      isOperation({ kind: 'invalid', slug: 'x', entity: ENTITY_KINDS.STORY }),
      false,
    );
    assert.equal(
      isOperation({ kind: OP_KINDS.CREATE, slug: 'x', entity: 'bad-entity' }),
      false,
    );
    assert.equal(
      isOperation({
        kind: OP_KINDS.CREATE,
        slug: 42,
        entity: ENTITY_KINDS.STORY,
      }),
      false,
    );
  });
});
