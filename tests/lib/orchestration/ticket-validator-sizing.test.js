import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * Three-layer Task sizing model fixtures (Epic #1178 Story #1191).
 *
 * Each fixture exercises one row of the sizing matrix below and asserts the
 * structured findings array attached to the validator's return value:
 *
 *   | width                    | sizingProfile           | expected finding                    |
 *   | ------------------------ | ----------------------- | ----------------------------------- |
 *   | narrow (≤ softFileCount) | absent                  | none                                |
 *   | wide (> softFileCount)   | valid enum              | none (hard); soft-task-width (soft) |
 *   | wide (> softFileCount)   | absent / invalid value  | missing-sizing-profile (hard)       |
 *   | over hard ceilings       | n/a                     | oversized-task per violated field   |
 *   | soft-only breach         | valid enum if also wide | soft-task-width (soft only)         |
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

test('narrow Task with no sizingProfile produces no findings', () => {
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

test('wide Task with valid sizingProfile produces no hard findings', () => {
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
      sizingProfile: 'atomic-rewrite',
    }),
  ]);
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  // The wide-but-valid path emits a soft-task-width finding so the
  // analyzer/operator can still see the width signal.
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

test('wide Task missing sizingProfile produces missing-sizing-profile hard finding', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-wide-missing-profile', {
      changes: [
        'src/a.js: edit',
        'src/b.js: edit',
        'src/c.js: edit',
        'src/d.js: edit',
        'src/e.js: edit',
      ],
    }),
  ]);
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, [
    {
      kind: 'missing-sizing-profile',
      severity: 'hard',
      ticketSlug: 't-wide-missing-profile',
      fileCount: 5,
      softFileCount: 3,
    },
  ]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /missing-sizing-profile|sizingProfile/i);
});

test('Task with 9 changes and 7 acceptance items produces oversized-task hard findings on each violated field', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-overflow', {
      changes: Array.from({ length: 9 }, (_, i) => `src/file${i}.js: edit`),
      acceptance: Array.from({ length: 7 }, (_, i) => `criterion ${i}`),
      // Declare a valid sizingProfile so the only hard findings come from
      // the structural-ceiling layer; the fixture is focused on the
      // oversized-task kind.
      sizingProfile: 'atomic-rewrite',
    }),
  ]);
  const oversized = result.findings.filter((f) => f.kind === 'oversized-task');
  assert.deepEqual(
    oversized.sort((a, b) => a.field.localeCompare(b.field)),
    [
      {
        kind: 'oversized-task',
        severity: 'hard',
        ticketSlug: 't-overflow',
        field: 'acceptance',
        observed: 7,
        ceiling: 6,
      },
      {
        kind: 'oversized-task',
        severity: 'hard',
        ticketSlug: 't-overflow',
        field: 'changes',
        observed: 9,
        ceiling: 8,
      },
    ],
  );
  // Both hard findings populate the errors[] channel so the AC-visible
  // "block normalization" signal fires.
  assert.equal(
    result.errors.filter((e) => e.includes('changes ceiling')).length,
    1,
  );
  assert.equal(
    result.errors.filter((e) => e.includes('acceptance ceiling')).length,
    1,
  );
});

test('soft heuristic breach (4 files, valid sizingProfile) produces soft-task-width finding only', () => {
  const result = validateAndNormalizeTickets([
    FEATURE,
    makeStory(),
    makeTask('t-soft-only', {
      changes: [
        'src/a.js: edit',
        'src/b.js: edit',
        'src/c.js: edit',
        'src/d.js: edit',
      ],
      sizingProfile: 'mechanical-sweep',
    }),
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.findings, [
    {
      kind: 'soft-task-width',
      severity: 'soft',
      ticketSlug: 't-soft-only',
      field: 'fileCount',
      observed: 4,
      soft: 3,
    },
  ]);
});
