import assert from 'node:assert';
import { test } from 'node:test';
import {
  applyBaselineRefreshLabel,
  applyLabelIfNeeded,
  BASELINE_REFRESH_LABEL,
  classifyChangedFiles,
  emitVerdictMessages,
  evaluateGuardrail,
  findRefreshCommits,
  listChangedFiles,
  parseBaseBranchConfig,
  parseCliArgs,
  parseCommitLog,
  performCrapRecheck,
} from '../.agents/scripts/baseline-refresh-guardrail.js';
import { __setGitRunners } from '../.agents/scripts/lib/git-utils.js';

/**
 * Fixture tests for the baseline-refresh-guardrail CI job. Each scenario
 * corresponds to an acceptance criterion on Story #610 / Task #630:
 *
 *   1. PR that raises newMethodCeiling but is held to base-branch ceiling —
 *      covered by the env-override tests in check-crap-env-overrides.test.js
 *      (the guardrail wires those env vars through `runCheckCrapWithBaseConfig`).
 *   2. Untagged baseline-refresh commit fails with message naming the tag.
 *   3. Tagged refresh passes.
 *   4. Baseline-only PR gets the review label exactly once across re-runs.
 *
 * The pure helpers (evaluate/classify/find/parse) are unit-tested with
 * fixtures; the label-application path is tested via an injected `runner`
 * stub to keep the suite hermetic — no real `gh` calls.
 */

const BASE_CONFIG = Object.freeze({
  newMethodCeiling: 30,
  tolerance: 0.001,
  refreshTag: 'baseline-refresh:',
});

function makeCommit(subject, body = '') {
  return { sha: 'a'.repeat(40), subject, body };
}

test('parseCommitLog — round-trips multi-commit log with bodies', () => {
  const raw = [
    'abc123',
    'feat: foo',
    'body line 1',
    'body line 2',
    '----END-COMMIT----',
    'def456',
    'baseline-refresh: bump',
    'justification goes here',
    '----END-COMMIT----',
  ].join('\n');
  const commits = parseCommitLog(raw);
  assert.strictEqual(commits.length, 2);
  assert.strictEqual(commits[0].subject, 'feat: foo');
  assert.strictEqual(commits[0].body, 'body line 1\nbody line 2');
  assert.strictEqual(commits[1].subject, 'baseline-refresh: bump');
  assert.strictEqual(commits[1].body, 'justification goes here');
});

test('parseCommitLog — empty input returns []', () => {
  assert.deepStrictEqual(parseCommitLog(''), []);
  assert.deepStrictEqual(parseCommitLog('   '), []);
});

test('parseBaseBranchConfig — reads crap block from well-formed json', () => {
  const json = JSON.stringify({
    agentSettings: {
      quality: {
        crap: {
          enabled: true,
          newMethodCeiling: 25,
          tolerance: 0.005,
          refreshTag: 'refresh:',
        },
      },
    },
  });
  const parsed = parseBaseBranchConfig(json);
  assert.deepStrictEqual(parsed, {
    newMethodCeiling: 25,
    tolerance: 0.005,
    refreshTag: 'refresh:',
    enabled: true,
  });
});

test('parseBaseBranchConfig — malformed json falls back to defaults', () => {
  const parsed = parseBaseBranchConfig('not json {');
  assert.strictEqual(parsed.newMethodCeiling, 30);
  // Default tolerance bumped 0.001 → 0.05 in 5.36.1.
  assert.strictEqual(parsed.tolerance, 0.05);
  assert.strictEqual(parsed.refreshTag, 'baseline-refresh:');
  assert.strictEqual(parsed.enabled, true);
});

test('parseBaseBranchConfig — missing crap block falls back to defaults', () => {
  const parsed = parseBaseBranchConfig(JSON.stringify({ agentSettings: {} }));
  assert.strictEqual(parsed.newMethodCeiling, 30);
  assert.strictEqual(parsed.refreshTag, 'baseline-refresh:');
});

test('parseBaseBranchConfig — respects enabled: false on base branch', () => {
  const parsed = parseBaseBranchConfig(
    JSON.stringify({
      agentSettings: {
        quality: { crap: { enabled: false } },
      },
    }),
  );
  assert.strictEqual(parsed.enabled, false);
});

test('classifyChangedFiles — detects baseline-only diff', () => {
  const c = classifyChangedFiles(['baselines/crap.json']);
  assert.strictEqual(c.hasBaselineEdits, true);
  assert.strictEqual(c.baselineOnly, true);
});

test('classifyChangedFiles — detects mixed baseline + source diff', () => {
  const c = classifyChangedFiles([
    'baselines/crap.json',
    '.agents/scripts/foo.js',
  ]);
  assert.strictEqual(c.hasBaselineEdits, true);
  assert.strictEqual(c.baselineOnly, false);
  assert.deepStrictEqual(c.changedBaselineFiles, ['baselines/crap.json']);
  assert.deepStrictEqual(c.changedOther, ['.agents/scripts/foo.js']);
});

test('classifyChangedFiles — non-baseline diff is pass-through', () => {
  const c = classifyChangedFiles(['.agents/scripts/foo.js']);
  assert.strictEqual(c.hasBaselineEdits, false);
  assert.strictEqual(c.baselineOnly, false);
});

test('findRefreshCommits — requires both tag prefix AND non-empty body', () => {
  const commits = [
    makeCommit('feat: bar', 'some body'),
    makeCommit('baseline-refresh: bump', ''), // tag, no body → rejected
    makeCommit('baseline-refresh: justified', 'we refactored X'), // accepted
    makeCommit('baseline-refresh:other', 'body'), // accepted (starts-with is loose)
  ];
  const matches = findRefreshCommits(commits, 'baseline-refresh:');
  assert.strictEqual(matches.length, 2);
  assert.ok(matches.every((c) => c.subject.startsWith('baseline-refresh:')));
  assert.ok(matches.every((c) => c.body.length > 0));
});

test('findRefreshCommits — empty/invalid inputs return []', () => {
  assert.deepStrictEqual(findRefreshCommits(null, 'x:'), []);
  assert.deepStrictEqual(findRefreshCommits([], 'x:'), []);
  assert.deepStrictEqual(
    findRefreshCommits([makeCommit('x: foo', 'b')], ''),
    [],
  );
});

test('evaluateGuardrail — scenario: no baseline edits → pass, no label', () => {
  const verdict = evaluateGuardrail({
    changedFiles: ['.agents/scripts/foo.js', 'docs/CHANGELOG.md'],
    commits: [makeCommit('feat: change X', 'body')],
    refreshTag: BASE_CONFIG.refreshTag,
  });
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.exitCode, 0);
  assert.strictEqual(verdict.shouldApplyBaselineLabel, false);
  assert.ok(verdict.messages.some((m) => m.includes('no baseline files')));
});

test('evaluateGuardrail — scenario: baseline edited, UNTAGGED commits → fail with tag in message', () => {
  const verdict = evaluateGuardrail({
    changedFiles: ['baselines/crap.json', '.agents/scripts/foo.js'],
    commits: [
      makeCommit('feat: refactor', 'body'),
      makeCommit('chore: bump', 'body'),
    ],
    refreshTag: 'baseline-refresh:',
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.exitCode, 1);
  const combined = verdict.messages.join('\n');
  assert.ok(
    combined.includes('baseline-refresh:'),
    'failure message must name the required refreshTag',
  );
  assert.ok(combined.includes('baselines/crap.json'));
  assert.strictEqual(verdict.shouldApplyBaselineLabel, false);
});

test('evaluateGuardrail — scenario: tagged refresh commit WITH body → passes', () => {
  const verdict = evaluateGuardrail({
    changedFiles: ['baselines/crap.json'],
    commits: [
      makeCommit(
        'baseline-refresh: bump after escomplex 7.4',
        'Rescored after upstream formula change; no real regression.',
      ),
    ],
    refreshTag: 'baseline-refresh:',
  });
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.exitCode, 0);
  assert.strictEqual(verdict.shouldApplyBaselineLabel, true); // baseline-only
  assert.ok(verdict.refreshCommits.length === 1);
});

test('evaluateGuardrail — scenario: tagged commit WITHOUT body → rejected, tag-in-message', () => {
  const verdict = evaluateGuardrail({
    changedFiles: ['baselines/crap.json'],
    commits: [makeCommit('baseline-refresh: bump', '')],
    refreshTag: 'baseline-refresh:',
  });
  assert.strictEqual(verdict.ok, false);
  assert.ok(
    verdict.messages.some((m) => m.includes('non-empty body')),
    'failure message must explain the non-empty-body requirement',
  );
});

test('evaluateGuardrail — scenario: custom refreshTag from base branch overrides default', () => {
  const verdict = evaluateGuardrail({
    changedFiles: ['baselines/crap.json'],
    commits: [makeCommit('chore(refresh): bump', 'justification')],
    refreshTag: 'chore(refresh):',
  });
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.refreshCommits.length, 1);
});

test('evaluateGuardrail — scenario: baseline-only PR → shouldApplyBaselineLabel=true', () => {
  const verdict = evaluateGuardrail({
    changedFiles: ['baselines/crap.json', 'baselines/maintainability.json'],
    commits: [
      makeCommit('baseline-refresh: refresh both', 'dual refresh justified'),
    ],
    refreshTag: 'baseline-refresh:',
  });
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.shouldApplyBaselineLabel, true);
});

test('evaluateGuardrail — scenario: mixed PR (baseline + source) → no label even when passing', () => {
  const verdict = evaluateGuardrail({
    changedFiles: ['baselines/crap.json', '.agents/scripts/foo.js'],
    commits: [
      makeCommit('baseline-refresh: bump', 'justified'),
      makeCommit('feat: new behavior', 'body'),
    ],
    refreshTag: 'baseline-refresh:',
  });
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(
    verdict.shouldApplyBaselineLabel,
    false,
    'mixed PRs should NOT get the review::baseline-refresh label',
  );
});

test('parseCliArgs — defaults and override combinations', () => {
  assert.deepStrictEqual(
    parseCliArgs(['--base-ref', 'origin/develop', '--pr-number', '42']),
    {
      baseRef: 'origin/develop',
      prNumber: 42,
      cwd: process.cwd(),
      skipLabel: false,
      skipCheckCrap: false,
      gateMode: false,
    },
  );
  const defaults = parseCliArgs([]);
  assert.strictEqual(defaults.baseRef, 'origin/main');
  assert.strictEqual(defaults.prNumber, null);
  assert.strictEqual(defaults.gateMode, false);
});

test('parseCliArgs — --gate-mode flag toggles gate-mode', () => {
  const parsed = parseCliArgs(['--gate-mode']);
  assert.strictEqual(parsed.gateMode, true);
});

test('parseCliArgs — --skip-label and --skip-check-crap flags', () => {
  const parsed = parseCliArgs([
    '--pr-number',
    '7',
    '--skip-label',
    '--skip-check-crap',
  ]);
  assert.strictEqual(parsed.skipLabel, true);
  assert.strictEqual(parsed.skipCheckCrap, true);
});

test('parseCliArgs — non-integer pr-number is rejected (left null)', () => {
  const parsed = parseCliArgs(['--pr-number', 'NaN']);
  assert.strictEqual(parsed.prNumber, null);
});

test('applyBaselineRefreshLabel — idempotent across re-runs (label exists → still applies)', () => {
  const calls = [];
  const runner = (_cwd, args) => {
    calls.push(args);
    if (args[0] === 'label' && args[1] === 'create') {
      // Simulate "label already exists" on re-run.
      return {
        status: 1,
        stdout: '',
        stderr: 'Label "review::baseline-refresh" already exists',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const result1 = applyBaselineRefreshLabel({
    prNumber: 101,
    cwd: '.',
    runner,
  });
  const result2 = applyBaselineRefreshLabel({
    prNumber: 101,
    cwd: '.',
    runner,
  });
  assert.strictEqual(result1.applied, true);
  assert.strictEqual(result2.applied, true);
  // Both runs issue one create attempt + one add-label call — add-label is a
  // set-union on GitHub's side so repeats are harmless.
  const addLabelCalls = calls.filter(
    (a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('--add-label'),
  );
  assert.strictEqual(addLabelCalls.length, 2);
  for (const call of addLabelCalls) {
    assert.ok(call.includes(BASELINE_REFRESH_LABEL));
    assert.ok(call.includes('101'));
  }
});

test('applyBaselineRefreshLabel — no pr-number: warns, does not call runner', () => {
  let called = false;
  const runner = () => {
    called = true;
    return { status: 0 };
  };
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    const res = applyBaselineRefreshLabel({
      prNumber: null,
      cwd: '.',
      runner,
    });
    assert.strictEqual(res.applied, false);
    assert.strictEqual(called, false);
    assert.ok(warnings[0].includes('--pr-number'));
  } finally {
    console.warn = origWarn;
  }
});

test('listChangedFiles — successful git diff returns repo-relative paths', () => {
  __setGitRunners(
    () => '',
    () => ({
      status: 0,
      stdout: 'baselines/crap.json\n.agents/scripts/foo.js\n',
      stderr: '',
    }),
  );
  try {
    const out = listChangedFiles('origin/main', '.', { argv: [], env: {} });
    assert.deepStrictEqual(out, [
      'baselines/crap.json',
      '.agents/scripts/foo.js',
    ]);
  } finally {
    __setGitRunners(null, null);
  }
});

test('listChangedFiles — git diff failure returns degraded envelope (default mode)', () => {
  // Tech Spec #819 / Story #826 — git-diff failure used to silently return
  // [], which made the guardrail conclude "no baseline edits" on a transient
  // git error. The new contract surfaces the failure explicitly.
  __setGitRunners(
    () => '',
    () => ({ status: 128, stdout: '', stderr: 'fatal: bad ref' }),
  );
  try {
    const out = listChangedFiles('origin/main', '.', { argv: [], env: {} });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.degraded, true);
    assert.strictEqual(out.reason, 'GIT_DIFF_FAILED');
    assert.match(out.detail, /fatal: bad ref/);
  } finally {
    __setGitRunners(null, null);
  }
});

test('listChangedFiles — git diff failure throws under --gate-mode', () => {
  __setGitRunners(
    () => '',
    () => ({ status: 128, stdout: '', stderr: 'fatal: bad ref' }),
  );
  try {
    assert.throws(
      () =>
        listChangedFiles('origin/main', '.', {
          argv: ['--gate-mode'],
          env: {},
        }),
      (err) => {
        assert.strictEqual(err.code, 'GIT_DIFF_FAILED');
        assert.strictEqual(err.degraded, true);
        return true;
      },
    );
  } finally {
    __setGitRunners(null, null);
  }
});

test('emitVerdictMessages — ok=true routes every message through log channel', () => {
  const log = [];
  const error = [];
  emitVerdictMessages(
    { ok: true, messages: ['a', 'b'] },
    { log: (m) => log.push(m), error: (m) => error.push(m) },
  );
  assert.deepStrictEqual(log, ['a', 'b']);
  assert.deepStrictEqual(error, []);
});

test('emitVerdictMessages — ok=false routes every message through error channel', () => {
  const log = [];
  const error = [];
  emitVerdictMessages(
    { ok: false, messages: ['x', 'y'] },
    { log: (m) => log.push(m), error: (m) => error.push(m) },
  );
  assert.deepStrictEqual(log, []);
  assert.deepStrictEqual(error, ['x', 'y']);
});

test('applyLabelIfNeeded — verdict says no → skipped, apply not called', () => {
  let called = false;
  const res = applyLabelIfNeeded({
    verdict: { shouldApplyBaselineLabel: false },
    args: { skipLabel: false, prNumber: 1, cwd: '.' },
    apply: () => {
      called = true;
      return { applied: true };
    },
  });
  assert.deepStrictEqual(res, { skipped: true, reason: 'verdict-says-no' });
  assert.strictEqual(called, false);
});

test('applyLabelIfNeeded — --skip-label set → skipped, apply not called', () => {
  let called = false;
  const res = applyLabelIfNeeded({
    verdict: { shouldApplyBaselineLabel: true },
    args: { skipLabel: true, prNumber: 1, cwd: '.' },
    apply: () => {
      called = true;
      return { applied: true };
    },
  });
  assert.deepStrictEqual(res, { skipped: true, reason: 'skip-label-flag' });
  assert.strictEqual(called, false);
});

test('applyLabelIfNeeded — verdict yes & not skipped → apply called with prNumber/cwd', () => {
  const calls = [];
  const res = applyLabelIfNeeded({
    verdict: { shouldApplyBaselineLabel: true },
    args: { skipLabel: false, prNumber: 42, cwd: '/tmp/x' },
    apply: (params) => {
      calls.push(params);
      return { applied: true };
    },
  });
  assert.deepStrictEqual(res, { applied: true });
  assert.deepStrictEqual(calls, [{ prNumber: 42, cwd: '/tmp/x' }]);
});

test('performCrapRecheck — --skip-check-crap → ok=true, run not called', () => {
  let called = false;
  const log = [];
  const res = performCrapRecheck({
    args: { skipCheckCrap: true, baseRef: 'origin/main', cwd: '.' },
    baseConfig: {},
    run: () => {
      called = true;
      return 0;
    },
    log: (m) => log.push(m),
    error: () => {},
  });
  assert.deepStrictEqual(res, { ok: true, exitCode: 0 });
  assert.strictEqual(called, false);
  assert.ok(log.some((m) => m.includes('skip-check-crap')));
});

test('performCrapRecheck — run returns 0 → ok=true', () => {
  const res = performCrapRecheck({
    args: { skipCheckCrap: false, baseRef: 'origin/main', cwd: '.' },
    baseConfig: { foo: 'bar' },
    run: ({ baseRef }) => {
      assert.strictEqual(baseRef, 'origin/main');
      return 0;
    },
    log: () => {},
    error: () => {},
  });
  assert.deepStrictEqual(res, { ok: true, exitCode: 0 });
});

test('performCrapRecheck — run returns non-zero → ok=false, exit code propagated', () => {
  const errors = [];
  const res = performCrapRecheck({
    args: { skipCheckCrap: false, baseRef: 'origin/main', cwd: '.' },
    baseConfig: {},
    run: () => 2,
    log: () => {},
    error: (m) => errors.push(m),
  });
  assert.deepStrictEqual(res, { ok: false, exitCode: 2 });
  assert.ok(errors.some((m) => m.includes('exit 2')));
});

test('applyBaselineRefreshLabel — gh pr edit failure: returns applied=false, does not throw', () => {
  const runner = (_cwd, args) => {
    if (args[0] === 'pr' && args[1] === 'edit') {
      return { status: 1, stdout: '', stderr: 'forbidden' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const res = applyBaselineRefreshLabel({
      prNumber: 42,
      cwd: '.',
      runner,
    });
    assert.strictEqual(res.applied, false);
    assert.strictEqual(res.reason, 'gh-error');
  } finally {
    console.warn = origWarn;
  }
});
