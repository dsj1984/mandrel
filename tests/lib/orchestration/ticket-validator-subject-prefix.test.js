import assert from 'node:assert/strict';
import test from 'node:test';
import { ValidationError } from '../../../.agents/scripts/lib/errors/index.js';
import {
  validateAcceptanceSubjectPrefix,
  validateAndNormalizeTickets,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * Minimal three-level hierarchy (Feature → Story → Task) used to drive the
 * full `validateAndNormalizeTickets` path. The Task body is the variable
 * the per-test specializes via `acceptance`.
 */
function makeHierarchy(taskAcceptance) {
  return [
    {
      slug: 'F1',
      type: 'feature',
      title: 'Feature 1',
      body: 'Feature body',
      parent_slug: undefined,
    },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story 1',
      body: 'Story body',
      parent_slug: 'F1',
    },
    {
      slug: 'T1',
      type: 'task',
      title: 'Task 1',
      parent_slug: 'S1',
      body: {
        goal: 'Make a change for S1.',
        changes: ['.agents/scripts/foo.js: add helper'],
        acceptance: taskAcceptance,
        verify: ['npm test (validate)'],
      },
    },
  ];
}

test('validateAcceptanceSubjectPrefix: accepts chore(baselines): scope-qualified type', () => {
  const tickets = makeHierarchy([
    "Commit subject begins with 'chore(baselines):' and references the refresh",
    'Commit body trailer baseline-refresh: true present',
  ]);
  assert.doesNotThrow(() => validateAcceptanceSubjectPrefix({ tickets }));
});

test('validateAcceptanceSubjectPrefix: rejects forbidden baseline-refresh subject prefix', () => {
  const tickets = makeHierarchy([
    "Commit subject begins with 'baseline-refresh:' (forbidden)",
  ]);
  let caught;
  try {
    validateAcceptanceSubjectPrefix({ tickets });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ValidationError, 'expected ValidationError');
  assert.equal(caught.code, 'forbidden-subject-prefix');
  assert.ok(
    Array.isArray(caught.violations),
    'violations payload should be attached',
  );
  assert.equal(caught.violations.length, 1);
  assert.equal(caught.violations[0].prefix, 'baseline-refresh');
  assert.equal(caught.violations[0].slug, 'T1');
});

test('validateAcceptanceSubjectPrefix: accepts acceptance bodies with no commit-subject prescription', () => {
  const tickets = makeHierarchy([
    'Validator throws ValidationError on missing path',
    'npm test exits 0',
  ]);
  assert.doesNotThrow(() => validateAcceptanceSubjectPrefix({ tickets }));
});

test('validateAcceptanceSubjectPrefix: accepts every allowed Conventional-Commits type', () => {
  for (const type of [
    'feat',
    'fix',
    'chore',
    'refactor',
    'perf',
    'docs',
    'style',
    'test',
    'build',
    'ci',
    'revert',
  ]) {
    const tickets = makeHierarchy([
      `Commit subject begins with '${type}:' as required`,
    ]);
    assert.doesNotThrow(
      () => validateAcceptanceSubjectPrefix({ tickets }),
      `type "${type}" must be accepted`,
    );
  }
});

test('validateAcceptanceSubjectPrefix: rejects unknown leading token even with scope qualifier', () => {
  const tickets = makeHierarchy([
    'Commit subject begins with "baseline-refresh(snapshot):" prefix',
  ]);
  let caught;
  try {
    validateAcceptanceSubjectPrefix({ tickets });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ValidationError);
  assert.equal(caught.code, 'forbidden-subject-prefix');
  assert.equal(caught.violations[0].prefix, 'baseline-refresh(snapshot)');
});

test('validateAcceptanceSubjectPrefix: skips tasks with string-shaped bodies', () => {
  const tickets = [
    {
      slug: 'F1',
      type: 'feature',
      title: 'Feature 1',
      body: 'Feature body',
    },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story 1',
      body: 'Story body',
      parent_slug: 'F1',
    },
    {
      slug: 'T1',
      type: 'task',
      title: 'Task 1',
      parent_slug: 'S1',
      // String body — legacy shape, no acceptance array to scan.
      body: "Commit subject begins with 'baseline-refresh:' (this should be ignored — it is not a structured acceptance array)",
    },
  ];
  assert.doesNotThrow(() => validateAcceptanceSubjectPrefix({ tickets }));
});

test('validateAndNormalizeTickets: rejects forbidden subject prefix during full validation', () => {
  const tickets = makeHierarchy([
    "Commit subject begins with 'baseline-refresh:' and refreshes CRAP",
  ]);
  let caught;
  try {
    validateAndNormalizeTickets(tickets);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ValidationError);
  assert.equal(caught.code, 'forbidden-subject-prefix');
});

test('validateAndNormalizeTickets: passes when acceptance prescribes a valid Conventional-Commits subject', () => {
  const tickets = makeHierarchy([
    "Commit subject begins with 'chore(baselines):' for the refresh",
    'Commit body carries baseline-refresh: true trailer',
  ]);
  assert.doesNotThrow(() => validateAndNormalizeTickets(tickets));
});
