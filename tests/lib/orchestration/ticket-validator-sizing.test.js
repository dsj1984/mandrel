import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * Three-layer Story sizing model fixtures (Story #3231, Epic #3211 Feature 5).
 *
 * Recalibrations covered:
 *   Recal A — Per-profile change ceilings (replace global maxChanges: 8)
 *   Recal B — maxAcceptance raised from 6 to 8
 *   Recal C — sizingProfile recommended-always (informational hint, not hard rejection)
 *   Recal D — SOFT_STORY_TASK_COUNT / soft-story-width removed (inert in 3-tier)
 *   Gap 4   — Glob changes[] entries → unknown-width / glob-without-sizing-profile
 *
 * The hierarchical scaffolding (one Feature, one Story per Task) is the
 * minimum the validator accepts; the sizing logic is the only thing under
 * test here so the fixtures stay focused.
 */

const FEATURE = Object.freeze({
  type: 'feature',
  slug: 'f-sizing',
  title: 'Sizing fixtures',
});

function makeStory(slug = 's-sizing') {
  return {
    type: 'story',
    slug,
    parent_slug: 'f-sizing',
    title: 'Sizing story',
  };
}

function makeTask(slug, body, parentSlug = 's-sizing') {
  return {
    type: 'task',
    slug,
    parent_slug: parentSlug,
    title: `Task ${slug}`,
    body: {
      goal: `Goal for ${slug} (parent ${parentSlug}).`,
      changes: ['src/a.js: edit'],
      acceptance: ['observable criterion'],
      verify: ['npm test (unit)'],
      ...body,
    },
  };
}

// ---------------------------------------------------------------------------
// Narrow Story baseline — no findings
// ---------------------------------------------------------------------------

test('narrow Story with no sizingProfile produces no findings', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-narrow', {
      changes: ['src/a.js: edit', 'src/b.js: edit', 'src/c.js: edit'],
      acceptance: ['criterion 1', 'criterion 2'],
    }),
  ]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Recal B — maxAcceptance raised to 8
// ---------------------------------------------------------------------------

test('Story with 8 acceptance items validates clean (Recal B: maxAcceptance=8)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-8ac', {
      acceptance: Array.from({ length: 8 }, (_, i) => `criterion ${i}`),
    }),
  ]);
  // No hard findings — 8 is the new ceiling.
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
});

test('Story with 9 acceptance items trips hard oversized-task (Recal B: ceiling=8)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-9ac', {
      acceptance: Array.from({ length: 9 }, (_, i) => `criterion ${i}`),
      sizingProfile: 'scaffolding',
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

// ---------------------------------------------------------------------------
// Recal C — sizingProfile recommended-always (soft hint, not hard rejection)
// ---------------------------------------------------------------------------

test('Story with 5 changes and no sizingProfile emits missing-sizing-profile-hint (Recal C: no hard rejection)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-wide-no-profile', {
      changes: [
        'src/a.js: edit',
        'src/b.js: edit',
        'src/c.js: edit',
        'src/d.js: edit',
        'src/e.js: edit',
      ],
    }),
  ]);
  // No hard findings — Recal C drops the hard missing-sizing-profile rejection.
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  // Informational hint fires instead.
  const hint = result.findings.filter(
    (f) => f.kind === 'missing-sizing-profile-hint',
  );
  assert.equal(hint.length, 1);
  assert.equal(hint[0].fileCount, 5);
  assert.equal(hint[0].softFileCount, 3);
});

test('wide Story with valid sizingProfile emits soft-task-width only (no hard finding)', () => {
  // Use scaffolding (soft=8, hard=15) with 4 changes so only the fileCount
  // soft breach fires (fileCount=4 > softFileCount=3), not the changes breach.
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-wide-valid', {
      changes: [
        'src/a.js: edit',
        'src/b.js: edit',
        'src/c.js: edit',
        'src/d.js: edit',
      ],
      sizingProfile: 'scaffolding',
    }),
  ]);
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  // Soft-width signal still emitted so the operator can see the width signal.
  assert.deepEqual(result.findings, [
    {
      kind: 'soft-task-width',
      severity: 'soft',
      ticketSlug: 't-wide-valid',
      field: 'fileCount',
      observed: 4,
      soft: 3,
    },
  ]);
});

// ---------------------------------------------------------------------------
// Recal A — Per-profile change ceilings
// ---------------------------------------------------------------------------

test('mechanical-sweep: 30 changes is a soft breach (soft=25), no hard finding', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-sweep-soft', {
      changes: Array.from({ length: 30 }, (_, i) => `src/file${i}.js: rename`),
      sizingProfile: 'mechanical-sweep',
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.deepEqual(hard, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'changes',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 30);
  assert.equal(soft[0].soft, 25);
});

test('mechanical-sweep: 61 changes trips hard ceiling (hard=60)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-sweep-hard', {
      changes: Array.from({ length: 61 }, (_, i) => `src/file${i}.js: rename`),
      sizingProfile: 'mechanical-sweep',
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 61);
  assert.equal(hard[0].ceiling, 60);
  assert.equal(
    result.errors.filter((e) => e.includes('changes ceiling')).length,
    1,
  );
});

test('scaffolding: 10 changes is a soft breach (soft=8), no hard finding', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-scaffold-soft', {
      changes: Array.from({ length: 10 }, (_, i) => `src/new${i}.js: create`),
      sizingProfile: 'scaffolding',
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.deepEqual(hard, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'changes',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 10);
  assert.equal(soft[0].soft, 8);
});

test('scaffolding: 16 changes trips hard ceiling (hard=15)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-scaffold-hard', {
      changes: Array.from({ length: 16 }, (_, i) => `src/new${i}.js: create`),
      sizingProfile: 'scaffolding',
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].ceiling, 15);
  assert.equal(hard[0].observed, 16);
});

test('atomic-rewrite: 3 changes is a soft breach (soft=2), no hard finding', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-rewrite-soft', {
      changes: ['src/a.js: rewrite', 'src/b.js: rewrite', 'src/c.js: rewrite'],
      sizingProfile: 'atomic-rewrite',
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.deepEqual(hard, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'changes',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 3);
  assert.equal(soft[0].soft, 2);
});

test('atomic-rewrite: 5 changes trips hard ceiling (hard=4)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-rewrite-hard', {
      changes: Array.from({ length: 5 }, (_, i) => `src/file${i}.js: rewrite`),
      sizingProfile: 'atomic-rewrite',
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].ceiling, 4);
  assert.equal(hard[0].observed, 5);
});

test('no-profile: 4 changes is a soft breach (soft=3), no hard finding', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-noprofile-soft', {
      changes: Array.from({ length: 4 }, (_, i) => `src/f${i}.js: edit`),
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.deepEqual(hard, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'changes',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 4);
  assert.equal(soft[0].soft, 3);
});

test('no-profile: 7 changes trips hard ceiling (hard=6)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-noprofile-hard', {
      changes: Array.from({ length: 7 }, (_, i) => `src/f${i}.js: edit`),
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].ceiling, 6);
  assert.equal(hard[0].observed, 7);
});

// ---------------------------------------------------------------------------
// Gap 4 — Glob-aware sizing
// ---------------------------------------------------------------------------

test('glob entry in changes emits glob-without-sizing-profile soft finding when no profile (Gap 4)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-glob-no-profile', {
      changes: ['**/*.ts: update imports'],
    }),
  ]);
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  const globFindings = result.findings.filter(
    (f) => f.kind === 'glob-without-sizing-profile',
  );
  assert.equal(globFindings.length, 1);
  assert.equal(globFindings[0].ticketSlug, 't-glob-no-profile');
});

test('glob entry with valid sizingProfile produces no glob-without-sizing-profile finding (Gap 4)', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-glob-with-profile', {
      changes: ['**/*.ts: update imports'],
      sizingProfile: 'mechanical-sweep',
    }),
  ]);
  const globFindings = result.findings.filter(
    (f) => f.kind === 'glob-without-sizing-profile',
  );
  assert.deepEqual(globFindings, []);
  assert.deepEqual(result.errors, []);
});

test('glob entries skip numeric ceiling check — unknown-width bypasses oversized-task (Gap 4)', () => {
  // 100 glob bullets — none are explicit paths, so no oversized-task on changes.
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-glob-many', {
      changes: Array.from({ length: 100 }, (_, i) => `src/**/${i}.ts: edit`),
      sizingProfile: 'mechanical-sweep',
    }),
  ]);
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'changes',
  );
  assert.deepEqual(hard, []);
});

// ---------------------------------------------------------------------------
// Recal D — soft-story-width never fires (computeStorySizingFindings removed)
// ---------------------------------------------------------------------------

test('no soft-story-width finding emitted in 3-tier world (Recal D)', () => {
  const extraStory = makeStory('s-extra');
  extraStory.parent_slug = 'f-sizing';
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-d1'),
    extraStory,
    makeTask('t-d2', {}, 's-extra'),
  ]);
  const storyWidthFindings = result.findings.filter(
    (f) => f.kind === 'soft-story-width',
  );
  assert.deepEqual(storyWidthFindings, []);
});

// ---------------------------------------------------------------------------
// 4-tier guard — assertEveryStoryHasTasks and countTasksByStory intact
// ---------------------------------------------------------------------------

test('assertEveryStoryHasTasks guard fires for Stories with no child tasks (4-tier guard intact)', () => {
  // The 4-tier cardinality guard (assertEveryStoryHasTasks) must remain
  // intact per Epic #3211 Non-Goals (refs Epic #3078).
  assert.throws(
    () =>
      validateAndNormalizeTickets([
        FEATURE,
        makeStory(),
        // No tasks under the story.
      ]),
    /task/i,
  );
});

// ---------------------------------------------------------------------------
// Soft acceptance breach (softAcceptanceCount=6) still fires
// ---------------------------------------------------------------------------

test('Story with 7 acceptance items emits soft-task-width on acceptance field', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-7ac-soft', {
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
