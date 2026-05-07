import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyBaselineDrift } from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution.js';

/**
 * baseline-attribution.test.js — Story #1124 / Task #1132.
 *
 * Pins the four documented branches of `classifyBaselineDrift`:
 *
 *   - all-attributable          → zero git spawns, all rows in `attributable`
 *   - all-non-attributable      → suspect lookup runs, `(resolves #N)` parsed
 *   - mixed                     → split mirrors path intersection
 *   - missing-resolves-token    → `suspectStoryNumber: null`, sha populated
 */

function makeRecordingGit(plan = {}) {
  const calls = [];
  const gitSpawn = (cwd, ...args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    if (Object.hasOwn(plan, key)) return plan[key];
    return { status: 0, stdout: '', stderr: '' };
  };
  return { runner: { gitSpawn }, calls };
}

describe('classifyBaselineDrift — branch coverage', () => {
  it('returns every regression as attributable when paths intersect storyDiffPaths', () => {
    const { runner, calls } = makeRecordingGit();
    const result = classifyBaselineDrift({
      regressions: [{ path: 'lib/x.js' }, { path: 'lib/y.js' }],
      storyDiffPaths: ['lib/x.js', 'lib/y.js', 'unrelated.js'],
      epicRef: 'origin/epic/1114',
      cwd: '/repo',
      gitRunner: runner,
    });
    assert.equal(result.attributable.length, 2);
    assert.equal(result.nonAttributable.length, 0);
    assert.deepEqual(
      result.attributable.map((r) => r.path),
      ['lib/x.js', 'lib/y.js'],
    );
    // Hot-path contract: zero git spawns when nothing is non-attributable.
    assert.equal(calls.length, 0);
  });

  it('parses `(resolves #N)` trailer from the most recent commit on epicRef', () => {
    const { runner, calls } = makeRecordingGit({
      'log --oneline -n 1 origin/epic/1114 -- lib/x.js': {
        status: 0,
        stdout: 'deadbee1 fix(stuff): something here (resolves #777)',
        stderr: '',
      },
    });
    const result = classifyBaselineDrift({
      regressions: [{ path: 'lib/x.js' }],
      storyDiffPaths: ['lib/other.js'],
      epicRef: 'origin/epic/1114',
      cwd: '/repo',
      gitRunner: runner,
    });
    assert.equal(result.attributable.length, 0);
    assert.equal(result.nonAttributable.length, 1);
    assert.equal(result.nonAttributable[0].path, 'lib/x.js');
    assert.equal(result.nonAttributable[0].suspectSha, 'deadbee1');
    assert.equal(result.nonAttributable[0].suspectStoryNumber, 777);
    // One spawn for the single non-attributable lookup.
    assert.equal(calls.length, 1);
  });

  it('mixes attributable + non-attributable rows correctly', () => {
    const { runner } = makeRecordingGit({
      'log --oneline -n 1 origin/epic/1114 -- lib/sibling.js': {
        status: 0,
        stdout: 'cafe1234 refactor(x): bump (resolves #500)',
        stderr: '',
      },
    });
    const result = classifyBaselineDrift({
      regressions: [
        { path: 'lib/touched.js' },
        { path: 'lib/sibling.js' },
        { path: 'lib/another-touched.js' },
      ],
      storyDiffPaths: ['lib/touched.js', 'lib/another-touched.js'],
      epicRef: 'origin/epic/1114',
      cwd: '/repo',
      gitRunner: runner,
    });
    assert.equal(result.attributable.length, 2);
    assert.equal(result.nonAttributable.length, 1);
    assert.equal(result.nonAttributable[0].path, 'lib/sibling.js');
    assert.equal(result.nonAttributable[0].suspectStoryNumber, 500);
  });

  it('returns null suspectStoryNumber when no `(resolves #N)` token exists; suspectSha is the most recent commit', () => {
    const { runner } = makeRecordingGit({
      'log --oneline -n 1 origin/epic/1114 -- lib/orphan.js': {
        status: 0,
        stdout: 'beef0001 chore: bump deps without trailer',
        stderr: '',
      },
    });
    const result = classifyBaselineDrift({
      regressions: [{ path: 'lib/orphan.js' }],
      storyDiffPaths: ['lib/different.js'],
      epicRef: 'origin/epic/1114',
      cwd: '/repo',
      gitRunner: runner,
    });
    assert.equal(result.nonAttributable.length, 1);
    assert.equal(result.nonAttributable[0].suspectStoryNumber, null);
    assert.equal(result.nonAttributable[0].suspectSha, 'beef0001');
  });

  it('treats `git log` failure as no-information (suspect fields null) and still classifies non-attributable', () => {
    const { runner } = makeRecordingGit({
      'log --oneline -n 1 origin/epic/1114 -- lib/missing.js': {
        status: 128,
        stdout: '',
        stderr: 'unknown ref',
      },
    });
    const result = classifyBaselineDrift({
      regressions: [{ path: 'lib/missing.js' }],
      storyDiffPaths: [],
      epicRef: 'origin/epic/1114',
      cwd: '/repo',
      gitRunner: runner,
    });
    assert.equal(result.nonAttributable.length, 1);
    assert.equal(result.nonAttributable[0].suspectSha, null);
    assert.equal(result.nonAttributable[0].suspectStoryNumber, null);
  });

  it('normalizes Windows-style backslash paths on both sides of the intersection', () => {
    const { runner, calls } = makeRecordingGit();
    const result = classifyBaselineDrift({
      regressions: [{ path: 'lib\\win.js' }],
      storyDiffPaths: ['lib/win.js'],
      epicRef: 'origin/epic/1114',
      cwd: '/repo',
      gitRunner: runner,
    });
    assert.equal(result.attributable.length, 1);
    assert.equal(result.attributable[0].path, 'lib/win.js');
    assert.equal(calls.length, 0);
  });

  it('reads either `path` or `file` from regression rows', () => {
    const { runner } = makeRecordingGit();
    const result = classifyBaselineDrift({
      regressions: [{ file: 'lib/a.js' }, { path: 'lib/b.js' }],
      storyDiffPaths: ['lib/a.js', 'lib/b.js'],
      epicRef: 'origin/epic/1114',
      cwd: '/repo',
      gitRunner: runner,
    });
    assert.equal(result.attributable.length, 2);
    assert.equal(result.attributable[0].path, 'lib/a.js');
    assert.equal(result.attributable[1].path, 'lib/b.js');
  });
});
