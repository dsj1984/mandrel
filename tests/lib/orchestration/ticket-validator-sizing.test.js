import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * Sizing validator fixtures for the collapsed sizing model (Story #3760),
 * re-pointed at the uniform relaxed profile (Story #3874).
 *
 * The per-profile ceiling matrix, the parallel `testSurface` axis, and the
 * `sizingProfile` enum (`atomic-rewrite` / `scaffolding` / `mechanical-sweep`)
 * are gone. The model is now:
 *
 *   - Flat knobs (DEFAULT_TASK_SIZING): softFiles=8, hardFiles=30,
 *     maxAcceptance=14, softAcceptanceCount=10.
 *   - A single optional `body.wide = { reason }` declaration. Declaring `wide`
 *     with a non-empty reason lifts the hardFiles rejection — no Story is
 *     rejected for width when `wide` is declared.
 *   - Cohesion is the primary heuristic; the numeric ceiling is a backstop.
 *
 * Findings:
 *   - oversized-task (hard) — acceptance > maxAcceptance, or fileCount >
 *     hardFiles when `wide` is not declared.
 *   - soft-task-width (soft) — acceptance > softAcceptanceCount, or fileCount >
 *     softFiles (when `wide` IS declared — declared-wide Stories still surface
 *     the width as advisory signal).
 *   - wide-undeclared (soft) — fileCount > softFiles with no `wide`
 *     declaration, or glob changes with no `wide` declaration.
 *
 * 2-tier (Epic #3238): each Story is its own implementation unit and carries
 * the `body` (goal / changes / acceptance / verify / wide) plus the top-level
 * `acceptance[]` + `verify[]` inline contract the validator requires.
 */

function makeStory(slug = 's-sizing', body) {
  return {
    type: 'story',
    slug,
    title: `Sizing story ${slug}`,
    acceptance: ['observable criterion'],
    verify: ['npm test (unit)'],
    body: {
      goal: `Goal for ${slug}.`,
      changes: ['src/a.js: edit'],
      acceptance: ['observable criterion'],
      verify: ['npm test (unit)'],
      ...body,
    },
  };
}

function changes(n, verb = 'edit') {
  return Array.from({ length: n }, (_, i) => `src/file${i}.js: ${verb}`);
}

/**
 * Benign filler sibling Story. It touches a single unique path, has a
 * minimal inline contract, and declares no glob / wide — so it adds ZERO
 * sizing or conflict findings and never perturbs the assertions under
 * test.
 */
const SIBLING_FILLER = Object.freeze({
  type: 'story',
  slug: 's-sizing-filler',
  title: 'Sizing fixtures — filler sibling',
  acceptance: ['filler observable criterion'],
  verify: ['npm test (unit)'],
  body: {
    goal: 'Filler sibling so the Feature has two Stories.',
    changes: ['src/_sizing-filler.js: edit'],
    acceptance: ['filler observable criterion'],
    verify: ['npm test (unit)'],
  },
});

/**
 * Validate a single Story alongside the benign filler sibling.
 * Tests that need a custom invalid
 * story (e.g. the missing-inline-contract case) call
 * `validateAndNormalizeTickets` directly with their own array.
 */
function validateStory(story, opts) {
  return validateAndNormalizeTickets([story, SIBLING_FILLER], opts);
}

// ---------------------------------------------------------------------------
// Narrow Story baseline — no findings
// ---------------------------------------------------------------------------

test('narrow Story with no wide declaration produces no findings', () => {
  const result = validateStory(
    makeStory('t-narrow', {
      changes: ['src/a.js: edit', 'src/b.js: edit', 'src/c.js: edit'],
      acceptance: ['criterion 1', 'criterion 2'],
    }),
  );
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Acceptance ceiling — maxAcceptance=14, softAcceptanceCount=10
// ---------------------------------------------------------------------------

test('Story with 14 acceptance items validates clean (maxAcceptance=14)', () => {
  const result = validateStory(
    makeStory('t-14ac', {
      acceptance: Array.from({ length: 14 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
});

test('Story with 15 acceptance items trips hard oversized-task (ceiling=14)', () => {
  const result = validateStory(
    makeStory('t-15ac', {
      acceptance: Array.from({ length: 15 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 15);
  assert.equal(hard[0].ceiling, 14);
  assert.equal(
    result.errors.filter((e) => e.includes('acceptance ceiling')).length,
    1,
  );
});

test('Story with 11 acceptance items emits soft-task-width on acceptance field', () => {
  const result = validateStory(
    makeStory('t-11ac-soft', {
      acceptance: Array.from({ length: 11 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.deepEqual(hard, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'acceptance',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 11);
  assert.equal(soft[0].soft, 10);
});

test('wide lifts only the file ceiling — 15 acceptance items still hard-reject with wide declared', () => {
  const result = validateStory(
    makeStory('t-15ac-wide', {
      acceptance: Array.from({ length: 15 }, (_, i) => `criterion ${i}`),
      wide: { reason: 'hard contract cutover across every call site' },
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 15);
  assert.equal(hard[0].ceiling, 14);
  assert.equal(
    result.errors.filter((e) => e.includes('acceptance ceiling')).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// File width — single ceiling (softFiles=8, hardFiles=30)
// ---------------------------------------------------------------------------

test('8 files (at softFiles) produces no width finding', () => {
  const result = validateStory(makeStory('t-8files', { changes: changes(8) }));
  const widthFindings = result.findings.filter(
    (f) => f.kind === 'wide-undeclared' || f.field === 'fileCount',
  );
  assert.deepEqual(widthFindings, []);
  assert.deepEqual(result.errors, []);
});

test('9 files (>softFiles) with no wide declaration emits wide-undeclared (soft, no rejection)', () => {
  const result = validateStory(makeStory('t-9files', { changes: changes(9) }));
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].fileCount, 9);
  assert.equal(nudge[0].softFiles, 8);
});

test('31 files (>hardFiles) with no wide declaration trips hard oversized-task on fileCount', () => {
  const result = validateStory(
    makeStory('t-31files', { changes: changes(31) }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 31);
  assert.equal(hard[0].ceiling, 30);
  assert.equal(
    result.errors.filter((e) => e.includes('fileCount ceiling')).length,
    1,
  );
});

test('31 files WITH a wide declaration lifts the hard ceiling (soft-task-width only)', () => {
  const result = validateStory(
    makeStory('t-31files-wide', {
      changes: changes(31),
      wide: { reason: 'hard contract cutover across every call site' },
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  // Declared-wide Stories still surface the width as advisory signal.
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'fileCount',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 31);
  assert.equal(soft[0].soft, 8);
});

test('9 files WITH a wide declaration emits soft-task-width, not wide-undeclared', () => {
  const result = validateStory(
    makeStory('t-9files-wide', {
      changes: changes(9),
      wide: { reason: 'legitimately broad: scaffold a new package skeleton' },
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.deepEqual(nudge, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'fileCount',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 9);
  assert.equal(soft[0].soft, 8);
  assert.deepEqual(result.errors, []);
});

test('a wide declaration with an empty reason does NOT lift the hard ceiling', () => {
  const result = validateStory(
    makeStory('t-wide-empty-reason', {
      changes: changes(31),
      wide: { reason: '   ' },
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].ceiling, 30);
});

// ---------------------------------------------------------------------------
// Glob-aware sizing — unknown-width bypasses the numeric ceiling
// ---------------------------------------------------------------------------

test('glob entry with no wide declaration emits wide-undeclared (soft)', () => {
  const result = validateStory(
    makeStory('t-glob-no-wide', {
      changes: ['**/*.ts: update imports'],
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].ticketSlug, 't-glob-no-wide');
  assert.equal(nudge[0].reason, 'glob-changes');
});

test('glob entry WITH a wide declaration produces no wide-undeclared finding', () => {
  const result = validateStory(
    makeStory('t-glob-wide', {
      changes: ['**/*.ts: update imports'],
      wide: { reason: 'mechanical sweep: rename across every consumer site' },
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.deepEqual(nudge, []);
  assert.deepEqual(result.errors, []);
});

test('glob entries skip the numeric ceiling — 100 globs never trip oversized-task', () => {
  const result = validateStory(
    makeStory('t-glob-many', {
      changes: Array.from({ length: 100 }, (_, i) => `src/**/${i}.ts: edit`),
      wide: { reason: 'sweep' },
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.deepEqual(hard, []);
});

// ---------------------------------------------------------------------------
// PathEntry object form in changes[] counts files correctly
// ---------------------------------------------------------------------------

test('changes[] with PathEntry object form counts files correctly (not zero)', () => {
  // 9 PathEntry objects, no wide → wide-undeclared (fileCount=9 > softFiles=8).
  const result = validateStory(
    makeStory('t-pathentry', {
      changes: [
        { path: 'src/a.js', assumption: 'creates' },
        { path: 'src/b.js', assumption: 'refactors-existing' },
        { path: 'src/c.js', assumption: 'exists' },
        { path: 'src/d.js', assumption: 'deletes' },
        { path: 'src/e.js', assumption: 'refactors-existing' },
        { path: 'src/f.js', assumption: 'refactors-existing' },
        { path: 'src/g.js', assumption: 'refactors-existing' },
        { path: 'src/h.js', assumption: 'refactors-existing' },
        { path: 'src/i.js', assumption: 'refactors-existing' },
      ],
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(
    nudge.length,
    1,
    'expected wide-undeclared for 9 PathEntry changes',
  );
  assert.equal(nudge[0].fileCount, 9);
});

test('changes[] with a glob PathEntry object triggers wide-undeclared', () => {
  const result = validateStory(
    makeStory('t-glob-pathentry', {
      changes: [{ path: '**/*.js', assumption: 'refactors-existing' }],
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
});

// ---------------------------------------------------------------------------
// 2-tier guard — a Story missing its inline acceptance + verify contract is
// rejected (Epic #3238).
// ---------------------------------------------------------------------------

test('rejects a Story that lacks an inline acceptance + verify contract', () => {
  assert.throws(
    () =>
      validateAndNormalizeTickets([
        {
          type: 'story',
          slug: 's-no-contract',
          title: 'Story without inline contract',
          body: { goal: 'Goal.', changes: ['src/a.js: edit'] },
        },
        SIBLING_FILLER,
      ]),
    /lack an inline acceptance \+ verify contract/,
  );
});
