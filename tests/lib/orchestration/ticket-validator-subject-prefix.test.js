import assert from 'node:assert/strict';
import test from 'node:test';
import { ValidationError } from '../../../.agents/scripts/lib/errors/index.js';
import {
  validateAcceptanceSubjectPrefix,
  validateAndNormalizeTickets,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * Minimal 3-tier hierarchy (Feature → Story) used to drive the full
 * `validateAndNormalizeTickets` path. Under Epic #3238 the Story is the
 * implementation unit and carries the top-level `acceptance[]` array that
 * the subject-prefix pass scans, so the per-test variable lives there.
 */
function makeHierarchy(storyAcceptance) {
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
      parent_slug: 'F1',
      acceptance: storyAcceptance,
      verify: ['npm test (validate)'],
      body: {
        goal: 'Make a change for S1.',
        changes: ['.agents/scripts/foo.js: add helper'],
        acceptance: storyAcceptance,
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
  assert.equal(caught.violations[0].slug, 'S1');
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

test('validateAcceptanceSubjectPrefix: skips Stories with string-shaped bodies', () => {
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
      parent_slug: 'F1',
      // String body — no structured acceptance array to scan, so the
      // subject-prefix pass skips it entirely.
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

test('validateAndNormalizeTickets: rejects a Story that lacks an inline acceptance + verify contract', () => {
  // 3-tier (Epic #3238): a Story missing top-level acceptance/verify is the
  // legacy 4-tier shape and is rejected outright.
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
      title: 'Story without inline contract',
      parent_slug: 'F1',
      body: {
        goal: 'Make a change for S1.',
        changes: ['.agents/scripts/foo.js: add helper'],
      },
    },
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /lack an inline acceptance \+ verify contract/,
  );
});
