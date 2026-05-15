import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatMaintainabilityProjection,
  projectMaintainabilityRegressions,
} from '../.agents/scripts/lib/close-validation.js';
import {
  formatMaintainabilityProjection as formatFromSubmodule,
  projectMaintainabilityRegressions as projectFromSubmodule,
} from '../.agents/scripts/lib/close-validation/projections/maintainability.js';

/**
 * Unit tests for the pre-merge MI ceiling projection helper.
 *
 * The helper is the engine behind Story #781 — story-close invokes it
 * before the merge runs to surface, by name, the files that would breach
 * their per-file MI baseline post-merge so the operator can ship a
 * `baseline-refresh:` commit atomically with the Story PR.
 *
 * Tests use injected `git` / `loadBaseline` / `scoreSource` so they exercise
 * the projection logic without touching the real git tree or escomplex.
 */

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
  epicBranch: 'epic/773',
  storyBranch: 'story-781',
  baselinePath: '/repo/baselines/maintainability.json',
};

describe('projectMaintainabilityRegressions', () => {
  it('returns "no-baseline" when the baseline is empty', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      git: makeFakeGit({ files: [], sources: {} }),
      loadBaseline: () => ({}),
      scoreSource: () => 100,
    });
    assert.equal(result.skipped, 'no-baseline');
    assert.deepEqual(result.regressions, []);
    assert.equal(result.ok, true);
  });

  it('returns "fetch-failed" when fetch exits non-zero', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      git: makeFakeGit({ files: [], sources: {}, fetchOk: false }),
      loadBaseline: () => ({ 'a.js': 80 }),
      scoreSource: () => 100,
    });
    assert.equal(result.skipped, 'fetch-failed');
    assert.equal(result.ok, true);
  });

  it('returns "diff-failed" when diff exits non-zero', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      git: makeFakeGit({ files: [], sources: {}, diffOk: false }),
      loadBaseline: () => ({ 'a.js': 80 }),
      scoreSource: () => 100,
    });
    assert.equal(result.skipped, 'diff-failed');
    assert.equal(result.ok, true);
  });

  it('flags files whose projected score breaches baseline minus tolerance', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      git: makeFakeGit({
        files: ['lib/foo.js', 'lib/bar.js'],
        sources: {
          'lib/foo.js': '// projected score 70',
          'lib/bar.js': '// projected score 90',
        },
      }),
      loadBaseline: () => ({ 'lib/foo.js': 80, 'lib/bar.js': 90 }),
      scoreSource: (src) => (src.includes('70') ? 70 : 90),
    });
    assert.equal(result.ok, false);
    assert.equal(result.regressions.length, 1);
    const [reg] = result.regressions;
    assert.equal(reg.file, 'lib/foo.js');
    assert.equal(reg.projected, 70);
    assert.equal(reg.baseline, 80);
    assert.equal(reg.drop, 10);
  });

  it('skips non-JS files, files absent from baseline, and deleted files', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      git: makeFakeGit({
        files: [
          'docs/README.md',
          'lib/added.js',
          'lib/deleted.js',
          'lib/scored.js',
        ],
        sources: {
          // 'lib/deleted.js' deliberately absent → git show fails
          'lib/added.js': 'src',
          'lib/scored.js': 'src',
        },
      }),
      loadBaseline: () => ({ 'lib/scored.js': 80 }),
      scoreSource: () => 70,
    });
    assert.equal(result.regressions.length, 1);
    assert.equal(result.regressions[0].file, 'lib/scored.js');
  });

  it('does not flag scores within tolerance of baseline', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      tolerance: 0.5,
      git: makeFakeGit({
        files: ['lib/x.js'],
        sources: { 'lib/x.js': 'src' },
      }),
      loadBaseline: () => ({ 'lib/x.js': 80 }),
      scoreSource: () => 79.7, // drop of 0.3 < tolerance 0.5
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.regressions, []);
  });

  it('returns "missing-args" when a required option is undefined', () => {
    const result = projectMaintainabilityRegressions({});
    assert.equal(result.skipped, 'missing-args');
    assert.equal(result.ok, true);
  });

  it('normalizes Windows-style backslash diff paths to forward slashes', () => {
    const result = projectMaintainabilityRegressions({
      ...baseOpts,
      git: makeFakeGit({
        files: ['lib\\foo.js'],
        sources: { 'lib/foo.js': 'src' },
      }),
      loadBaseline: () => ({ 'lib/foo.js': 80 }),
      scoreSource: () => 50,
    });
    assert.equal(result.regressions.length, 1);
    assert.equal(result.regressions[0].file, 'lib/foo.js');
  });
});

describe('formatMaintainabilityProjection', () => {
  it('returns null for a clean projection', () => {
    assert.equal(formatMaintainabilityProjection({ regressions: [] }), null);
    assert.equal(formatMaintainabilityProjection(null), null);
  });

  it('renders a multi-line advisory naming each file and the refresh workflow', () => {
    const text = formatMaintainabilityProjection({
      regressions: [
        { file: 'lib/foo.js', projected: 70, baseline: 80, drop: 10 },
        { file: 'lib/bar.js', projected: 65, baseline: 90, drop: 25 },
      ],
    });
    assert.match(text, /Pre-merge MI projection: 2 file\(s\)/);
    assert.match(text, /lib\/foo\.js/);
    assert.match(text, /lib\/bar\.js/);
    assert.match(text, /baseline-refresh:/);
    assert.match(text, /maintainability:update/);
  });
});

describe('projections/maintainability re-export (Story #1850 / Task #1874)', () => {
  it('parent close-validation re-export is identical to the sub-module export', () => {
    assert.equal(projectMaintainabilityRegressions, projectFromSubmodule);
    assert.equal(formatMaintainabilityProjection, formatFromSubmodule);
  });

  it('predicate-extracted helper still normalises fine-grained missing-arg reasons to "missing-args"', () => {
    const result = projectFromSubmodule({
      cwd: '/repo',
      epicBranch: 'epic/1831',
      // missing storyBranch
      baselinePath: '/repo/baselines/maintainability.json',
      loadBaseline: () => ({ 'lib/a.js': 80 }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'missing-args');
    assert.deepEqual(result.regressions, []);
  });

  it('predicate-extracted helper short-circuits on no-baseline before any git call', () => {
    const calls = [];
    const result = projectFromSubmodule({
      ...baseOpts,
      git: {
        gitSpawn: (...args) => {
          calls.push(args);
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      loadBaseline: () => ({}),
      scoreSource: () => 100,
    });
    assert.equal(result.skipped, 'no-baseline');
    assert.deepEqual(calls, []); // predicate caught it before any spawn
  });
});
