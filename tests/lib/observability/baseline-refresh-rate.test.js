/**
 * Unit tests for `lib/observability/baseline-refresh-rate.js`
 * (Epic #1386 / Story #1400 / Task #1427).
 *
 * Pure-function coverage: empty input, mixed Epics, out-of-window
 * filtering, malformed records, and the `cleanMergeRate` math.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  __test__,
  computeBaselineRefreshRate,
} from '../../../.agents/scripts/lib/observability/baseline-refresh-rate.js';

const NOW = new Date('2026-05-11T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(n) {
  return new Date(NOW_MS - n * DAY_MS).toISOString();
}

describe('computeBaselineRefreshRate', () => {
  it('produces a well-formed empty payload from no commits', () => {
    const out = computeBaselineRefreshRate([], { now: () => NOW });
    assert.equal(out.kind, 'baseline-refresh-rate');
    assert.equal(out.windowDays, __test__.DEFAULT_WINDOW_DAYS);
    assert.equal(out.generatedAt, NOW.toISOString());
    assert.deepEqual(out.perEpic, []);
    assert.deepEqual(out.totals, {
      storyMerges: 0,
      baselineRefreshes: 0,
      cleanMergeRate: 1,
    });
  });

  it('aggregates merges and refreshes per Epic', () => {
    const commits = [
      // Epic 100: 4 stories merged, 1 refresh → 75% clean
      {
        sha: 'a1',
        isoDate: isoDaysAgo(1),
        subject: 'feat: foo (resolves #501)',
        epicId: 100,
      },
      {
        sha: 'a2',
        isoDate: isoDaysAgo(2),
        subject: 'feat: bar (resolves #502)',
        epicId: 100,
      },
      {
        sha: 'a3',
        isoDate: isoDaysAgo(3),
        subject: 'feat: baz (resolves #503)',
        epicId: 100,
      },
      {
        sha: 'a4',
        isoDate: isoDaysAgo(3),
        subject: 'feat: qux (resolves #504)',
        epicId: 100,
      },
      {
        sha: 'a5',
        isoDate: isoDaysAgo(3),
        subject: 'baseline-refresh: maintainability drift from story-503 work',
        epicId: 100,
      },
      // Epic 200: 2 stories, 0 refresh → 100% clean
      {
        sha: 'b1',
        isoDate: isoDaysAgo(5),
        subject: 'feat(scope): one (resolves #601)',
        epicId: 200,
      },
      {
        sha: 'b2',
        isoDate: isoDaysAgo(5),
        subject: 'feat(scope): two (resolves #602)',
        epicId: 200,
      },
    ];

    const out = computeBaselineRefreshRate(commits, { now: () => NOW });
    const byId = Object.fromEntries(out.perEpic.map((r) => [r.epicId, r]));
    assert.equal(byId[100].storyMerges, 4);
    assert.equal(byId[100].baselineRefreshes, 1);
    assert.equal(byId[100].cleanMergeRate, 0.75);
    assert.equal(byId[200].storyMerges, 2);
    assert.equal(byId[200].baselineRefreshes, 0);
    assert.equal(byId[200].cleanMergeRate, 1);

    assert.equal(out.totals.storyMerges, 6);
    assert.equal(out.totals.baselineRefreshes, 1);
    assert.equal(out.totals.cleanMergeRate, roundForCmp((6 - 1) / 6));
  });

  it('drops commits outside the trailing window', () => {
    const commits = [
      // 5 days ago — in window (default 28d)
      {
        sha: 'in',
        isoDate: isoDaysAgo(5),
        subject: 'feat: in (resolves #1)',
        epicId: 1,
      },
      // 60 days ago — out of window
      {
        sha: 'out1',
        isoDate: isoDaysAgo(60),
        subject: 'feat: out (resolves #2)',
        epicId: 1,
      },
      {
        sha: 'out2',
        isoDate: isoDaysAgo(60),
        subject: 'baseline-refresh: ancient drift',
        epicId: 1,
      },
    ];
    const out = computeBaselineRefreshRate(commits, { now: () => NOW });
    assert.equal(out.perEpic.length, 1);
    assert.equal(out.perEpic[0].storyMerges, 1);
    assert.equal(out.perEpic[0].baselineRefreshes, 0);
    assert.equal(out.perEpic[0].cleanMergeRate, 1);
  });

  it('honors a custom windowDays override', () => {
    const commits = [
      {
        sha: 'inside',
        isoDate: isoDaysAgo(3),
        subject: 'feat: inside (resolves #1)',
        epicId: 1,
      },
      {
        sha: 'outside',
        isoDate: isoDaysAgo(10),
        subject: 'feat: outside (resolves #2)',
        epicId: 1,
      },
    ];
    const out = computeBaselineRefreshRate(commits, {
      now: () => NOW,
      windowDays: 7,
    });
    assert.equal(out.windowDays, 7);
    assert.equal(out.perEpic.length, 1);
    assert.equal(out.perEpic[0].storyMerges, 1);
  });

  it('ignores commits without epicId or subject', () => {
    const commits = [
      // valid baseline
      {
        sha: 'good',
        isoDate: isoDaysAgo(1),
        subject: 'feat: good (resolves #9)',
        epicId: 5,
      },
      // missing epicId
      {
        sha: 'no-epic',
        isoDate: isoDaysAgo(1),
        subject: 'feat: orphan (resolves #10)',
        epicId: null,
      },
      // missing subject
      {
        sha: 'no-subj',
        isoDate: isoDaysAgo(1),
        subject: '',
        epicId: 5,
      },
      // chore commit — neither baseline-refresh nor a Story merge
      {
        sha: 'chore',
        isoDate: isoDaysAgo(1),
        subject: 'chore: bump deps',
        epicId: 5,
      },
      // null record
      null,
      // non-object
      'not-a-commit',
    ];
    const out = computeBaselineRefreshRate(commits, { now: () => NOW });
    assert.equal(out.perEpic.length, 1);
    assert.equal(out.perEpic[0].storyMerges, 1);
    assert.equal(out.perEpic[0].baselineRefreshes, 0);
  });

  it('treats baseline-refresh: subjects with (resolves #N) as refresh-only', () => {
    // Disjoint classification: a subject starting with `baseline-refresh:`
    // is never counted as a Story merge even if it carries `(resolves #N)`.
    const commits = [
      {
        sha: 'r1',
        isoDate: isoDaysAgo(1),
        subject: 'baseline-refresh: drift (resolves #99)',
        epicId: 7,
      },
      {
        sha: 's1',
        isoDate: isoDaysAgo(1),
        subject: 'feat: real (resolves #100)',
        epicId: 7,
      },
    ];
    const out = computeBaselineRefreshRate(commits, { now: () => NOW });
    const row = out.perEpic.find((r) => r.epicId === 7);
    assert.equal(row.storyMerges, 1);
    assert.equal(row.baselineRefreshes, 1);
    assert.equal(row.cleanMergeRate, 0); // 1 story, 1 refresh → 0% clean
  });

  it('returns vacuously clean (cleanMergeRate=1) when no Stories merged', () => {
    const commits = [
      {
        sha: 'r',
        isoDate: isoDaysAgo(1),
        subject: 'baseline-refresh: only',
        epicId: 42,
      },
    ];
    const out = computeBaselineRefreshRate(commits, { now: () => NOW });
    const row = out.perEpic.find((r) => r.epicId === 42);
    assert.equal(row.storyMerges, 0);
    assert.equal(row.baselineRefreshes, 1);
    assert.equal(row.cleanMergeRate, 1);
  });

  it('drops malformed isoDate records', () => {
    const commits = [
      {
        sha: 'bad',
        isoDate: 'not-a-date',
        subject: 'feat: x (resolves #1)',
        epicId: 1,
      },
      {
        sha: 'good',
        isoDate: isoDaysAgo(1),
        subject: 'feat: y (resolves #2)',
        epicId: 1,
      },
    ];
    const out = computeBaselineRefreshRate(commits, { now: () => NOW });
    assert.equal(out.perEpic[0].storyMerges, 1);
  });

  it('exposes classifySubject directly for keyword pinning', () => {
    assert.equal(
      __test__.classifySubject('baseline-refresh: drift'),
      'refresh',
    );
    assert.equal(__test__.classifySubject('feat: foo (resolves #1)'), 'story');
    assert.equal(__test__.classifySubject('feat: foo (Resolves #2)'), 'story');
    assert.equal(__test__.classifySubject('chore: bump'), 'other');
    assert.equal(__test__.classifySubject(''), 'other');
    assert.equal(__test__.classifySubject(null), 'other');
  });
});

function roundForCmp(rate) {
  return Math.round(rate * 10000) / 10000;
}
