/**
 * tests/lib/audit-suite/lens-diff-floor.test.js — Story #4699.
 *
 * Pins the close-scope lens diff-floor:
 *
 *   - `evaluateLensDiffFloor` skips ONLY on positive evidence (known line
 *     count strictly below the floor, zero sensitive-path hits); every
 *     degraded input fails open to "do not skip".
 *   - `countChangedLines` totals `git diff --numstat` output and returns
 *     `null` (count unknown) on any failure or unparseable output.
 *   - `resolveLensDiffFloor` reads `delivery.review.lensDiffFloor` with the
 *     framework default (40) and `0`-disables.
 *   - `runLocalLensReview` under the floor: a below-floor non-sensitive diff
 *     produces NO lens artifacts (runAuditSuite never runs) and records the
 *     skip (`skipped: true` + `floorSkip` verdict with the roster retained).
 *   - AC-5: the runtime AJV schema accepts `delivery.review.lensDiffFloor`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';

import {
  countChangedLines,
  DEFAULT_LENS_DIFF_FLOOR,
  evaluateLensDiffFloor,
  resolveLensDiffFloor,
} from '../../../.agents/scripts/lib/audit-suite/lens-diff-floor.js';
import { AGENTRC_SCHEMA } from '../../../.agents/scripts/lib/config-settings-schema.js';
import { runLocalLensReview } from '../../../.agents/scripts/lib/orchestration/story-close/phases/local-lens-review.js';

const noopProgress = () => {};

/** A sensitivePaths manifest with one deterministic class. */
function fixtureRules() {
  return {
    audits: {},
    sensitivePaths: {
      security: { filePatterns: ['**/auth/**'] },
    },
  };
}

// ---------------------------------------------------------------------------
// evaluateLensDiffFloor — the pure skip decision.
// ---------------------------------------------------------------------------

test('evaluateLensDiffFloor skips a below-floor diff with zero sensitive-path hits', () => {
  const verdict = evaluateLensDiffFloor({
    changedFiles: ['lib/util.js', 'docs/notes.md'],
    changedLineCount: 12,
    floor: 40,
    injectedRules: fixtureRules(),
  });
  assert.equal(verdict.skip, true);
  assert.equal(verdict.reason, 'below-floor');
  assert.equal(verdict.floor, 40);
  assert.equal(verdict.changedLineCount, 12);
  assert.deepEqual(verdict.sensitiveClasses, []);
});

test('evaluateLensDiffFloor never skips on a sensitive-path hit, however small the diff', () => {
  const verdict = evaluateLensDiffFloor({
    changedFiles: ['src/auth/login.js'],
    changedLineCount: 3,
    floor: 40,
    injectedRules: fixtureRules(),
  });
  assert.equal(verdict.skip, false);
  assert.equal(verdict.reason, 'sensitive-path-hit');
  assert.deepEqual(verdict.sensitiveClasses, ['security']);
});

test('evaluateLensDiffFloor fails open on an unknown line count', () => {
  for (const changedLineCount of [null, undefined, Number.NaN, -1, 'many']) {
    const verdict = evaluateLensDiffFloor({
      changedFiles: ['lib/util.js'],
      changedLineCount,
      floor: 40,
      injectedRules: fixtureRules(),
    });
    assert.equal(verdict.skip, false, `count=${String(changedLineCount)}`);
    assert.equal(verdict.reason, 'line-count-unknown');
  }
});

test('evaluateLensDiffFloor does not skip at or above the floor', () => {
  for (const changedLineCount of [40, 41, 500]) {
    const verdict = evaluateLensDiffFloor({
      changedFiles: ['lib/util.js'],
      changedLineCount,
      floor: 40,
      injectedRules: fixtureRules(),
    });
    assert.equal(verdict.skip, false);
    assert.equal(verdict.reason, 'at-or-above-floor');
  }
});

test('evaluateLensDiffFloor: floor 0 disables the skip entirely', () => {
  const verdict = evaluateLensDiffFloor({
    changedFiles: ['lib/util.js'],
    changedLineCount: 1,
    floor: 0,
    injectedRules: fixtureRules(),
  });
  assert.equal(verdict.skip, false);
  assert.equal(verdict.reason, 'floor-disabled');
});

test('evaluateLensDiffFloor fails open when the sensitive-path matcher throws', () => {
  const verdict = evaluateLensDiffFloor({
    changedFiles: ['lib/util.js'],
    changedLineCount: 5,
    floor: 40,
    selectSensitivePathClassesFn: () => {
      throw new Error('manifest unreadable');
    },
  });
  assert.equal(verdict.skip, false);
  assert.equal(verdict.reason, 'sensitive-classes-unknown');
});

// ---------------------------------------------------------------------------
// countChangedLines — the numstat totaller.
// ---------------------------------------------------------------------------

test('countChangedLines totals additions + deletions across numstat rows', () => {
  const count = countChangedLines({
    baseRef: 'main',
    headRef: 'story-1',
    gitSpawnFn: () => ({
      status: 0,
      stdout: '10\t2\tlib/a.js\n0\t5\tdocs/b.md\n-\t-\tassets/logo.png\n',
      stderr: '',
    }),
  });
  assert.equal(count, 17);
});

test('countChangedLines returns 0 for an empty diff', () => {
  const count = countChangedLines({
    baseRef: 'main',
    headRef: 'story-1',
    gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(count, 0);
});

test('countChangedLines returns null on git failure, throw, or unparseable output', () => {
  const cases = [
    () => ({ status: 128, stdout: '', stderr: 'bad ref' }),
    () => {
      throw new Error('spawn failed');
    },
    // Name-only-shaped output is NOT a trustworthy line count.
    () => ({ status: 0, stdout: 'lib/a.js\nlib/b.js\n', stderr: '' }),
  ];
  for (const gitSpawnFn of cases) {
    assert.equal(
      countChangedLines({ baseRef: 'main', headRef: 'story-1', gitSpawnFn }),
      null,
    );
  }
  assert.equal(countChangedLines({ baseRef: '', headRef: 'story-1' }), null);
});

// ---------------------------------------------------------------------------
// resolveLensDiffFloor — the config accessor.
// ---------------------------------------------------------------------------

test('resolveLensDiffFloor defaults to 40 and honours the configured value', () => {
  assert.equal(DEFAULT_LENS_DIFF_FLOOR, 40);
  assert.equal(resolveLensDiffFloor(undefined), 40);
  assert.equal(resolveLensDiffFloor({}), 40);
  assert.equal(
    resolveLensDiffFloor({ delivery: { review: { lensDiffFloor: 80 } } }),
    80,
  );
  assert.equal(
    resolveLensDiffFloor({ delivery: { review: { lensDiffFloor: 0 } } }),
    0,
  );
  // Malformed values fall back to the default.
  for (const bad of [-1, 1.5, 'forty', null]) {
    assert.equal(
      resolveLensDiffFloor({ delivery: { review: { lensDiffFloor: bad } } }),
      40,
      `bad=${String(bad)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// runLocalLensReview under the floor — no artifacts, skip recorded (AC-2).
// ---------------------------------------------------------------------------

test('a below-floor non-sensitive change set produces no lens artifacts and records a skip', async () => {
  const auditCalls = [];
  const progressLines = [];
  const out = await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4699',
    changedFiles: ['lib/util.js'],
    changedLineCount: 9,
    lensDiffFloor: 40,
    storyId: 4699,
    progress: (_tag, msg) => progressLines.push(msg),
    gitSpawnFn: () => {
      throw new Error('the lens pass must not spawn git for an injected set');
    },
    selectLocalLensesFn: () => ['audit-clean-code'],
    runAuditSuiteFn: async (args) => {
      auditCalls.push(args);
      return { metadata: {}, findings: [], workflows: [] };
    },
  });

  assert.equal(
    auditCalls.length,
    0,
    'lens materialization must be skipped below the floor',
  );
  assert.equal(out.skipped, true);
  assert.deepEqual(out.artifactPaths, [], 'no lens artifacts');
  assert.equal(out.materialized, null);
  // The skip is recorded: the matched roster is retained and the verdict
  // names the floor evidence.
  assert.deepEqual(out.lenses, ['audit-clean-code']);
  assert.equal(out.floorSkip.skip, true);
  assert.equal(out.floorSkip.reason, 'below-floor');
  assert.equal(out.floorSkip.floor, 40);
  assert.equal(out.floorSkip.changedLineCount, 9);
  assert.ok(
    progressLines.some((l) => /diff-floor/i.test(l)),
    'the skip is surfaced on the progress stream',
  );
});

test('a below-floor diff touching a sensitive path still materializes its lenses', async () => {
  const auditCalls = [];
  const out = await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4699',
    changedFiles: ['src/auth/login.js'],
    changedLineCount: 9,
    lensDiffFloor: 40,
    storyId: 4699,
    progress: noopProgress,
    selectLocalLensesFn: () => ['audit-clean-code'],
    evaluateLensDiffFloorFn: (args) =>
      evaluateLensDiffFloor({ ...args, injectedRules: fixtureRules() }),
    runAuditSuiteFn: async (args) => {
      auditCalls.push(args);
      return { metadata: {}, findings: [], workflows: [] };
    },
  });
  assert.equal(auditCalls.length, 1, 'sensitive diffs are never floor-skipped');
  assert.equal(out.skipped, false);
  assert.equal(out.floorSkip.skip, false);
  assert.equal(out.floorSkip.reason, 'sensitive-path-hit');
});

test('an unknown changed-line count materializes lenses (fail-open)', async () => {
  const auditCalls = [];
  const out = await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4699',
    changedFiles: ['lib/util.js'],
    changedLineCount: null,
    lensDiffFloor: 40,
    storyId: 4699,
    progress: noopProgress,
    selectLocalLensesFn: () => ['audit-clean-code'],
    runAuditSuiteFn: async (args) => {
      auditCalls.push(args);
      return { metadata: {}, findings: [], workflows: [] };
    },
  });
  assert.equal(auditCalls.length, 1);
  assert.equal(out.skipped, false);
  assert.equal(out.floorSkip.reason, 'line-count-unknown');
});

// ---------------------------------------------------------------------------
// AC-5 — the runtime AJV schema accepts `delivery.review.lensDiffFloor`.
// ---------------------------------------------------------------------------

test('runtime AJV schema accepts delivery.review.lensDiffFloor and rejects malformed values', () => {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(AGENTRC_SCHEMA);
  const base = {
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
  };

  assert.equal(
    validate({ ...base, delivery: { review: { lensDiffFloor: 40 } } }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate({ ...base, delivery: { review: { lensDiffFloor: 0 } } }),
    true,
    'zero (floor off) is a valid configuration',
  );
  assert.equal(
    validate({ ...base, delivery: { review: { lensDiffFloor: -1 } } }),
    false,
    'negative floors are rejected',
  );
  assert.equal(
    validate({ ...base, delivery: { review: { unknownKey: 1 } } }),
    false,
    'unknown keys under delivery.review are rejected',
  );
});
