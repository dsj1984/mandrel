// tests/lib/orchestration/story-close/duplication-close-rescore.test.js
//
// Story #5626 — close re-scores the duplication rows of the files a Story
// changed and commits them UNTAGGED, so the head-vs-base duplication compare
// fails on a real rise instead of reading the same stale row on both sides.
// The AC-1 test drives a real git repo end to end through the ack phase;
// the rest inject git and the refresh so no test scans the real tree.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import * as duplicationKind from '../../../../.agents/scripts/lib/baselines/kinds/duplication.js';
import { gitSync } from '../../../../.agents/scripts/lib/git-utils.js';
import {
  applyTolerance,
  runCompareStage,
} from '../../../../.agents/scripts/lib/orchestration/check-baselines/phases/compare.js';
import { applyRefreshAcknowledgment } from '../../../../.agents/scripts/lib/orchestration/check-baselines/phases/refresh-ack.js';
import { runPreGateSteps } from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/pre-gate-steps.js';
import { runDuplicationCloseRescore } from '../../../../.agents/scripts/lib/orchestration/story-close/duplication-close-rescore.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';

const QUIET = { info: () => {}, warn: () => {} };
const REL = 'baselines/duplication.json';

const row = (p, duplicatedLines, totalLines = 100) => ({
  path: p,
  duplicatedLines,
  totalLines,
  percentage: Number(((duplicatedLines / totalLines) * 100).toFixed(2)),
});

function writeEnvelope(root, rows) {
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  fs.writeFileSync(
    path.join(root, REL),
    `${JSON.stringify({ kernelVersion: '1.0.0', rows }, null, 2)}\n`,
  );
}

/** A real repo: `main` holds the baseline, `story-7` changes `src/a.js`. */
function realRepo(baseRows) {
  const root = makeTempDir('dup-rescore-');
  const git = (...args) => gitSync(root, ...args);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src/b.js'), 'export const b = 1;\n');
  writeEnvelope(root, baseRows);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: seed');
  git('checkout', '-q', '-b', 'story-7');
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 2;\n');
  git('commit', '-q', '-am', 'feat: change a');
  return { root, git };
}

function readRows(root) {
  return JSON.parse(fs.readFileSync(path.join(root, REL), 'utf8')).rows;
}

describe('runDuplicationCloseRescore — real git (AC-1)', () => {
  test('a clone added to a changed file is committed untagged and fails the head-vs-base compare', async () => {
    const base = [row('src/a.js', 5), row('src/b.js', 8)];
    const { root, git } = realRepo(base);
    // The whole-tree scan sees a.js gain clones AND b.js drift; only a.js
    // (changed) may be written.
    const out = await runDuplicationCloseRescore({
      cwd: root,
      storyId: 7,
      baseBranch: 'main',
      storyBranch: 'story-7',
      config: {},
      logger: QUIET,
      scorer: () => [row('src/a.js', 20), row('src/b.js', 30)],
    });
    assert.equal(out.committed, true, JSON.stringify(out));
    assert.deepEqual(out.movedPaths, ['src/a.js']);

    const subject = git('log', '-1', '--format=%s');
    assert.doesNotMatch(subject, /baseline-refresh:/);
    assert.match(subject, /^chore\(baselines\): re-score duplication rows/);
    assert.match(git('log', '-1', '--format=%b'), /src\/a\.js: 5% -> 20%/);

    const headRows = readRows(root);
    assert.equal(headRows.find((r) => r.path === 'src/a.js').percentage, 20);
    assert.equal(
      headRows.find((r) => r.path === 'src/b.js').percentage,
      8,
      'an unchanged file keeps its committed row — the nightly owns it',
    );

    // The same compare → tolerance → ack chain `check-baselines` runs.
    const headBaseline = { rows: headRows };
    const tolerance = { kind: 'absolute', value: 1 };
    const cmp = {
      baseRef: 'main',
      baseRead: true,
      basePayload: { rows: base },
      kindModule: duplicationKind,
    };
    const compared = applyTolerance(
      runCompareStage(headBaseline, cmp),
      tolerance,
    );
    assert.deepEqual(
      compared.regressions.map((r) => r.key),
      ['src/a.js'],
    );
    const ack = applyRefreshAcknowledgment('duplication', compared, {
      gateBlock: { tolerance },
      cmp,
      cwd: root,
      env: {},
      headBaseline,
    });
    assert.equal(ack.acknowledged, false, 'untagged — nothing acknowledged');
    assert.equal(ack.compareOutput.regressions.length, 1);
  });

  test('a lowered row is committed too (both directions), and a re-run is a no-op', async () => {
    const { root, git } = realRepo([row('src/a.js', 20)]);
    const args = {
      cwd: root,
      storyId: 7,
      baseBranch: 'main',
      storyBranch: 'story-7',
      config: {},
      logger: QUIET,
      scorer: () => [],
    };
    const out = await runDuplicationCloseRescore(args);
    assert.equal(out.committed, true);
    assert.deepEqual(readRows(root), []);
    assert.match(git('log', '-1', '--format=%b'), /src\/a\.js: 20% -> none/);
    const again = await runDuplicationCloseRescore(args);
    assert.equal(again.reason, 'unchanged');
  });
});

/** A git stub answering the questions the step asks. */
function gitStub({
  branch = 'story-7',
  dirty = '',
  changed = 'src/a.js',
  failOn = null,
} = {}) {
  const calls = [];
  const git = (_cwd, ...args) => {
    calls.push(args);
    const key = args.join(' ');
    if (failOn && key.startsWith(failOn)) throw new Error(`git ${failOn} boom`);
    if (key === 'rev-parse --abbrev-ref HEAD') return branch;
    if (key.startsWith('status --porcelain')) return dirty;
    if (key.startsWith('diff --name-only')) return changed;
    if (key === 'rev-parse --short HEAD') return 'abc1234';
    return '';
  };
  return { git, calls };
}

function stubbed({ git = gitStub(), config = {}, refreshBaseline } = {}) {
  const root = makeTempDir('dup-rescore-stub-');
  writeEnvelope(root, [row('src/a.js', 5)]);
  return runDuplicationCloseRescore({
    cwd: root,
    storyId: 7,
    baseBranch: 'main',
    storyBranch: 'story-7',
    config,
    logger: QUIET,
    gitSync: git.git,
    refreshBaseline:
      refreshBaseline ??
      (async () => ({ wrote: true, envelope: { rows: [row('src/a.js', 9)] } })),
  });
}

describe('runDuplicationCloseRescore — named skips (AC-2)', () => {
  test('guards: missing context, wrong branch, dirty baseline, nothing scorable changed', async () => {
    assert.equal(
      (await runDuplicationCloseRescore({ logger: QUIET })).reason,
      'missing-context',
    );
    assert.equal(
      (await stubbed({ git: gitStub({ branch: 'main' }) })).reason,
      'wrong-branch',
    );
    assert.equal(
      (await stubbed({ git: gitStub({ dirty: ` M ${REL}` }) })).reason,
      'dirty-tree',
    );
    assert.equal(
      (await stubbed({ git: gitStub({ changed: 'docs/readme.md' }) })).reason,
      'no-changed-files',
    );
  });

  test('a disabled gate skips; an unreadable config is a named skip', async () => {
    const disabled = {
      delivery: { quality: { gates: { duplication: { enabled: false } } } },
    };
    assert.equal((await stubbed({ config: disabled })).reason, 'gate-disabled');
    const hostile = {
      get delivery() {
        throw new Error('bad config');
      },
    };
    assert.match(
      (await stubbed({ config: hostile })).reason,
      /^config-failed: /,
    );
  });

  test('a scorer failure is a named skip', async () => {
    const out = await stubbed({
      refreshBaseline: async () => {
        throw new Error('jscpd exploded');
      },
    });
    assert.equal(out.committed, false);
    assert.equal(out.reason, 'scorer-failed: jscpd exploded');
  });

  test('git failures — status or commit — are named skips, and a rejected commit restores the file', async () => {
    assert.match(
      (await stubbed({ git: gitStub({ failOn: 'status' }) })).reason,
      /^git-failed: /,
    );
    const stub = gitStub({ failOn: 'commit' });
    const out = await stubbed({ git: stub });
    assert.match(out.reason, /^git-failed: git commit boom/);
    assert.ok(
      stub.calls.some((c) => c[0] === 'restore'),
      'the rejected commit must restore the baseline',
    );
  });

  test('scopes the diff on origin/<base> when it exists, three-dot', async () => {
    const stub = gitStub();
    await stubbed({ git: stub });
    const diff = stub.calls.find((c) => c[0] === 'diff');
    assert.ok(diff.includes('origin/main...story-7'), diff.join(' '));
  });
});

describe('runPreGateSteps — the two new close steps', () => {
  const ctx = (progress) => ({
    cwd: '/x',
    worktreePath: null,
    storyId: 7,
    baseBranch: 'main',
    storyBranch: 'story-7',
    config: {},
    progress,
    runScopedFormatAutofix: () => ({ committed: false }),
    runBaselineUpwardWriteback: async () => ({ committed: false }),
    runContextBudgetWriteback: () => ({ committed: false }),
  });

  test('runs the duplication re-score then the ratchet shrink and reports both', async () => {
    const lines = [];
    const order = [];
    await runPreGateSteps({
      ...ctx((tag, msg) => lines.push(`${tag} ${msg}`)),
      runDuplicationCloseRescore: async () => {
        order.push('dup');
        return { committed: true, sha: 'aaa', movedPaths: ['src/a.js'] };
      },
      runRatchetShrinkWriteback: () => {
        order.push('ratchet');
        return {
          committed: true,
          sha: 'bbb',
          baselines: ['baselines/cyclomatic.json'],
        };
      },
    });
    assert.deepEqual(order, ['dup', 'ratchet']);
    assert.ok(
      lines.some((l) =>
        /^DUPLICATION ✅ Re-scored 1 duplication row\(s\) \(untagged\) as aaa/.test(
          l,
        ),
      ),
      lines.join('\n'),
    );
    assert.ok(
      lines.some((l) =>
        /^RATCHET ✅ Dropped burnt-down rows from baselines\/cyclomatic\.json as bbb/.test(
          l,
        ),
      ),
      lines.join('\n'),
    );
  });

  test('a throwing step never fails the close (AC-2)', async () => {
    const lines = [];
    await runPreGateSteps({
      ...ctx((tag, msg) => lines.push(`${tag} ${msg}`)),
      runDuplicationCloseRescore: async () => {
        throw new Error('kaboom');
      },
      runRatchetShrinkWriteback: () => ({
        committed: false,
        reason: 'no-shrink',
      }),
    });
    assert.ok(
      lines.some((l) => /^DUPLICATION ⚠️ duplication re-score failed/.test(l)),
    );
    assert.ok(
      lines.some((l) =>
        /^RATCHET ⏭ No ratchet shrink write-back \(no-shrink\)/.test(l),
      ),
    );
  });

  test('skips both without a story branch', async () => {
    const lines = [];
    await runPreGateSteps({
      ...ctx((tag, msg) => lines.push(`${tag} ${msg}`)),
      storyBranch: undefined,
    });
    assert.ok(lines.some((l) => l.startsWith('DUPLICATION ⏭')));
    assert.ok(lines.some((l) => l.startsWith('RATCHET ⏭')));
  });
});
