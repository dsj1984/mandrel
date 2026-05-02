import assert from 'node:assert/strict';
import test from 'node:test';

import { runEpicCodeReview } from '../.agents/scripts/epic-code-review.js';

/**
 * Unit tests for the extracted `runEpicCodeReview` runner. Drives the
 * runner directly with stubbed `gitSpawn`, evidence store, lint runner,
 * provider factory, and `upsertStructuredComment` so tests cover the
 * orchestration logic without touching git / disk / GitHub.
 *
 * Companion to tests/epic-code-review.test.js (which covers the pure
 * helpers — `parseLintOutput`, `buildSeverity`, `buildReviewReport`, etc.).
 */

function makeLogger() {
  const calls = { info: [], warn: [], error: [], fatal: [], progress: [] };
  return {
    calls,
    info: (m) => calls.info.push(m),
    warn: (m) => calls.warn.push(m),
    error: (m) => calls.error.push(m),
    fatal: (m) => calls.fatal.push(m),
    createProgress: () => (label, msg) => calls.progress.push({ label, msg }),
  };
}

function fakeDiff(stdout, status = 0) {
  return (_cwd, sub) => {
    if (sub === 'diff') return { status, stdout, stderr: '' };
    if (sub === 'rev-parse')
      return {
        status: 0,
        stdout: 'abcdef0123456789abcdef0123456789abcdef01\n',
        stderr: '',
      };
    return { status: 0, stdout: '', stderr: '' };
  };
}

function baseArgs(overrides = {}) {
  return {
    epicId: 42,
    baseBranch: 'main',
    post: false,
    scopeLint: 'changed-only',
    storyId: null,
    useEvidence: true,
    ...overrides,
  };
}

test('runEpicCodeReview: missing epicId yields invalid + fatal', async () => {
  const logger = makeLogger();
  const out = await runEpicCodeReview(baseArgs({ epicId: null }), {
    logger,
    resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
    gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(out.status, 'invalid');
  assert.equal(logger.calls.fatal.length, 1);
});

test('runEpicCodeReview: empty diff returns no-changes (no lint, no post)', async () => {
  const logger = makeLogger();
  const lintCalls = [];
  const upsertCalls = [];

  const out = await runEpicCodeReview(baseArgs({ post: true }), {
    logger,
    resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
    gitSpawnFn: fakeDiff(''),
    runScopedLintFn: (...a) => {
      lintCalls.push(a);
      return { errors: 0, warnings: 0, skipped: true, mode: 'changed-only' };
    },
    analyzeChangedFilesFn: () => ({
      totalFiles: 0,
      jsFiles: 0,
      maintainability: [],
      criticalIssues: [],
      warningIssues: [],
    }),
    upsertCommentFn: async (...a) => {
      upsertCalls.push(a);
    },
    providerFactory: () => ({}),
  });

  assert.equal(out.status, 'no-changes');
  assert.equal(
    lintCalls.length,
    0,
    'lint runner must not run when diff is empty',
  );
  assert.equal(
    upsertCalls.length,
    0,
    'upsertStructuredComment must not run when diff is empty',
  );
});

test('runEpicCodeReview: --scope-lint=off skips lint runner but still builds report', async () => {
  const logger = makeLogger();
  const lintCalls = [];
  let printed = null;

  const out = await runEpicCodeReview(
    baseArgs({ scopeLint: 'off', post: false }),
    {
      logger,
      resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
      gitSpawnFn: fakeDiff('a.js\nb.js\n'),
      runScopedLintFn: (...a) => {
        lintCalls.push(a);
        return { errors: 0, warnings: 0 };
      },
      analyzeChangedFilesFn: () => ({
        totalFiles: 2,
        jsFiles: 2,
        maintainability: [],
        criticalIssues: [],
        warningIssues: [],
      }),
      print: (s) => {
        printed = s;
      },
    },
  );

  assert.equal(out.status, 'ok');
  assert.equal(out.posted, false);
  assert.equal(
    lintCalls.length,
    0,
    'runScopedLint must be bypassed when scopeLint=off',
  );
  assert.match(printed, /Lint Skipped/);
  assert.match(printed, /scope-lint=off/);
});

test('runEpicCodeReview: storyId + evidence-skip verdict bypasses lint runner', async () => {
  const logger = makeLogger();
  const lintCalls = [];
  const recordCalls = [];

  const out = await runEpicCodeReview(
    baseArgs({ storyId: 901, useEvidence: true }),
    {
      logger,
      resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
      gitSpawnFn: fakeDiff('src/x.js\n'),
      runScopedLintFn: (...a) => {
        lintCalls.push(a);
        return { errors: 0, warnings: 0 };
      },
      shouldSkipFn: () => ({
        skip: true,
        record: { timestamp: '2026-05-02T11:00:00Z' },
      }),
      recordPassFn: (...a) => {
        recordCalls.push(a);
      },
      analyzeChangedFilesFn: () => ({
        totalFiles: 1,
        jsFiles: 1,
        maintainability: [],
        criticalIssues: [],
        warningIssues: [],
      }),
      print: () => {},
    },
  );

  assert.equal(out.status, 'ok');
  assert.equal(
    lintCalls.length,
    0,
    'runScopedLint must be skipped when shouldSkip returns skip:true',
  );
  assert.equal(
    recordCalls.length,
    0,
    'recordPass must not fire when the lint was already skipped',
  );
});

test('runEpicCodeReview: clean lint with --story records evidence', async () => {
  const logger = makeLogger();
  const recordCalls = [];

  const out = await runEpicCodeReview(
    baseArgs({ storyId: 901, useEvidence: true }),
    {
      logger,
      resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
      gitSpawnFn: fakeDiff('src/x.js\n'),
      runScopedLintFn: () => ({
        errors: 0,
        warnings: 0,
        skipped: false,
        mode: 'changed-only',
      }),
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: (rec) => {
        recordCalls.push(rec);
      },
      analyzeChangedFilesFn: () => ({
        totalFiles: 1,
        jsFiles: 1,
        maintainability: [],
        criticalIssues: [],
        warningIssues: [],
      }),
      print: () => {},
    },
  );

  assert.equal(out.status, 'ok');
  assert.equal(recordCalls.length, 1);
  assert.equal(recordCalls[0].storyId, 901);
  assert.equal(recordCalls[0].gateName, 'epic-code-review/lint');
  assert.equal(recordCalls[0].exitCode, 0);
});

test('runEpicCodeReview: lint with errors does NOT record evidence', async () => {
  const logger = makeLogger();
  const recordCalls = [];

  await runEpicCodeReview(baseArgs({ storyId: 901, useEvidence: true }), {
    logger,
    resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
    gitSpawnFn: fakeDiff('src/x.js\n'),
    runScopedLintFn: () => ({
      errors: 3,
      warnings: 1,
      skipped: false,
      mode: 'changed-only',
    }),
    shouldSkipFn: () => ({ skip: false }),
    recordPassFn: (rec) => {
      recordCalls.push(rec);
    },
    analyzeChangedFilesFn: () => ({
      totalFiles: 1,
      jsFiles: 1,
      maintainability: [],
      criticalIssues: [],
      warningIssues: [],
    }),
    print: () => {},
  });

  assert.equal(
    recordCalls.length,
    0,
    'recordPass must not fire when lint has errors',
  );
});

test('runEpicCodeReview: --no-evidence path skips both shouldSkip and recordPass', async () => {
  const logger = makeLogger();
  const shouldSkipCalls = [];
  const recordCalls = [];

  await runEpicCodeReview(baseArgs({ storyId: 901, useEvidence: false }), {
    logger,
    resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
    gitSpawnFn: fakeDiff('src/x.js\n'),
    runScopedLintFn: () => ({
      errors: 0,
      warnings: 0,
      skipped: false,
      mode: 'changed-only',
    }),
    shouldSkipFn: (...a) => {
      shouldSkipCalls.push(a);
      return { skip: false };
    },
    recordPassFn: (...a) => {
      recordCalls.push(a);
    },
    analyzeChangedFilesFn: () => ({
      totalFiles: 1,
      jsFiles: 1,
      maintainability: [],
      criticalIssues: [],
      warningIssues: [],
    }),
    print: () => {},
  });

  assert.equal(shouldSkipCalls.length, 0);
  assert.equal(recordCalls.length, 0);
});

test('runEpicCodeReview: post=true upserts structured comment on the Epic', async () => {
  const logger = makeLogger();
  const upsertCalls = [];

  const out = await runEpicCodeReview(baseArgs({ epicId: 42, post: true }), {
    logger,
    resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
    gitSpawnFn: fakeDiff('a.js\n'),
    runScopedLintFn: () => ({
      errors: 0,
      warnings: 0,
      skipped: false,
      mode: 'changed-only',
    }),
    shouldSkipFn: () => ({ skip: false }),
    recordPassFn: () => {},
    analyzeChangedFilesFn: () => ({
      totalFiles: 1,
      jsFiles: 1,
      maintainability: [],
      criticalIssues: [],
      warningIssues: [],
    }),
    providerFactory: () => ({ kind: 'fake-provider' }),
    upsertCommentFn: async (provider, ticketId, kind, body) => {
      upsertCalls.push({ provider, ticketId, kind, bodyLen: body.length });
    },
    print: () => {},
  });

  assert.equal(out.status, 'ok');
  assert.equal(out.posted, true);
  assert.equal(upsertCalls.length, 1);
  assert.deepEqual(upsertCalls[0].provider, { kind: 'fake-provider' });
  assert.equal(upsertCalls[0].ticketId, 42);
  assert.equal(upsertCalls[0].kind, 'code-review');
  assert.ok(upsertCalls[0].bodyLen > 0);
});

test('runEpicCodeReview: post=false does NOT upsert', async () => {
  const upsertCalls = [];
  await runEpicCodeReview(baseArgs({ post: false }), {
    logger: makeLogger(),
    resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
    gitSpawnFn: fakeDiff('a.js\n'),
    runScopedLintFn: () => ({ errors: 0, warnings: 0, skipped: true }),
    analyzeChangedFilesFn: () => ({
      totalFiles: 1,
      jsFiles: 1,
      maintainability: [],
      criticalIssues: [],
      warningIssues: [],
    }),
    providerFactory: () => {
      throw new Error('providerFactory must not be called when post=false');
    },
    upsertCommentFn: async (...a) => {
      upsertCalls.push(a);
    },
    print: () => {},
  });
  assert.equal(upsertCalls.length, 0);
});

test('runEpicCodeReview: failed git diff yields invalid + fatal', async () => {
  const logger = makeLogger();
  const out = await runEpicCodeReview(baseArgs(), {
    logger,
    resolveConfigFn: () => ({ settings: {}, orchestration: {} }),
    gitSpawnFn: () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: bad ref',
    }),
    print: () => {},
  });
  assert.equal(out.status, 'invalid');
  assert.equal(logger.calls.fatal.length, 1);
  assert.match(logger.calls.fatal[0], /Failed to get diff/);
});

test('runEpicCodeReview: settings.baseBranch wins over default when args.baseBranch is null', async () => {
  const logger = makeLogger();
  const captured = [];
  await runEpicCodeReview(baseArgs({ baseBranch: null }), {
    logger,
    resolveConfigFn: () => ({
      settings: { baseBranch: 'develop' },
      orchestration: {},
    }),
    gitSpawnFn: (_cwd, sub, ref) => {
      if (sub === 'diff') captured.push(ref);
      return { status: 0, stdout: '', stderr: '' };
    },
    runScopedLintFn: () => ({ errors: 0, warnings: 0 }),
    analyzeChangedFilesFn: () => ({
      totalFiles: 0,
      jsFiles: 0,
      maintainability: [],
      criticalIssues: [],
      warningIssues: [],
    }),
    print: () => {},
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0], 'develop...epic/42');
});
