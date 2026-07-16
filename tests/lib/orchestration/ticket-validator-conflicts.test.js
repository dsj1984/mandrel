import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';
import {
  _internal,
  computeConflictFindings,
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
 *   (c) consumer Story references producer's output path    → implicit-cross-story-dep finding
 *   (d) consumer Story has transitive depends_on to producer → no finding
 *   (e) flag upgrade path rejects on finding                → severity 'hard' + errors[] populated
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
// (c) — implicit-cross-story-dep: consumer references producer's output path
// ---------------------------------------------------------------------------

test("emits implicit-cross-story-dep when a Story verifies against another Story's declared path", () => {
  const tickets = [
    makeStory('s-producer', {
      changes: [
        {
          path: '.agents/schemas/baselines/coverage.schema.json',
          assumption: 'refactors-existing',
        },
      ],
    }),
    makeStory('s-consumer', {
      changes: [{ path: 'src/consumer.js', assumption: 'refactors-existing' }],
      verify: [
        'ajv validate -s .agents/schemas/baselines/coverage.schema.json',
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const implicit = result.findings.filter(
    (f) => f.kind === 'implicit-cross-story-dep',
  );
  assert.equal(implicit.length, 1);
  assert.equal(
    implicit[0].path,
    '.agents/schemas/baselines/coverage.schema.json',
  );
  assert.equal(implicit[0].producer.storySlug, 's-producer');
  assert.equal(implicit[0].consumer.storySlug, 's-consumer');
  assert.equal(implicit[0].consumer.sourceField, 'verify');
  assert.equal(implicit[0].severity, 'soft');
});

// ---------------------------------------------------------------------------
// (d) — implicit-cross-story-dep suppressed when transitive dep already covers it
// ---------------------------------------------------------------------------

test('does not emit implicit-cross-story-dep when consumer Story transitively depends on producer', () => {
  const tickets = [
    makeStory('s-producer', {
      changes: [
        {
          path: '.agents/schemas/baselines/coverage.schema.json',
          assumption: 'refactors-existing',
        },
      ],
    }),
    makeStory(
      's-intermediate',
      { changes: [{ path: 'src/mid.js', assumption: 'refactors-existing' }] },
      { depends_on: ['s-producer'] },
    ),
    makeStory(
      's-consumer',
      {
        changes: [
          { path: 'src/consumer.js', assumption: 'refactors-existing' },
        ],
        verify: [
          'ajv validate -s .agents/schemas/baselines/coverage.schema.json',
        ],
      },
      { depends_on: ['s-intermediate'] },
    ),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const implicit = result.findings.filter(
    (f) => f.kind === 'implicit-cross-story-dep',
  );
  assert.deepEqual(implicit, []);
});

// ---------------------------------------------------------------------------
// (e) — policy flag upgrades severity to 'hard' and populates errors[]
// ---------------------------------------------------------------------------

test('failOnSharedEditors=true upgrades shared-editor findings to hard severity', () => {
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
  const result = validateAndNormalizeTickets(tickets, {
    conflictPolicy: { failOnSharedEditors: true },
  });
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].severity, 'hard');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Shared-editor conflict/);
  assert.match(result.errors[0], /\.github\/workflows\/quality\.yml/);
});

test('requireExplicitCrossStoryDeps=true upgrades implicit-cross-story-dep to hard severity', () => {
  const tickets = [
    makeStory('s-producer', {
      changes: [
        {
          path: '.agents/schemas/baselines/coverage.schema.json',
          assumption: 'refactors-existing',
        },
      ],
    }),
    makeStory('s-consumer', {
      changes: [{ path: 'src/consumer.js', assumption: 'refactors-existing' }],
      verify: [
        'ajv validate -s .agents/schemas/baselines/coverage.schema.json',
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets, {
    conflictPolicy: { requireExplicitCrossStoryDeps: true },
  });
  const implicit = result.findings.filter(
    (f) => f.kind === 'implicit-cross-story-dep',
  );
  assert.equal(implicit.length, 1);
  assert.equal(implicit[0].severity, 'hard');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Implicit cross-Story dependency/);
  assert.match(result.errors[0], /s-producer/);
});

// ---------------------------------------------------------------------------
// Hygiene: clean spec produces no conflict findings
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
  const conflict = result.findings.filter(
    (f) => f.kind === 'shared-editor' || f.kind === 'implicit-cross-story-dep',
  );
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
// 2-tier guard: a Story missing its inline acceptance + verify contract is
// rejected before the conflict pass runs (Epic #3238).
// ---------------------------------------------------------------------------

test('rejects a Story that lacks an inline acceptance + verify contract', () => {
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
    /lack an inline acceptance \+ verify contract/,
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

  const implicit = renderHardConflictError({
    kind: 'implicit-cross-story-dep',
    severity: 'hard',
    path: '.agents/schemas/baselines/coverage.schema.json',
    producer: { storySlug: 's-producer', taskSlug: 't-producer' },
    consumer: {
      storySlug: 's-consumer',
      taskSlug: 't-consumer',
      sourceField: 'verify',
    },
  });
  assert.match(implicit, /Implicit cross-Story dependency/);
  assert.match(implicit, /s-producer/);
  assert.match(implicit, /s-consumer/);
});

// ---------------------------------------------------------------------------
// missing-bdd-scaffold (Story #3857)
// ---------------------------------------------------------------------------

test('emits missing-bdd-scaffold when a Story verifies a .feature created in a same-wave sibling', () => {
  const tickets = [
    makeStory('s-scaffold', {
      changes: [
        {
          path: 'tests/features/billing/invoice.feature',
          assumption: 'creates',
        },
      ],
    }),
    makeStory('s-impl', {
      changes: [{ path: 'src/billing.js', assumption: 'creates' }],
      verify: ['npx bddgen tests/features/billing/invoice.feature (e2e)'],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const bdd = result.findings.filter((f) => f.kind === 'missing-bdd-scaffold');
  assert.equal(bdd.length, 1);
  assert.equal(bdd[0].path, 'tests/features/billing/invoice.feature');
  assert.equal(bdd[0].producer.storySlug, 's-scaffold');
  assert.equal(bdd[0].consumer.storySlug, 's-impl');
  assert.equal(bdd[0].consumer.sourceField, 'verify');
  assert.equal(bdd[0].severity, 'soft');
  assert.deepEqual(result.errors, []);
});

test('does not emit missing-bdd-scaffold when the consumer depends_on the scaffold Story', () => {
  const tickets = [
    makeStory('s-scaffold', {
      changes: [
        {
          path: 'tests/features/billing/invoice.feature',
          assumption: 'creates',
        },
      ],
    }),
    makeStory(
      's-impl',
      {
        changes: [{ path: 'src/billing.js', assumption: 'creates' }],
        verify: ['npx bddgen tests/features/billing/invoice.feature (e2e)'],
      },
      { depends_on: ['s-scaffold'] },
    ),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const bdd = result.findings.filter((f) => f.kind === 'missing-bdd-scaffold');
  assert.deepEqual(bdd, []);
});

test('does not emit missing-bdd-scaffold when the same Story creates and verifies the .feature', () => {
  const tickets = [
    makeStory('s-self', {
      changes: [
        {
          path: 'tests/features/billing/invoice.feature',
          assumption: 'creates',
        },
      ],
      verify: ['npx bddgen tests/features/billing/invoice.feature (e2e)'],
    }),
    makeStory('s-other', {
      changes: [{ path: 'src/other.js', assumption: 'creates' }],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const bdd = result.findings.filter((f) => f.kind === 'missing-bdd-scaffold');
  assert.deepEqual(bdd, []);
});

test('does not emit missing-bdd-scaffold for non-.feature paths', () => {
  const tickets = [
    makeStory('s-producer', {
      changes: [{ path: 'src/schema.json', assumption: 'creates' }],
    }),
    makeStory('s-consumer', {
      changes: [{ path: 'src/consumer.js', assumption: 'creates' }],
      verify: ['ajv validate -s src/schema.json (contract)'],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const bdd = result.findings.filter((f) => f.kind === 'missing-bdd-scaffold');
  assert.deepEqual(bdd, []);
});

test('failOnMissingBddScaffold=true upgrades missing-bdd-scaffold to hard severity', () => {
  const tickets = [
    makeStory('s-scaffold', {
      changes: [
        {
          path: 'tests/features/billing/invoice.feature',
          assumption: 'creates',
        },
      ],
    }),
    makeStory('s-impl', {
      changes: [{ path: 'src/billing.js', assumption: 'creates' }],
      verify: ['npx bddgen tests/features/billing/invoice.feature (e2e)'],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets, {
    conflictPolicy: { failOnMissingBddScaffold: true },
  });
  const bdd = result.findings.filter((f) => f.kind === 'missing-bdd-scaffold');
  assert.equal(bdd.length, 1);
  assert.equal(bdd[0].severity, 'hard');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Missing BDD scaffold/);
  assert.match(result.errors[0], /tests\/features\/billing\/invoice\.feature/);
});

test('renderHardConflictError: produces a remediation hint for missing-bdd-scaffold', () => {
  const msg = renderHardConflictError({
    kind: 'missing-bdd-scaffold',
    severity: 'hard',
    path: 'tests/features/billing/invoice.feature',
    producer: { storySlug: 's-scaffold' },
    consumer: { storySlug: 's-impl', sourceField: 'verify' },
  });
  assert.match(msg, /Missing BDD scaffold/);
  assert.match(msg, /s-scaffold/);
  assert.match(msg, /s-impl/);
  assert.match(msg, /depends_on/);
});

// ---------------------------------------------------------------------------
// Object-form `changes` producer extraction (Story #3957)
//
// The decomposer emits object-form entries (`{ path, assumption }`). The
// conflict detector must extract producer paths from them — not only from the
// legacy `"<path>: <verb> ..."` string bullets — or the shared-editor and
// implicit-cross-story-dep findings can never fire under the modern contract.
// ---------------------------------------------------------------------------

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

test('emits implicit-cross-story-dep when a consumer verifies a path created object-form by another Story', () => {
  const tickets = [
    makeStory('s-producer', {
      changes: [
        { path: 'apps/api/src/queries/feed.queries.ts', assumption: 'creates' },
      ],
    }),
    makeStory('s-consumer', {
      changes: [
        {
          path: 'apps/web/src/components/feed/PostCard.tsx',
          assumption: 'creates',
        },
      ],
      verify: ['npm test -- apps/api/src/queries/feed.queries.ts (contract)'],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const implicit = result.findings.filter(
    (f) => f.kind === 'implicit-cross-story-dep',
  );
  assert.equal(implicit.length, 1);
  assert.equal(implicit[0].path, 'apps/api/src/queries/feed.queries.ts');
  assert.equal(implicit[0].producer.storySlug, 's-producer');
  assert.equal(implicit[0].consumer.storySlug, 's-consumer');
  assert.equal(implicit[0].consumer.sourceField, 'verify');
  assert.equal(implicit[0].severity, 'soft');
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
// conflict passes (`indexConsumers`, `indexAssumptionEntries`,
// `computeMissingBddScaffoldFindings`, the sibling-create scan in
// `computeRegistryFindings`) historically read `story.body` only when it was
// already an object — so on the production string shape the
// `implicit-cross-story-dep`, `fan-out`, and `missing-bdd-scaffold` findings
// emitted nothing. `computeConflictFindings` now normalizes every body up
// front, so these fixtures exercise the canonical string shape at parity with
// the object-body cases above.
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

test("string body: emits implicit-cross-story-dep when a string-body consumer verifies another Story's declared path", () => {
  const tickets = [
    makeStringStory('s-producer', {
      changes: [
        {
          path: '.agents/schemas/baselines/coverage.schema.json',
          assumption: 'creates',
        },
      ],
    }),
    makeStringStory('s-consumer', {
      changes: [{ path: 'src/consumer.js', assumption: 'creates' }],
      verify: [
        'ajv validate -s .agents/schemas/baselines/coverage.schema.json (contract)',
      ],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const implicit = result.findings.filter(
    (f) => f.kind === 'implicit-cross-story-dep',
  );
  assert.equal(implicit.length, 1);
  assert.equal(
    implicit[0].path,
    '.agents/schemas/baselines/coverage.schema.json',
  );
  assert.equal(implicit[0].producer.storySlug, 's-producer');
  assert.equal(implicit[0].consumer.storySlug, 's-consumer');
  assert.equal(implicit[0].consumer.sourceField, 'verify');
});

test('string body: emits missing-bdd-scaffold when a string-body Story verifies a same-wave .feature creator', () => {
  const tickets = [
    makeStringStory('s-scaffold', {
      changes: [
        {
          path: 'tests/features/billing/invoice.feature',
          assumption: 'creates',
        },
      ],
    }),
    makeStringStory('s-impl', {
      changes: [{ path: 'src/billing.js', assumption: 'creates' }],
      verify: ['npx bddgen tests/features/billing/invoice.feature (e2e)'],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const bdd = result.findings.filter((f) => f.kind === 'missing-bdd-scaffold');
  assert.equal(bdd.length, 1);
  assert.equal(bdd[0].path, 'tests/features/billing/invoice.feature');
  assert.equal(bdd[0].producer.storySlug, 's-scaffold');
  assert.equal(bdd[0].consumer.storySlug, 's-impl');
});

test('string body: fan-out finding fires on a string-body deletes entry', () => {
  const del = makeStringStory('s-del', {
    changes: [{ path: 'src/legacy/old.js', assumption: 'deletes' }],
  });
  const findings = computeConflictFindings({
    stories: [del],
    policy: { largeFanOutThreshold: 2, fanOutCounter: () => 5 },
  });
  const fanOut = findings.filter((f) => f.kind === 'fan-out-warning');
  assert.equal(fanOut.length, 1);
  assert.equal(fanOut[0].path, 'src/legacy/old.js');
  assert.equal(fanOut[0].callSiteCount, 5);
  assert.equal(fanOut[0].storySlug, 's-del');
});

// ---------------------------------------------------------------------------
// Fan-out findings carry their evidence and a fitting remedy (Story #4547)
// ---------------------------------------------------------------------------

function fanOutFindingsFor(stories, policy) {
  return computeConflictFindings({ stories, policy }).filter(
    (f) => f.kind === 'fan-out-warning',
  );
}

test('fan-out finding carries the referencing files and the probe behind its number', () => {
  const del = makeStory('s-del', {
    changes: [{ path: 'src/legacy/old.js', assumption: 'deletes' }],
  });
  const [finding] = fanOutFindingsFor([del], {
    largeFanOutThreshold: 2,
    fanOutCounter: () => ({
      count: 3,
      files: ['src/a.js', 'src/b.js', 'src/c.js'],
      probe: 'git grep -n -E <pattern> main',
    }),
  });
  assert.equal(finding.callSiteCount, 3);
  assert.deepEqual(finding.callSites, ['src/a.js', 'src/b.js', 'src/c.js']);
  assert.equal(finding.probe, 'git grep -n -E <pattern> main');

  // The operator must be able to check the figure, not merely trust it.
  const message = renderHardConflictError(finding);
  assert.match(message, /3 importer\(s\)/);
  assert.match(message, /src\/a\.js/);
  assert.match(message, /src\/c\.js/);
  assert.match(message, /Probe: git grep -n -E <pattern> main/);
});

test('a bare-number counter still produces a finding, without an audit trail', () => {
  // The Story #2962 counter contract stays valid — injected and consumer
  // counters that return a plain number keep working.
  const del = makeStory('s-del', {
    changes: [{ path: 'src/legacy/old.js', assumption: 'deletes' }],
  });
  const [finding] = fanOutFindingsFor([del], {
    largeFanOutThreshold: 2,
    fanOutCounter: () => 7,
  });
  assert.equal(finding.callSiteCount, 7);
  assert.deepEqual(finding.callSites, []);
  assert.equal(finding.probe, null);
  assert.equal(finding.renameShaped, false);
  assert.doesNotMatch(renderHardConflictError(finding), /Importers:|Probe:/);
});

test('a genuinely wide-coupling deletion still trips the gate and advises a split', () => {
  const del = makeStory('s-del', {
    changes: [{ path: 'src/legacy/old.js', assumption: 'deletes' }],
  });
  const [finding] = fanOutFindingsFor([del], {
    largeFanOutThreshold: 10,
    fanOutCounter: () => ({
      count: 30,
      files: ['src/a.js'],
      probe: 'git grep -n -E <pattern> main',
    }),
  });
  assert.equal(finding.callSiteCount, 30);
  assert.equal(finding.renameShaped, false);
  assert.match(
    renderHardConflictError(finding),
    /subsystem-by-subsystem migration across multiple Stories/,
  );
});

test('a rename-shaped deletion is named as a move, not as a migration to split', () => {
  // A move has no subsystems to split across, so the split advice leaves
  // --allow-large-fan-out as the only exit — the habit that defeats the gate.
  const move = makeStory('s-move', {
    changes: [
      { path: 'src/legacy/notification.js', assumption: 'deletes' },
      { path: 'src/core/notification.js', assumption: 'creates' },
    ],
  });
  const [finding] = fanOutFindingsFor([move], {
    largeFanOutThreshold: 2,
    fanOutCounter: () => ({
      count: 12,
      files: ['src/a.js'],
      probe: 'git grep',
    }),
  });
  assert.equal(finding.renameShaped, true);
  assert.equal(finding.renameTarget, 'src/core/notification.js');

  const message = renderHardConflictError(finding);
  assert.match(message, /rename-shaped/);
  assert.match(message, /src\/core\/notification\.js/);
  assert.match(message, /Repoint the importer\(s\) at the new path/);
  assert.doesNotMatch(message, /subsystem-by-subsystem/);
});

test('a deletion whose basename is created nowhere is not mistaken for a rename', () => {
  const stories = [
    makeStory('s-del', {
      changes: [{ path: 'src/legacy/notification.js', assumption: 'deletes' }],
    }),
    makeStory('s-other', {
      changes: [{ path: 'src/core/mailer.js', assumption: 'creates' }],
    }),
  ];
  const [finding] = fanOutFindingsFor(stories, {
    largeFanOutThreshold: 2,
    fanOutCounter: () => 12,
  });
  assert.equal(finding.renameShaped, false);
  assert.equal(finding.renameTarget, null);
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
