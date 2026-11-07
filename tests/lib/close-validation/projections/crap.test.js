// tests/lib/close-validation/projections/crap.test.js
/**
 * Story #4776 — unit tests for the pre-merge CRAP projection.
 *
 * The sibling maintainability projection shipped fully tested and never
 * called; these tests pin the CRAP analogue's contract at the module
 * boundary AND the properties that make it safe to wire into
 * close-validation: it never throws, it self-skips on every unscorable
 * input, and its advisory names the exact refresh remedy.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CRAP_TOLERANCE,
  DEFAULT_NEW_METHOD_CEILING,
  formatCrapProjection,
  projectCrapBreaches,
} from '../../../../.agents/scripts/lib/close-validation/projections/crap.js';

function makeFakeGit({ files = [], fetchOk = true, diffOk = true } = {}) {
  return {
    gitSpawn: (_cwd, ...args) => {
      const [cmd] = args;
      if (cmd === 'fetch') {
        return fetchOk
          ? { status: 0, stdout: '', stderr: '' }
          : { status: 1, stdout: '', stderr: 'fetch boom' };
      }
      if (cmd === 'diff') {
        return diffOk
          ? { status: 0, stdout: files.join('\n'), stderr: '' }
          : { status: 1, stdout: '', stderr: 'diff boom' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

const BASELINE = [
  { file: 'src/a.js', method: 'wide', startLine: 10, crap: 12 },
  { file: 'src/a.js', method: 'calm', startLine: 40, crap: 4 },
];

const baseOpts = {
  cwd: '/repo',
  baseBranch: 'main',
  storyBranch: 'story-4776',
  baselinePath: '/repo/baselines/crap.json',
  loadBaseline: () => BASELINE,
};

function scorer(rows) {
  return async () => rows;
}

describe('projectCrapBreaches', () => {
  it('exports the tolerance and ceiling constants', () => {
    assert.equal(typeof DEFAULT_CRAP_TOLERANCE, 'number');
    assert.ok(DEFAULT_CRAP_TOLERANCE > 0);
    assert.equal(DEFAULT_NEW_METHOD_CEILING, 30);
  });

  it('reports "missing-args" for any missing required option', async () => {
    for (const key of ['cwd', 'baseBranch', 'storyBranch', 'baselinePath']) {
      const opts = { ...baseOpts, [key]: undefined };
      const res = await projectCrapBreaches(opts);
      assert.equal(res.ok, true, `${key} must not fail the projection`);
      assert.equal(res.skipped, 'missing-args');
      assert.deepEqual(res.breaches, []);
    }
  });

  it('self-skips with "no-baseline" when the baseline is absent or empty', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      loadBaseline: () => [],
      git: makeFakeGit({ files: ['src/a.js'] }),
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'no-baseline');
  });

  it('self-skips on a fetch failure, carrying the detail', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      git: makeFakeGit({ fetchOk: false }),
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'fetch-failed');
    assert.match(res.detail, /fetch boom/);
  });

  it('self-skips on a diff failure', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      git: makeFakeGit({ diffOk: false }),
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'diff-failed');
  });

  it('self-skips when the diff contains no scorable files', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      git: makeFakeGit({ files: ['docs/readme.md', 'baselines/crap.json'] }),
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'no-scorable-files');
  });

  it('scores changed .mts / .cts files instead of dropping them (Story #5076)', async () => {
    // The projection carried its own extension literal, narrower than the
    // set the CRAP scanner actually walks, so a changed `.mts`/`.cts` file
    // was silently excluded from the pre-merge projection.
    let scored = null;
    const res = await projectCrapBreaches({
      ...baseOpts,
      git: makeFakeGit({
        files: ['src/a.mts', 'src/b.cts', 'docs/readme.md'],
      }),
      scoreFiles: async (files) => {
        scored = files;
        return [];
      },
    });
    assert.equal(res.ok, true);
    assert.notEqual(res.skipped, 'no-scorable-files');
    assert.deepEqual(scored, ['src/a.mts', 'src/b.cts']);
  });

  it('self-skips with "no-coverage" when the scorer reports no coverage artifact', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      git: makeFakeGit({ files: ['src/a.js'] }),
      scoreFiles: async () => null,
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'no-coverage');
  });

  it('self-skips rather than throwing when the scorer blows up', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      git: makeFakeGit({ files: ['src/a.js'] }),
      scoreFiles: async () => {
        throw new Error('escomplex exploded');
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'score-failed');
    assert.match(res.detail, /escomplex exploded/);
  });

  it('reports no breach when every scored method holds its baseline', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      git: makeFakeGit({ files: ['src/a.js'] }),
      scoreFiles: scorer([
        {
          file: 'src/a.js',
          method: 'wide',
          startLine: 10,
          cyclomatic: 6,
          coverage: 0.9,
          crap: 11,
        },
      ]),
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, undefined);
    assert.deepEqual(res.breaches, []);
    assert.equal(formatCrapProjection(res), null);
  });

  it('names a method that would breach its committed baseline row', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      git: makeFakeGit({ files: ['src/a.js'] }),
      scoreFiles: scorer([
        {
          file: 'src/a.js',
          method: 'wide',
          startLine: 10,
          cyclomatic: 9,
          coverage: 0.4,
          crap: 44,
        },
      ]),
    });
    assert.equal(res.ok, false);
    assert.equal(res.breaches.length, 1);
    assert.equal(res.breaches[0].method, 'wide');
    assert.equal(res.breaches[0].kind, 'regression');
    assert.equal(res.breaches[0].baseline, 12);
  });

  it('names a NEW method that would breach the newMethodCeiling', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      newMethodCeiling: 30,
      git: makeFakeGit({ files: ['src/a.js'] }),
      scoreFiles: scorer([
        {
          file: 'src/a.js',
          method: 'freshlyAdded',
          startLine: 200,
          cyclomatic: 12,
          coverage: 0.1,
          crap: 133,
        },
      ]),
    });
    assert.equal(res.ok, false);
    assert.equal(res.breaches.length, 1);
    assert.equal(res.breaches[0].kind, 'new');
    assert.equal(res.breaches[0].ceiling, 30);
  });

  it('narrows baseline rows to the changed files so untouched rows are not compared', async () => {
    const res = await projectCrapBreaches({
      ...baseOpts,
      loadBaseline: () => [
        ...BASELINE,
        { file: 'src/untouched.js', method: 'legacy', startLine: 1, crap: 99 },
      ],
      git: makeFakeGit({ files: ['src/a.js'] }),
      scoreFiles: scorer([
        {
          file: 'src/a.js',
          method: 'calm',
          startLine: 40,
          cyclomatic: 2,
          coverage: 1,
          crap: 4,
        },
      ]),
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.breaches, []);
  });

  describe('scoringSemantics of the baseline', () => {
    const regressing = scorer([
      {
        file: 'src/a.js',
        method: 'wide',
        startLine: 10,
        cyclomatic: 9,
        coverage: 0.4,
        crap: 44,
      },
    ]);
    const run = (peek) =>
      projectCrapBreaches({
        ...baseOpts,
        peekBaseline: peek,
        git: makeFakeGit({ files: ['src/a.js'] }),
        scoreFiles: regressing,
      });

    for (const [stamp, reason] of [
      ['method-identity-v6', 'semantics-ahead'],
      ['method-identity-v4', 'semantics-behind'],
    ]) {
      it(`skips with "${reason}" for a baseline stamped ${stamp}`, async () => {
        const res = await run(() => ({ scoringSemantics: stamp }));
        assert.equal(res.ok, true);
        assert.equal(res.skipped, reason);
        assert.deepEqual(res.breaches, []);
      });
    }

    it('still compares a baseline stamped with the running semantics', async () => {
      const res = await run(() => ({ scoringSemantics: 'method-identity-v5' }));
      assert.equal(res.ok, false);
      assert.equal(res.breaches[0].kind, 'regression');
    });

    it('does not read an unreadable baseline file as stamped behind', async () => {
      const res = await run(() => null);
      assert.equal(res.skipped, undefined);
      assert.equal(res.breaches[0].kind, 'regression');
    });
  });
});

describe('formatCrapProjection', () => {
  const breachResult = {
    ok: false,
    breaches: [
      {
        file: 'src/a.js',
        method: 'wide',
        startLine: 10,
        crap: 44,
        baseline: 12,
        kind: 'regression',
      },
      {
        file: 'src/a.js',
        method: 'freshlyAdded',
        startLine: 200,
        crap: 133,
        ceiling: 30,
        kind: 'new',
      },
    ],
  };

  it('returns null when there is nothing to surface', () => {
    assert.equal(formatCrapProjection(null), null);
    assert.equal(formatCrapProjection({ ok: true, breaches: [] }), null);
    assert.equal(formatCrapProjection({ ok: true }), null);
  });

  it('names every breaching method with its projected and target score', () => {
    const text = formatCrapProjection(breachResult);
    assert.match(text, /src\/a\.js::wide \(line 10\)/);
    assert.match(text, /projected=44\.00/);
    assert.match(text, /baseline=12\.00/);
    assert.match(text, /src\/a\.js::freshlyAdded \(line 200\)/);
    assert.match(text, /ceiling=30/);
  });

  it('names the remedy explicitly — crap:update, baseline-refresh:, non-empty body', () => {
    const text = formatCrapProjection(breachResult);
    assert.match(text, /npm run crap:update/);
    assert.match(text, /baseline-refresh:/);
    assert.match(text, /non-empty body/);
  });
});
