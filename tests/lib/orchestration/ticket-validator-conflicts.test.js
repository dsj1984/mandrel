import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';
import {
  _internal,
  computeConflictFindings,
  renderHardConflictError,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator-conflicts.js';

/**
 * Cross-Story path-conflict & implicit-dependency findings (Story #2296).
 *
 * Acceptance scenarios drawn from the Story body:
 *
 *   (a) two Stories writing the same path in the same wave → shared-editor finding
 *   (b) two Stories writing the same path in serial waves   → no finding
 *   (c) consumer Task references producer's output path     → implicit-cross-story-dep finding
 *   (d) consumer Story has transitive depends_on to producer → no finding
 *   (e) flag upgrade path rejects on finding                → severity 'hard' + errors[] populated
 *
 * Fixtures use the minimal hierarchy the validator accepts: one Feature,
 * two Stories with one Task each (plus extras as needed). The conflict
 * pass is exercised through `validateAndNormalizeTickets` end-to-end so
 * the integration surface (findings + errors stitched onto the array)
 * is also covered.
 */

const FEATURE = Object.freeze({
  type: 'feature',
  slug: 'f-conf',
  title: 'Conflict fixtures',
});

function makeStory(slug, extras = {}) {
  return {
    type: 'story',
    slug,
    parent_slug: 'f-conf',
    title: `Story ${slug}`,
    ...extras,
  };
}

function makeTask(slug, parentSlug, body, extras = {}) {
  return {
    type: 'task',
    slug,
    parent_slug: parentSlug,
    title: `Task ${slug}`,
    body: {
      goal: `Goal for ${slug}.`,
      changes: ['src/default.js: edit'],
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
    FEATURE,
    makeStory('s-a'),
    makeStory('s-b'),
    makeTask('t-a', 's-a', {
      changes: ['.github/workflows/quality.yml: tighten lint job'],
    }),
    makeTask('t-b', 's-b', {
      changes: ['.github/workflows/quality.yml: add coverage gate'],
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
    FEATURE,
    makeStory('s-a'),
    makeStory('s-b', { depends_on: ['s-a'] }),
    makeTask('t-a', 's-a', {
      changes: ['.github/workflows/quality.yml: tighten lint job'],
    }),
    makeTask('t-b', 's-b', {
      changes: ['.github/workflows/quality.yml: add coverage gate'],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.deepEqual(shared, []);
});

// ---------------------------------------------------------------------------
// (c) — implicit-cross-story-dep: consumer references producer's output path
// ---------------------------------------------------------------------------

test("emits implicit-cross-story-dep when a Task verifies against another Story's declared path", () => {
  const tickets = [
    FEATURE,
    makeStory('s-producer'),
    makeStory('s-consumer'),
    makeTask('t-producer', 's-producer', {
      changes: [
        '.agents/schemas/baselines/coverage.schema.json: introduce schema',
      ],
    }),
    makeTask('t-consumer', 's-consumer', {
      changes: ['src/consumer.js: read schema'],
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
    FEATURE,
    makeStory('s-producer'),
    makeStory('s-intermediate', { depends_on: ['s-producer'] }),
    makeStory('s-consumer', { depends_on: ['s-intermediate'] }),
    makeTask('t-producer', 's-producer', {
      changes: [
        '.agents/schemas/baselines/coverage.schema.json: introduce schema',
      ],
    }),
    makeTask('t-mid', 's-intermediate', {
      changes: ['src/mid.js: pass-through'],
    }),
    makeTask('t-consumer', 's-consumer', {
      changes: ['src/consumer.js: read schema'],
      verify: [
        'ajv validate -s .agents/schemas/baselines/coverage.schema.json',
      ],
    }),
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
    FEATURE,
    makeStory('s-a'),
    makeStory('s-b'),
    makeTask('t-a', 's-a', {
      changes: ['.github/workflows/quality.yml: tighten lint job'],
    }),
    makeTask('t-b', 's-b', {
      changes: ['.github/workflows/quality.yml: add coverage gate'],
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
    FEATURE,
    makeStory('s-producer'),
    makeStory('s-consumer'),
    makeTask('t-producer', 's-producer', {
      changes: [
        '.agents/schemas/baselines/coverage.schema.json: introduce schema',
      ],
    }),
    makeTask('t-consumer', 's-consumer', {
      changes: ['src/consumer.js: read schema'],
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
    FEATURE,
    makeStory('s-a'),
    makeStory('s-b'),
    makeTask('t-a', 's-a', { changes: ['src/a.js: edit'] }),
    makeTask('t-b', 's-b', { changes: ['src/b.js: edit'] }),
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
    FEATURE,
    makeStory('s-a'),
    makeStory('s-b'),
    makeStory('s-c'),
    makeTask('t-a', 's-a', { changes: ['package.json: bump deps'] }),
    makeTask('t-b', 's-b', { changes: ['package.json: add script'] }),
    makeTask('t-c', 's-c', { changes: ['package.json: edit engines field'] }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  const shared = result.findings.filter((f) => f.kind === 'shared-editor');
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].storySlugs, ['s-a', 's-b', 's-c']);
});

// ---------------------------------------------------------------------------
// Pure-function unit coverage on the internal helpers
// ---------------------------------------------------------------------------

test('extractChangeBulletPath: requires a colon and a slash/dot head', () => {
  const { extractChangeBulletPath } = _internal;
  assert.equal(extractChangeBulletPath('src/a.js: edit'), 'src/a.js');
  assert.equal(
    extractChangeBulletPath('.github/workflows/x.yml: rewrite'),
    '.github/workflows/x.yml',
  );
  assert.equal(extractChangeBulletPath('no colon present'), null);
  assert.equal(extractChangeBulletPath('plain: no path head'), null);
  assert.equal(extractChangeBulletPath(undefined), null);
});

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
  assert.deepEqual(computeConflictFindings({ tasks: [], stories: [] }), []);
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
