// tests/lib/close-validation/projections/maintainability.test.js
/**
 * Story #1850 / Task #1874 — sibling unit tests for the extracted
 * `projectMaintainabilityRegressions` helper. The parent
 * `tests/close-validation-mi-projection.test.js` still asserts the full
 * public contract via the close-validation re-export; this file pins the
 * helper's behaviour at the sub-module boundary so a refactor that
 * accidentally bypasses the shared `validateProjectionInputs` predicate
 * surfaces here directly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MI_TOLERANCE,
  formatMaintainabilityProjection,
  projectMaintainabilityRegressions,
} from '../../../../.agents/scripts/lib/close-validation/projections/maintainability.js';

function makeFakeGit({ files, sources, fetchOk = true, diffOk = true }) {
  return {
    gitSpawn: (_cwd, ...args) => {
      const [cmd, ...rest] = args;
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
      if (cmd === 'show') {
        const ref = rest[0] ?? '';
        const file = ref.split(':').slice(1).join(':');
        const source = sources[file];
        return source === undefined
          ? { status: 128, stdout: '', stderr: 'fatal: path not in tree' }
          : { status: 0, stdout: source, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

const baseOpts = {
  cwd: '/repo',
  epicBranch: 'epic/1831',
  storyBranch: 'story-1850',
  baselinePath: '/repo/baselines/maintainability.json',
};

describe('projectMaintainabilityRegressions — submodule', () => {
  it('exports a default MI tolerance constant', () => {
    assert.equal(typeof DEFAULT_MI_TOLERANCE, 'number');
    assert.ok(DEFAULT_MI_TOLERANCE > 0);
  });

  it('returns "missing-args" for any missing required option', () => {
    for (const omit of ['cwd', 'epicBranch', 'storyBranch', 'baselinePath']) {
      const opts = { ...baseOpts, [omit]: undefined };
      const result = projectMaintainabilityRegressions({
        ...opts,
        loadBaseline: () => ({ 'a.js': 80 }),
      });
      assert.equal(result.ok, true, `omit=${omit} should not error`);
      assert.equal(result.skipped, 'missing-args', `omit=${omit}`);
    }
  });

  it('returns "no-baseline" when the baseline is null', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      git: makeFakeGit({ files: [], sources: {} }),
      loadBaseline: () => null,
      scoreSource: () => 100,
    });
    assert.equal(result.skipped, 'no-baseline');
  });

  it('skips git fetch when the predicate rejects upfront', () => {
    let spawned = 0;
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      cwd: undefined, // forces missing-args
      git: {
        gitSpawn: () => {
          spawned += 1;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      loadBaseline: () => ({ 'a.js': 80 }),
    });
    assert.equal(result.skipped, 'missing-args');
    assert.equal(spawned, 0);
  });

  it('flags files whose projected score breaches baseline minus tolerance', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      git: makeFakeGit({
        files: ['lib/foo.js'],
        sources: { 'lib/foo.js': 'src' },
      }),
      loadBaseline: () => ({ 'lib/foo.js': 80 }),
      scoreSource: () => 70,
    });
    assert.equal(result.ok, false);
    assert.equal(result.regressions[0].file, 'lib/foo.js');
    assert.equal(result.regressions[0].drop, 10);
  });

  it('propagates fetch-failed detail without making a diff call', () => {
    // Use unique cwd/epicBranch so the module-level fetch cache from an
    // earlier passing fetch doesn't short-circuit this test's failing fetch.
    let diffCalls = 0;
    const git = {
      gitSpawn: (_cwd, cmd) => {
        if (cmd === 'fetch') {
          return { status: 1, stdout: '', stderr: 'fetch boom' };
        }
        if (cmd === 'diff') {
          diffCalls += 1;
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      cwd: `/repo-fetch-fail-${Math.random()}`,
      epicBranch: `epic/fetch-fail-${Math.random()}`,
      git,
      loadBaseline: () => ({ 'a.js': 80 }),
    });
    assert.equal(result.skipped, 'fetch-failed');
    assert.match(result.detail, /fetch boom/);
    assert.equal(diffCalls, 0);
  });
});

describe('formatMaintainabilityProjection — submodule', () => {
  it('returns null for a clean projection', () => {
    assert.equal(formatMaintainabilityProjection({ regressions: [] }), null);
    assert.equal(formatMaintainabilityProjection(null), null);
    assert.equal(formatMaintainabilityProjection(undefined), null);
    assert.equal(
      formatMaintainabilityProjection({ regressions: 'not-an-array' }),
      null,
    );
  });

  it('renders an advisory line per regression and includes the refresh workflow', () => {
    const text = formatMaintainabilityProjection({
      regressions: [{ file: 'lib/x.js', projected: 50, baseline: 80, drop: 30 }],
    });
    assert.match(text, /Pre-merge MI projection: 1 file\(s\)/);
    assert.match(text, /lib\/x\.js/);
    assert.match(text, /projected=50\.00/);
    assert.match(text, /baseline=80\.00/);
    assert.match(text, /drop=-30\.00/);
    assert.match(text, /baseline-refresh:/);
  });
});
