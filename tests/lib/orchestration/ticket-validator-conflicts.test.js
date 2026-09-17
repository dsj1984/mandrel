import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTickets } from '../../../.agents/scripts/lib/orchestration/plan-persist/persist-helpers.js';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';
import {
  _internal,
  computeAssembledConflictFindings,
  computeConflictFindings,
  conflictFindingKey,
  renderHardConflictError,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator-conflicts.js';
import { serialize as serializeStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';

/**
 * Cross-Story path-conflict & implicit-dependency findings (Story #2296).
 *
 * Acceptance scenarios drawn from the Story body:
 *
 *   (a) two Stories writing the same path in the same wave → shared-editor finding
 *   (b) two Stories writing the same path in serial waves   → no finding
 *   (c) consumer Story has transitive depends_on to producer → no finding
 *   (d) flag upgrade path rejects on finding                → severity 'hard' + errors[] populated
 *
 * Story #5332 retired the `implicit-cross-story-dep` and
 * `missing-bdd-scaffold` advisories — both substring-matched a producer path
 * inside a consumer's `acceptance[]` / `verify[]` prose — leaving
 * `shared-editor` as the one conflict kind.
 *
 * 2-tier (Epic #3238): each Story is its own implementation unit and
 * carries the `body` (goal / changes / acceptance / verify) that the
 * conflict pass scans, plus the top-level `acceptance[]` + `verify[]`
 * inline contract the validator requires. The conflict pass is exercised
 * through `validateAndNormalizeTickets` end-to-end so the integration
 * surface (findings + errors stitched onto the array) is also covered.
 */

function makeStory(slug, body = {}, extras = {}) {
  return {
    type: 'story',
    slug,
    title: `Story ${slug}`,
    acceptance: ['observable criterion'],
    verify: ['npm test (unit)'],
    body: {
      goal: `Goal for ${slug}.`,
      changes: [{ path: 'src/default.js', assumption: 'refactors-existing' }],
      acceptance: ['observable criterion'],
      verify: ['npm test (unit)'],
      ...body,
    },
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// (a) — shared-editor: same path, concurrent Stories
// ---------------------------------------------------------------------------

test('emits shared-editor finding when two Stories in the same wave write the same path', () => {
  const tickets = [
    makeStory('s-a', {
      changes: [
        {
          path: '.github/workflows/quality.yml',
          assumption: 'refactors-existing',
        },
      ],
    }),
    makeStory('s-b', {
      changes: [
        {
          path: '.github/workflows/quality.yml',
          assumption: 'refactors-existing',
        },
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].path, '.github/workflows/quality.yml');
  assert.deepEqual(shared[0].storySlugs, ['s-a', 's-b']);
  assert.equal(shared[0].severity, 'soft');
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// (b) — shared-editor suppressed when a depends_on chain serialises the Stories
// ---------------------------------------------------------------------------

test('does not emit shared-editor finding when depends_on serialises the writers', () => {
  const tickets = [
    makeStory('s-a', {
      changes: [
        {
          path: '.github/workflows/quality.yml',
          assumption: 'refactors-existing',
        },
      ],
    }),
    makeStory(
      's-b',
      {
        changes: [
          {
            path: '.github/workflows/quality.yml',
            assumption: 'refactors-existing',
          },
        ],
      },
      { depends_on: ['s-a'] },
    ),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.deepEqual(shared, []);
});

// ---------------------------------------------------------------------------
// No overlap, no finding
// ---------------------------------------------------------------------------

test('emits no conflict findings on a spec with non-overlapping paths', () => {
  const tickets = [
    makeStory('s-a', {
      changes: [{ path: 'src/a.js', assumption: 'refactors-existing' }],
    }),
    makeStory('s-b', {
      changes: [{ path: 'src/b.js', assumption: 'refactors-existing' }],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const conflict = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.deepEqual(conflict, []);
});

// ---------------------------------------------------------------------------
// Producer-set wave detection — three concurrent writers all surface
// ---------------------------------------------------------------------------

test('shared-editor cluster surfaces every concurrent writer of the path', () => {
  const tickets = [
    makeStory('s-a', {
      changes: [{ path: 'package.json', assumption: 'refactors-existing' }],
    }),
    makeStory('s-b', {
      changes: [{ path: 'package.json', assumption: 'refactors-existing' }],
    }),
    makeStory('s-c', {
      changes: [{ path: 'package.json', assumption: 'refactors-existing' }],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].storySlugs, ['s-a', 's-b', 's-c']);
});

// ---------------------------------------------------------------------------
// Pure-function unit coverage on the internal helpers
// ---------------------------------------------------------------------------

test('inSameWave: true only when neither story reaches the other', () => {
  const { inSameWave } = _internal;
  const reach = new Map([
    ['a', new Set()],
    ['b', new Set(['a'])],
    ['c', new Set()],
  ]);
  assert.equal(inSameWave(reach, 'a', 'c'), true);
  assert.equal(inSameWave(reach, 'a', 'b'), false);
  assert.equal(inSameWave(reach, 'b', 'a'), false);
  assert.equal(inSameWave(reach, 'a', 'a'), false);
});

test('computeConflictFindings: empty inputs return empty findings', () => {
  assert.deepEqual(computeConflictFindings({}), []);
  assert.deepEqual(computeConflictFindings({ stories: [] }), []);
});

// ---------------------------------------------------------------------------
// 2-tier guard: a Story missing its inline acceptance contract is rejected
// before the conflict pass runs (Epic #3238; narrowed to acceptance-only by
// Story #5342).
// ---------------------------------------------------------------------------

test('rejects a Story that lacks an inline acceptance contract', () => {
  const tickets = [
    {
      type: 'story',
      slug: 's-no-contract',
      title: 'Story without inline contract',
      body: {
        goal: 'Goal.',
        changes: [{ path: 'src/x.js', assumption: 'refactors-existing' }],
      },
    },
    // Valid sibling Story — the inline-contract gate is what fires.
    makeStory('s-conf-sibling', {
      changes: [
        { path: 'src/sibling-conf.js', assumption: 'refactors-existing' },
      ],
    }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /lack an inline acceptance contract/,
  );
});

test('renderHardConflictError: produces a remediation hint per finding kind', () => {
  const shared = renderHardConflictError({
    kind: 'shared-editor',
    severity: 'hard',
    path: '.github/workflows/quality.yml',
    storySlugs: ['s-a', 's-b'],
  });
  assert.match(shared, /Shared-editor conflict/);
  assert.match(shared, /depends_on/);

  // Story #5332: `shared-editor` is the only kind with a bespoke line. Any
  // other kind renders its own `message`, so the soft surface stays legible
  // without this module knowing every pass's shape.
  const other = renderHardConflictError({
    kind: 'some-other-pass',
    message: 'A finding from another pass.',
  });
  assert.equal(other, 'A finding from another pass.');

  const bare = renderHardConflictError({ kind: 'nameless', path: 'src/x.js' });
  assert.match(bare, /Conflict finding nameless on path "src\/x\.js"/);
});

test('emits shared-editor finding for object-form creates on the same path in the same wave', () => {
  const tickets = [
    makeStory('s-a', {
      changes: [
        { path: 'apps/api/src/routes/v1/teams/feed.ts', assumption: 'creates' },
      ],
    }),
    makeStory('s-b', {
      changes: [
        {
          path: 'apps/api/src/routes/v1/teams/feed.ts',
          assumption: 'refactors-existing',
        },
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].path, 'apps/api/src/routes/v1/teams/feed.ts');
  assert.deepEqual(shared[0].storySlugs, ['s-a', 's-b']);
  assert.equal(shared[0].severity, 'soft');
  assert.deepEqual(result.errors, []);
});

test('object-form `exists` entries do not produce shared-editor findings', () => {
  const tickets = [
    makeStory('s-a', {
      changes: [
        { path: 'apps/api/src/queries/feed.queries.ts', assumption: 'exists' },
      ],
    }),
    makeStory('s-b', {
      changes: [
        { path: 'apps/api/src/queries/feed.queries.ts', assumption: 'exists' },
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.deepEqual(shared, []);
});

test('object-form `deletes` counts as a producer for shared-editor findings', () => {
  const tickets = [
    makeStory('s-a', {
      changes: [{ path: 'apps/web/src/legacy/old.tsx', assumption: 'deletes' }],
    }),
    makeStory('s-b', {
      changes: [
        {
          path: 'apps/web/src/legacy/old.tsx',
          assumption: 'refactors-existing',
        },
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].path, 'apps/web/src/legacy/old.tsx');
});

test('object-form bodies on the same path surface as shared-editor producers', () => {
  const tickets = [
    makeStory('s-legacy', {
      changes: [
        { path: 'packages/config/index.ts', assumption: 'refactors-existing' },
      ],
    }),
    makeStory('s-object', {
      changes: [
        { path: 'packages/config/index.ts', assumption: 'refactors-existing' },
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].path, 'packages/config/index.ts');
  assert.deepEqual(shared[0].storySlugs, ['s-legacy', 's-object']);
});

test('does not emit shared-editor for object-form writers serialised by depends_on', () => {
  const tickets = [
    makeStory('s-a', {
      changes: [
        { path: 'apps/api/src/routes/v1/teams/feed.ts', assumption: 'creates' },
      ],
    }),
    makeStory(
      's-b',
      {
        changes: [
          {
            path: 'apps/api/src/routes/v1/teams/feed.ts',
            assumption: 'refactors-existing',
          },
        ],
      },
      { depends_on: ['s-a'] },
    ),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.deepEqual(shared, []);
});

test('collectStoryProducerPaths: object-form writes only, dropping reads', () => {
  const { collectStoryProducerPaths } = _internal;
  const story = {
    type: 'story',
    slug: 's-mix',
    body: {
      changes: [
        { path: 'src/created.ts', assumption: 'creates' },
        { path: 'src/refactored.ts', assumption: 'refactors-existing' },
        { path: 'src/removed.ts', assumption: 'deletes' },
        { path: 'src/read-only.ts', assumption: 'exists' },
      ],
      references: [{ path: 'src/dependency.ts', assumption: 'exists' }],
    },
  };
  const paths = collectStoryProducerPaths(story).sort();
  assert.deepEqual(paths, [
    'src/created.ts',
    'src/refactored.ts',
    'src/removed.ts',
  ]);
});

// ---------------------------------------------------------------------------
// Canonical serialized STRING body — production shape (Story #4271)
//
// The decomposer mandates `body` as a serialized markdown string, but the
// conflict passes (`indexAssumptionEntries`, the sibling-create scan in
// `computeRegistryFindings`, and the advisories Story #5332 retired)
// historically read `story.body` only when it was already an object — so on
// the production string shape they emitted nothing. `computeConflictFindings`
// now normalizes every body up front, so these fixtures exercise the
// canonical string shape at parity with the object-body cases above.
// ---------------------------------------------------------------------------

/**
 * Build a Story whose `body` is the canonical serialized **string** the
 * decomposer emits, with the authoritative top-level `acceptance[]` /
 * `verify[]` inline contract. The structured `changes` / `verify` fields
 * survive the serialize → parse round-trip the conflict passes run.
 */
function makeStringStory(slug, body = {}, extras = {}) {
  const structured = {
    goal: `Goal for ${slug}.`,
    changes: [{ path: 'src/default.js', assumption: 'refactors-existing' }],
    acceptance: ['observable criterion'],
    verify: ['npm test (unit)'],
    ...body,
  };
  return {
    type: 'story',
    slug,
    title: `Story ${slug}`,
    acceptance: structured.acceptance,
    verify: structured.verify,
    body: serializeStoryBody(structured),
    ...extras,
  };
}

test('string body: emits shared-editor when two string-body Stories write the same path in one wave', () => {
  const tickets = [
    makeStringStory('s-a', {
      changes: [
        {
          path: '.github/workflows/quality.yml',
          assumption: 'refactors-existing',
        },
      ],
    }),
    makeStringStory('s-b', {
      changes: [
        {
          path: '.github/workflows/quality.yml',
          assumption: 'refactors-existing',
        },
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].path, '.github/workflows/quality.yml');
  assert.deepEqual(shared[0].storySlugs, ['s-a', 's-b']);
});

test('string body: a depends_on chain still serialises string-body writers (no shared-editor)', () => {
  const tickets = [
    makeStringStory('s-a', {
      changes: [
        {
          path: '.github/workflows/quality.yml',
          assumption: 'refactors-existing',
        },
      ],
    }),
    makeStringStory(
      's-b',
      {
        changes: [
          {
            path: '.github/workflows/quality.yml',
            assumption: 'refactors-existing',
          },
        ],
      },
      { depends_on: ['s-a'] },
    ),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.deepEqual(shared, []);
});

// ---------------------------------------------------------------------------
// Post-assembly re-run (Story #5045)
//
// `validateTickets` runs over the raw `stories.json` payload, before assembly
// serializes the bodies persist actually posts. `computeAssembledConflictFindings`
// is the second pass over that artifact.
// ---------------------------------------------------------------------------

test('computeAssembledConflictFindings scans the serialized body strings', () => {
  const assembled = ['s-a', 's-b'].map((slug) => ({
    slug,
    title: `Story ${slug}`,
    body: serializeStoryBody({
      goal: `Goal for ${slug}.`,
      changes: [{ path: 'lib/shared.js', assumption: 'refactors-existing' }],
      acceptance: ['observable criterion'],
      verify: ['npm test (unit)'],
    }),
    depends_on: [],
  }));

  const findings = computeAssembledConflictFindings({ stories: assembled });
  const shared = findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].path, 'lib/shared.js');
  assert.deepEqual(shared[0].storySlugs, ['s-a', 's-b']);
  assert.equal(
    shared[0].severity,
    'soft',
    'advisory unless policy upgrades it',
  );
});

test('computeAssembledConflictFindings is total on absent and malformed input', () => {
  // It runs on the pre-creation path, so a shape surprise must not strand a
  // plan between validation and its first createIssue.
  assert.deepEqual(computeAssembledConflictFindings(), []);
  assert.deepEqual(computeAssembledConflictFindings({ stories: null }), []);
  assert.deepEqual(
    computeAssembledConflictFindings({
      stories: [{ slug: 's-a', body: 'not a parseable story body' }],
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// One conflict-policy resolver, two passes (Story #5045 follow-up)
//
// The raw pass (`validateTickets`) and the assembled pass
// (`computeAssembledConflictFindings`) each resolved `planning.*` through a
// private copy, and the copies drifted: `failOnMissingBddScaffold` reached
// only the assembled pass; `crossCuttingRegistries` (and the fan-out knobs)
// only the raw one. Both passes now share `resolveConflictPolicy`; these
// tests pin one previously-missing knob to each side so a re-split of the
// resolver fails here before it ships.
// ---------------------------------------------------------------------------

/**
 * A Story carrying the full inline contract `validateTickets` requires
 * (top-level `acceptance[]` / `verify[]` plus the serialized body), so the
 * same fixture drives the raw pass directly and the assembled pass via
 * `{ slug, title, body }`.
 */
function contractedStory(slug, { changes, verify }) {
  const acceptance = [`${slug} lands observably`];
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    acceptance,
    verify,
    body: serializeStoryBody({
      goal: `Goal for ${slug}.`,
      changes,
      acceptance,
      verify,
      reason_to_exist: `Ship ${slug}.`,
    }),
  };
}

function asAssembled(stories) {
  return stories.map(({ slug, title, body }) => ({
    slug,
    title,
    body,
    depends_on: [],
  }));
}

test('conflictFindingKey is stable across passes and separates distinct findings', () => {
  const finding = {
    kind: 'shared-editor',
    severity: 'soft',
    path: 'lib/shared.js',
    storySlugs: ['s-a', 's-b'],
  };
  assert.equal(
    conflictFindingKey(finding),
    conflictFindingKey({
      ...finding,
      severity: 'hard',
      storySlugs: ['s-b', 's-a'],
    }),
    'severity and slug order are not identity — the same collision keys alike',
  );
  assert.notEqual(
    conflictFindingKey(finding),
    conflictFindingKey({ ...finding, path: 'lib/other.js' }),
  );
  assert.notEqual(
    conflictFindingKey(finding),
    conflictFindingKey({ ...finding, kind: 'cross-cutting-registries' }),
  );
  assert.equal(typeof conflictFindingKey({}), 'string');
});
