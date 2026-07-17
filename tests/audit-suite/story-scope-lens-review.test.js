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
import test from 'node:test';

import { selectLocalLenses } from '../../.agents/scripts/lib/audit-suite/index.js';
import { runStoryScopeReview } from '../../.agents/scripts/lib/orchestration/single-story-close/phases/code-review.js';
import { runStoryCodeReview } from '../../.agents/scripts/lib/orchestration/story-close/phases/code-review.js';
import { runLocalLensReview } from '../../.agents/scripts/lib/orchestration/story-close/phases/local-lens-review.js';
import { runStoryReviewCore } from '../../.agents/scripts/lib/orchestration/story-close/phases/review-core.js';

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
// Self-enumeration fallback — exercised through the public runLocalLensReview.
//
// `enumerateChangedFiles` is a module-local detail (Story #4603): rather than
// import it directly (a production-dead public export), these cases drive it
// through the public entry point with `changedFiles` absent, and observe what
// the (spied) lens selector received.
// ---------------------------------------------------------------------------

test('self-enumeration parses git diff --name-only output into the lens roster', async () => {
  const selectCalls = [];
  await runLocalLensReview({
    baseRef: 'epic/1',
    headRef: 'story-1',
    // changedFiles absent → self-enumerate.
    progress: noopProgress,
    gitSpawnFn: () => ({ status: 0, stdout: 'a.js\n b.js \n\n', stderr: '' }),
    selectLocalLensesFn: (args) => {
      selectCalls.push(args);
      return [];
    },
    runAuditSuiteFn: spy({ metadata: {}, findings: [], workflows: [] }),
  });
  assert.deepEqual(selectCalls[0].changedFiles, ['a.js', 'b.js']);
});

test('self-enumeration degrades to [] on a git failure (best-effort)', async () => {
  for (const gitSpawnFn of [
    () => ({ status: 128, stdout: '', stderr: 'bad ref' }),
    () => {
      throw new Error('spawn failed');
    },
  ]) {
    const selectCalls = [];
    const out = await runLocalLensReview({
      baseRef: 'epic/1',
      headRef: 'story-1',
      progress: noopProgress,
      gitSpawnFn,
      selectLocalLensesFn: (args) => {
        selectCalls.push(args);
        return [];
      },
      runAuditSuiteFn: spy({ metadata: {}, findings: [], workflows: [] }),
    });
    assert.deepEqual(selectCalls[0].changedFiles, []);
    assert.equal(out.skipped, true);
  }
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
  assert.equal(out.depth, 'light');
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

// ---------------------------------------------------------------------------
// The change set is computed ONCE per close run and injected (Story #4593).
// ---------------------------------------------------------------------------

test('runStoryReviewCore enumerates the diff exactly once and injects it into both consumers', async () => {
  // One gitSpawn spy threaded into every seam that could enumerate: the spine's
  // own computeChangeSet, the lens pass, and runCodeReview. If either consumer
  // ever re-derived the diff for itself, this count would climb.
  const diffCalls = [];
  const gitSpawnFn = (cwd, ...args) => {
    if (args[0] === 'diff') diffCalls.push(args);
    return { status: 0, stdout: 'b.js\n.agents/scripts/a.js\n', stderr: '' };
  };

  const lensCalls = [];
  const reviewCalls = [];
  const result = await runStoryReviewCore({
    storyId: 4593,
    baseRef: 'main',
    headRef: 'story-4593',
    provider: {},
    progress: noopProgress,
    gitSpawnFn,
    runLocalLensReviewFn: async (args) => {
      lensCalls.push(args);
      return { depth: 'light', lenses: [], skipped: true, materialized: null };
    },
    runCodeReviewFn: async (opts) => {
      reviewCalls.push(opts);
      return {
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        posted: false,
        postedCommentId: null,
        halted: false,
        blockerReason: null,
      };
    },
  });

  assert.equal(
    diffCalls.length,
    1,
    `the diff must be enumerated exactly once per close run, got ${diffCalls.length}`,
  );
  assert.deepEqual(diffCalls[0], ['diff', '--name-only', 'main...story-4593']);

  // Both consumers received the SAME (sorted, de-duplicated) list.
  const expected = ['.agents/scripts/a.js', 'b.js'];
  assert.deepEqual(lensCalls[0].changedFiles, expected);
  assert.deepEqual(reviewCalls[0].changedFiles, expected);
  assert.deepEqual(result.changeSet.files, expected);
  assert.equal(result.changeSet.baseRef, 'main');
  assert.equal(result.changeSet.headRef, 'story-4593');
});

test('runStoryReviewCore injects an explicit null when the diff is unenumerable', async () => {
  // The fail-safe signal must reach both consumers as "unknown", not as a
  // deceptively-empty list, and must not trigger a retry enumeration.
  //
  // Story #4603 — this case previously passed a STUBBED `runLocalLensReviewFn`,
  // so the real collaborator's null branch never ran and the suite reported the
  // single-enumeration invariant as held while production re-spawned git on this
  // exact path. The spy below DELEGATES to the real `runLocalLensReview` so the
  // production null branch is what executes; `diffCalls` therefore counts the
  // spine's enumeration plus any retry the lens pass performs.
  const diffCalls = [];
  const lensCalls = [];
  const reviewCalls = [];
  await runStoryReviewCore({
    storyId: 4593,
    baseRef: 'main',
    headRef: 'story-4593',
    provider: {},
    progress: noopProgress,
    gitSpawnFn: (_cwd, ...args) => {
      if (args[0] === 'diff') diffCalls.push(args);
      return { status: 128, stdout: '', stderr: 'bad ref' };
    },
    runLocalLensReviewFn: async (args) => {
      lensCalls.push(args);
      return runLocalLensReview(args);
    },
    runCodeReviewFn: async (opts) => {
      reviewCalls.push(opts);
      return {
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        posted: false,
        postedCommentId: null,
        halted: false,
        blockerReason: null,
      };
    },
  });
  assert.equal(
    diffCalls.length,
    1,
    `an unenumerable diff must be enumerated ONCE — the real lens pass must not ` +
      `retry git on the null branch, got ${diffCalls.length} enumeration(s)`,
  );
  assert.equal(lensCalls[0].changedFiles, null);
  assert.equal(reviewCalls[0].changedFiles, null);
});

// ---------------------------------------------------------------------------
// The three-state changedFiles contract (Story #4603), asserted through the
// public runLocalLensReview. The discriminating logic lives in the module-local
// `resolveLensChangeSet`; these cases pin its three states by their observable
// effect — what the lens selector received, and whether git was re-spawned.
// ---------------------------------------------------------------------------

test('changedFiles contract: null degrades, undefined self-enumerates, array is verbatim', async () => {
  const run = async (changedFiles) => {
    let enumerated = 0;
    const selectCalls = [];
    await runLocalLensReview({
      baseRef: 'main',
      headRef: 'story-4603',
      ...(changedFiles === undefined ? {} : { changedFiles }),
      progress: noopProgress,
      gitSpawnFn: () => {
        enumerated += 1;
        return {
          status: 0,
          stdout: '.agents/scripts/enumerated.js',
          stderr: '',
        };
      },
      selectLocalLensesFn: (args) => {
        selectCalls.push(args);
        return [];
      },
      runAuditSuiteFn: spy({ metadata: {}, findings: [], workflows: [] }),
    });
    return { enumerated, received: selectCalls[0].changedFiles };
  };

  // An explicit null means "already tried, unenumerable" — degrade, never retry.
  const nullCase = await run(null);
  assert.equal(
    nullCase.enumerated,
    0,
    'an injected null must NOT re-spawn git',
  );
  assert.deepEqual(nullCase.received, []);

  // Absent means nobody enumerated — the self-enumeration fallback runs.
  const undefinedCase = await run(undefined);
  assert.equal(
    undefinedCase.enumerated,
    1,
    'an absent list MUST self-enumerate',
  );
  assert.deepEqual(undefinedCase.received, ['.agents/scripts/enumerated.js']);

  // An array is used verbatim.
  const arrayCase = await run(['a.js']);
  assert.equal(
    arrayCase.enumerated,
    0,
    'an injected array must not re-spawn git',
  );
  assert.deepEqual(arrayCase.received, ['a.js']);
});

test('runLocalLensReview degrades on an injected null without re-enumerating', async () => {
  // The real collaborator, driven directly: an explicit null is the spine
  // reporting an unenumerable diff. Re-running git here would only fail again.
  let enumerated = false;
  const selectCalls = [];
  const runAuditSuiteFn = spy({ metadata: {}, findings: [], workflows: [] });
  const out = await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4603',
    changedFiles: null,
    progress: noopProgress,
    gitSpawnFn: () => {
      enumerated = true;
      return { status: 0, stdout: '.agents/scripts/retry.js', stderr: '' };
    },
    selectLocalLensesFn: (args) => {
      selectCalls.push(args);
      return [];
    },
    runAuditSuiteFn,
  });
  assert.equal(enumerated, false, 'an injected null must NOT re-spawn git');
  assert.deepEqual(selectCalls[0].changedFiles, []);
  assert.deepEqual(out.lenses, []);
  assert.equal(out.skipped, true);
  assert.equal(runAuditSuiteFn.calls.length, 0);
});

test('runLocalLensReview selects from the injected change set without enumerating', async () => {
  let enumerated = false;
  const selectCalls = [];
  const out = await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4593',
    changedFiles: ['.agents/scripts/injected.js'],
    progress: noopProgress,
    gitSpawnFn: () => {
      enumerated = true;
      return { status: 0, stdout: 'some/other/file.js', stderr: '' };
    },
    selectLocalLensesFn: (args) => {
      selectCalls.push(args);
      return ['audit-performance'];
    },
    runAuditSuiteFn: spy({ metadata: {}, findings: [], workflows: [] }),
  });
  assert.equal(enumerated, false, 'an injected list must short-circuit git');
  assert.deepEqual(selectCalls[0].changedFiles, [
    '.agents/scripts/injected.js',
  ]);
  assert.deepEqual(out.lenses, ['audit-performance']);
});

test('runLocalLensReview falls back to self-enumeration only when no list is injected', async () => {
  let enumerated = false;
  const selectCalls = [];
  await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4593',
    progress: noopProgress,
    gitSpawnFn: () => {
      enumerated = true;
      return { status: 0, stdout: '.agents/scripts/enumerated.js', stderr: '' };
    },
    selectLocalLensesFn: (args) => {
      selectCalls.push(args);
      return [];
    },
    runAuditSuiteFn: spy({ metadata: {}, findings: [], workflows: [] }),
  });
  assert.equal(enumerated, true, 'no injected list → the CLI fallback runs');
  assert.deepEqual(selectCalls[0].changedFiles, [
    '.agents/scripts/enumerated.js',
  ]);
});

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
