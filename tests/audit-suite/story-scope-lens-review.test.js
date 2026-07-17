/**
 * tests/audit-suite/story-scope-lens-review.test.js — Story #4409 (Epic #4405).
 *
 * Pins the shift-left Story-scope local-lens pass: the maker-blind story-close
 * review selects the LOCAL-tier lenses whose `filePatterns` match the actual
 * Story diff (via `resolveLensTier` + the pure `matchesAnyFilePattern` matcher,
 * NOT `selectAudits`) and runs them at `light` depth, inside the story-close
 * subprocess spine (`runStoryReviewCore`) so a maker never grades its own work.
 *
 *   - `selectLocalLenses` returns only local lenses whose patterns hit the diff;
 *     a diff matching no local lens yields an empty roster (no lens work).
 *   - `runLocalLensReview` materializes the matched roster at `light` depth and
 *     is best-effort (git / materialization failure degrades to skipped).
 *   - The lens pass runs inside `runStoryReviewCore`, and BOTH close entry
 *     points (`runStoryCodeReview` epic-attached, `runStoryScopeReview`
 *     standalone) reach it through that single shared spine.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { selectLocalLenses } from '../../.agents/scripts/lib/audit-suite/index.js';
import { runStoryScopeReview } from '../../.agents/scripts/lib/orchestration/single-story-close/phases/code-review.js';
import {
  enumerateChangedFiles,
  runLocalLensReview,
  runStoryCodeReview,
  runStoryReviewCore,
  STORY_SCOPE_LENS_DEPTH,
} from '../../.agents/scripts/lib/orchestration/story-close/phases/code-review.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

const noopProgress = () => {};

/** A local-scope tier resolver for every fixture lens named `*local*`. */
function fakeTierResolver(lens) {
  if (lens.includes('cumulative')) return 'cumulative';
  if (lens.includes('global')) return 'global';
  return 'local';
}

/** Manifest fixture with one lens per tier so the tier gate is observable. */
function fixtureRules() {
  return {
    audits: {
      'lens-local-scripts': {
        triggers: { filePatterns: ['.agents/scripts/**'] },
      },
      'lens-local-empty': { triggers: { filePatterns: [] } },
      'lens-cumulative-scripts': {
        triggers: { filePatterns: ['.agents/scripts/**'] },
      },
      'lens-global-scripts': {
        triggers: { filePatterns: ['.agents/scripts/**'] },
      },
    },
  };
}

/** Records every call; returns a fixed value. */
function spy(returnValue) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return returnValue;
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// selectLocalLenses — the pure tier + pattern selector.
// ---------------------------------------------------------------------------

test('selectLocalLenses picks only local lenses whose patterns match the diff', () => {
  const selected = selectLocalLenses({
    changedFiles: ['.agents/scripts/foo.js'],
    injectedRules: fixtureRules(),
    resolveLensTierFn: fakeTierResolver,
  });
  // The cumulative and global lenses match the pattern but are excluded by the
  // tier gate; the empty-pattern local lens matches nothing.
  assert.deepEqual(selected, ['lens-local-scripts']);
});

test('selectLocalLenses returns [] when no file matches any local lens pattern', () => {
  const selected = selectLocalLenses({
    changedFiles: ['docs/unrelated.md'],
    injectedRules: fixtureRules(),
    resolveLensTierFn: fakeTierResolver,
  });
  assert.deepEqual(selected, []);
});

test('selectLocalLenses returns [] for an empty change set (adds no lens work)', () => {
  assert.deepEqual(
    selectLocalLenses({
      changedFiles: [],
      injectedRules: fixtureRules(),
      resolveLensTierFn: fakeTierResolver,
    }),
    [],
  );
  assert.deepEqual(
    selectLocalLenses({
      injectedRules: fixtureRules(),
      resolveLensTierFn: fakeTierResolver,
    }),
    [],
  );
});

test('selectLocalLenses against the REAL manifest selects local lenses only', () => {
  // `.agents/scripts/**` is the audit-performance (local) pattern; the same
  // diff must NOT drag in any cumulative/global lens.
  const selected = selectLocalLenses({
    changedFiles: ['.agents/scripts/lib/foo.js'],
  });
  assert.ok(
    selected.includes('audit-performance'),
    `expected audit-performance in ${JSON.stringify(selected)}`,
  );
  for (const cumulativeOrGlobal of [
    'audit-architecture',
    'audit-dependencies',
    'audit-devops',
    'audit-documentation',
    'audit-navigability',
    'audit-sre',
  ]) {
    assert.ok(
      !selected.includes(cumulativeOrGlobal),
      `${cumulativeOrGlobal} must not be selected at Story scope`,
    );
  }
});

test('selectLocalLenses against the REAL manifest: a docs-only diff matches only the universal clean-code lens', () => {
  // README.md matches audit-documentation (cumulative, dropped by the tier
  // gate) and the universal `audit-clean-code` (local, `**/*`). Only the
  // local lens survives the Story-scope roster.
  assert.deepEqual(selectLocalLenses({ changedFiles: ['README.md'] }), [
    'audit-clean-code',
  ]);
});

// ---------------------------------------------------------------------------
// enumerateChangedFiles — best-effort diff enumeration.
// ---------------------------------------------------------------------------

test('enumerateChangedFiles parses git diff --name-only output', () => {
  const files = enumerateChangedFiles({
    baseRef: 'epic/1',
    headRef: 'story-1',
    gitSpawnFn: () => ({ status: 0, stdout: 'a.js\n b.js \n\n', stderr: '' }),
  });
  assert.deepEqual(files, ['a.js', 'b.js']);
});

test('enumerateChangedFiles returns [] on a git failure (best-effort)', () => {
  assert.deepEqual(
    enumerateChangedFiles({
      baseRef: 'epic/1',
      headRef: 'story-1',
      gitSpawnFn: () => ({ status: 128, stdout: '', stderr: 'bad ref' }),
    }),
    [],
  );
  assert.deepEqual(
    enumerateChangedFiles({
      baseRef: 'epic/1',
      headRef: 'story-1',
      gitSpawnFn: () => {
        throw new Error('spawn failed');
      },
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// runLocalLensReview — the pass that materializes matched local lenses.
// ---------------------------------------------------------------------------

test('runLocalLensReview runs matched local lenses at light depth', async () => {
  const runAuditSuiteFn = spy({ metadata: {}, findings: [], workflows: [] });
  const out = await runLocalLensReview({
    baseRef: 'epic/100',
    headRef: 'story-4409',
    progress: noopProgress,
    gitSpawnFn: () => ({
      status: 0,
      stdout: '.agents/scripts/x.js',
      stderr: '',
    }),
    selectLocalLensesFn: () => ['audit-performance', 'audit-quality'],
    runAuditSuiteFn,
  });
  assert.equal(out.depth, STORY_SCOPE_LENS_DEPTH);
  assert.equal(STORY_SCOPE_LENS_DEPTH, 'light');
  assert.deepEqual(out.lenses, ['audit-performance', 'audit-quality']);
  assert.equal(out.skipped, false);
  assert.equal(runAuditSuiteFn.calls.length, 1);
  assert.deepEqual(runAuditSuiteFn.calls[0].auditWorkflows, [
    'audit-performance',
    'audit-quality',
  ]);
});

test('runLocalLensReview adds no lens work when the diff matches no local lens', async () => {
  const runAuditSuiteFn = spy({ metadata: {}, findings: [], workflows: [] });
  const out = await runLocalLensReview({
    baseRef: 'epic/100',
    headRef: 'story-4409',
    progress: noopProgress,
    gitSpawnFn: () => ({ status: 0, stdout: 'README.md', stderr: '' }),
    selectLocalLensesFn: () => [],
    runAuditSuiteFn,
  });
  assert.deepEqual(out.lenses, []);
  assert.equal(out.skipped, true);
  assert.equal(out.depth, 'light');
  assert.equal(
    runAuditSuiteFn.calls.length,
    0,
    'runAuditSuite must not run when no local lens matched',
  );
});

test('runLocalLensReview is best-effort: a materialization throw degrades to skipped', async () => {
  const out = await runLocalLensReview({
    baseRef: 'epic/100',
    headRef: 'story-4409',
    progress: noopProgress,
    gitSpawnFn: () => ({
      status: 0,
      stdout: '.agents/scripts/x.js',
      stderr: '',
    }),
    selectLocalLensesFn: () => ['audit-performance'],
    runAuditSuiteFn: async () => {
      throw new Error('materialization boom');
    },
  });
  assert.equal(out.skipped, true);
  assert.deepEqual(out.lenses, []);
});

// ---------------------------------------------------------------------------
// The shared spine + both close entry points reach the lens pass.
// ---------------------------------------------------------------------------

/** A `runCodeReview` stub returning a clean (non-halting) review envelope. */
function cleanReviewStub() {
  return async () => ({
    status: 'ok',
    severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
    posted: false,
    postedCommentId: null,
    halted: false,
    blockerReason: null,
  });
}

test('runStoryReviewCore invokes the lens pass and attaches localLensReview', async () => {
  const lensReview = {
    depth: 'light',
    lenses: ['audit-quality'],
    skipped: false,
  };
  const lensSpy = spy(lensReview);
  const result = await runStoryReviewCore({
    storyId: 4409,
    baseRef: 'epic/4405',
    headRef: 'story-4409',
    provider: {},
    progress: noopProgress,
    runCodeReviewFn: cleanReviewStub(),
    runLocalLensReviewFn: lensSpy,
  });
  assert.equal(lensSpy.calls.length, 1);
  assert.equal(lensSpy.calls[0].baseRef, 'epic/4405');
  assert.equal(lensSpy.calls[0].headRef, 'story-4409');
  assert.deepEqual(result.localLensReview, lensReview);
});

test('epic-attached close (runStoryCodeReview) reaches the lens pass through the spine', async () => {
  const lensReview = {
    depth: 'light',
    lenses: ['audit-security'],
    skipped: false,
  };
  const lensSpy = spy(lensReview);
  const out = await runStoryCodeReview({
    storyId: 4409,
    baseBranch: 'epic/4405',
    storyBranch: 'story-4409',
    provider: {},
    bus: { emit: async () => {} },
    progress: noopProgress,
    runCodeReviewFn: cleanReviewStub(),
    runLocalLensReviewFn: lensSpy,
  });
  assert.equal(out.blocked, null);
  assert.equal(lensSpy.calls.length, 1);
  assert.equal(lensSpy.calls[0].baseRef, 'epic/4405');
  assert.equal(lensSpy.calls[0].headRef, 'story-4409');
  assert.deepEqual(out.localLensReview, lensReview);
});

test('standalone close (runStoryScopeReview) reaches the lens pass through the spine', async () => {
  const lensReview = {
    depth: 'light',
    lenses: ['audit-privacy'],
    skipped: false,
  };
  const lensSpy = spy(lensReview);
  const out = await runStoryScopeReview({
    cwd: '/repo',
    storyId: 4409,
    storyBranch: 'story-4409',
    baseBranch: 'main',
    prUrl: 'https://github.com/o/r/pull/7',
    prNumber: 7,
    provider: {},
    runCodeReviewFn: cleanReviewStub(),
    runLocalLensReviewFn: lensSpy,
    progress: noopProgress,
  });
  assert.equal(out.halted, false);
  assert.equal(lensSpy.calls.length, 1);
  // Standalone path diffs the Story branch against the base branch (`main`).
  assert.equal(lensSpy.calls[0].baseRef, 'main');
  assert.equal(lensSpy.calls[0].headRef, 'story-4409');
  assert.deepEqual(out.localLensReview, lensReview);
});
