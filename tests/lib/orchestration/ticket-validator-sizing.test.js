import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * Sizing validator fixtures for the collapsed sizing model (Story #3760).
 *
 * The per-profile ceiling matrix, the parallel `testSurface` axis, and the
 * `sizingProfile` enum (`atomic-rewrite` / `scaffolding` / `mechanical-sweep`)
 * are gone. The model is now:
 *
 *   - Flat knobs (DEFAULT_TASK_SIZING): softFiles=5, hardFiles=15,
 *     maxAcceptance=8, softAcceptanceCount=6.
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
 * 3-tier (Epic #3238): each Story is its own implementation unit and carries
 * the `body` (goal / changes / acceptance / verify / wide) plus the top-level
 * `acceptance[]` + `verify[]` inline contract the validator requires.
 */

const FEATURE = Object.freeze({
  type: 'feature',
  slug: 'f-sizing',
  title: 'Sizing fixtures',
});

function makeStory(slug = 's-sizing', body) {
  return {
    type: 'story',
    slug,
    parent_slug: 'f-sizing',
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

// ---------------------------------------------------------------------------
// Narrow Story baseline — no findings
// ---------------------------------------------------------------------------

test('narrow Story with no wide declaration produces no findings', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-narrow', {
      changes: ['src/a.js: edit', 'src/b.js: edit', 'src/c.js: edit'],
      acceptance: ['criterion 1', 'criterion 2'],
    }),
  ]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Acceptance ceiling — maxAcceptance=8, softAcceptanceCount=6
// ---------------------------------------------------------------------------

test('Story with 8 acceptance items validates clean (maxAcceptance=8)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-8ac', {
      acceptance: Array.from({ length: 8 }, (_, i) => `criterion ${i}`),
    }),
  ]);
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
});

test('Story with 9 acceptance items trips hard oversized-task (ceiling=8)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-9ac', {
      acceptance: Array.from({ length: 9 }, (_, i) => `criterion ${i}`),
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 9);
  assert.equal(hard[0].ceiling, 8);
  assert.equal(
    result.errors.filter((e) => e.includes('acceptance ceiling')).length,
    1,
  );
});

test('Story with 7 acceptance items emits soft-task-width on acceptance field', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-7ac-soft', {
      acceptance: Array.from({ length: 7 }, (_, i) => `criterion ${i}`),
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.deepEqual(hard, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'acceptance',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 7);
  assert.equal(soft[0].soft, 6);
});

// ---------------------------------------------------------------------------
// File width — single ceiling (softFiles=5, hardFiles=15)
// ---------------------------------------------------------------------------

test('5 files (at softFiles) produces no width finding', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-5files', { changes: changes(5) }),
  ]);
  const widthFindings = result.findings.filter(
    (f) => f.kind === 'wide-undeclared' || f.field === 'fileCount',
  );
  assert.deepEqual(widthFindings, []);
  assert.deepEqual(result.errors, []);
});

test('6 files (>softFiles) with no wide declaration emits wide-undeclared (soft, no rejection)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-6files', { changes: changes(6) }),
  ]);
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].fileCount, 6);
  assert.equal(nudge[0].softFiles, 5);
});

test('16 files (>hardFiles) with no wide declaration trips hard oversized-task on fileCount', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-16files', { changes: changes(16) }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 16);
  assert.equal(hard[0].ceiling, 15);
  assert.equal(
    result.errors.filter((e) => e.includes('fileCount ceiling')).length,
    1,
  );
});

test('16 files WITH a wide declaration lifts the hard ceiling (soft-task-width only)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-16files-wide', {
      changes: changes(16),
      wide: { reason: 'hard contract cutover across every call site' },
    }),
  ]);
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  // Declared-wide Stories still surface the width as advisory signal.
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'fileCount',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 16);
  assert.equal(soft[0].soft, 5);
});

test('6 files WITH a wide declaration emits soft-task-width, not wide-undeclared', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-6files-wide', {
      changes: changes(6),
      wide: { reason: 'legitimately broad: scaffold a new package skeleton' },
    }),
  ]);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.deepEqual(nudge, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'fileCount',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 6);
  assert.equal(soft[0].soft, 5);
  assert.deepEqual(result.errors, []);
});

test('a wide declaration with an empty reason does NOT lift the hard ceiling', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-wide-empty-reason', {
      changes: changes(16),
      wide: { reason: '   ' },
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].ceiling, 15);
});

// ---------------------------------------------------------------------------
// Glob-aware sizing — unknown-width bypasses the numeric ceiling
// ---------------------------------------------------------------------------

test('glob entry with no wide declaration emits wide-undeclared (soft)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-glob-no-wide', {
      changes: ['**/*.ts: update imports'],
    }),
  ]);
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].ticketSlug, 't-glob-no-wide');
  assert.equal(nudge[0].reason, 'glob-changes');
});

test('glob entry WITH a wide declaration produces no wide-undeclared finding', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-glob-wide', {
      changes: ['**/*.ts: update imports'],
      wide: { reason: 'mechanical sweep: rename across every consumer site' },
    }),
  ]);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.deepEqual(nudge, []);
  assert.deepEqual(result.errors, []);
});

test('glob entries skip the numeric ceiling — 100 globs never trip oversized-task', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-glob-many', {
      changes: Array.from({ length: 100 }, (_, i) => `src/**/${i}.ts: edit`),
      wide: { reason: 'sweep' },
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.deepEqual(hard, []);
});

// ---------------------------------------------------------------------------
// PathEntry object form in changes[] counts files correctly
// ---------------------------------------------------------------------------

test('changes[] with PathEntry object form counts files correctly (not zero)', () => {
  // 6 PathEntry objects, no wide → wide-undeclared (fileCount=6 > softFiles=5).
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-pathentry', {
      changes: [
        { path: 'src/a.js', assumption: 'creates' },
        { path: 'src/b.js', assumption: 'refactors-existing' },
        { path: 'src/c.js', assumption: 'exists' },
        { path: 'src/d.js', assumption: 'deletes' },
        { path: 'src/e.js', assumption: 'refactors-existing' },
        { path: 'src/f.js', assumption: 'refactors-existing' },
      ],
    }),
  ]);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(
    nudge.length,
    1,
    'expected wide-undeclared for 6 PathEntry changes',
  );
  assert.equal(nudge[0].fileCount, 6);
});

test('changes[] with a glob PathEntry object triggers wide-undeclared', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory('t-glob-pathentry', {
      changes: [{ path: '**/*.js', assumption: 'refactors-existing' }],
    }),
  ]);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
});

// ---------------------------------------------------------------------------
// 3-tier guard — a Story missing its inline acceptance + verify contract is
// rejected (Epic #3238).
// ---------------------------------------------------------------------------

test('rejects a Story that lacks an inline acceptance + verify contract', () => {
  assert.throws(
    () =>
      validateAndNormalizeTickets([
        FEATURE,
        {
          type: 'story',
          slug: 's-no-contract',
          parent_slug: 'f-sizing',
          title: 'Story without inline contract',
          body: { goal: 'Goal.', changes: ['src/a.js: edit'] },
        },
      ]),
    /lack an inline acceptance \+ verify contract/,
  );
});
