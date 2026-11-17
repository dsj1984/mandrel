// tests/lib/orchestration/diff-magnitude.test.js
//
// Unit tier (Story #4856): the changed-line magnitude of a diff, split into
// implementation and mandated-companion halves. This is the measurement the
// light path's diff backstop replaced a `maxFiles: 4` cardinality ceiling with,
// so the suite pins the three contracts that make the replacement sound:
//
//   - additions + deletions, never net (a large deletion must not read small);
//   - the companion boundary — what is exempt from the counts, and critically
//     what is NOT, since exempting behavior-bearing config would let a change
//     widen the very allowlist that decides whether it is risky;
//   - a rename is free, and an unparseable numstat is `null` rather than 0.
//
// The module exports exactly two functions. The parse, the rename
// normalization, and the companion classifier are internal and are driven here
// through those two — a stubbed `gitSpawnFn` for the parse, the `isCompanionFn`
// seam for classification — rather than by widening the module's surface to
// satisfy a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  readNumstatRows,
  summarizeDiffMagnitude,
} from '../../../.agents/scripts/lib/orchestration/diff-magnitude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Drive the internal parse by stubbing the one git read. */
const parseVia = (stdout, status = 0) =>
  readNumstatRows({
    baseRef: 'main',
    headRef: 'story-1',
    gitSpawnFn: () => ({ status, stdout }),
  });

const rowsOf = (...triples) =>
  triples.map(([additions, deletions, path]) => ({
    additions,
    deletions,
    path,
  }));

describe('readNumstatRows — per-file rows, or null when untrustworthy', () => {
  test('parses additions, deletions, and path', () => {
    assert.deepEqual(parseVia('10\t5\ta.js\n1\t0\tb.js\n'), [
      { additions: 10, deletions: 5, path: 'a.js' },
      { additions: 1, deletions: 0, path: 'b.js' },
    ]);
  });

  test('a binary row contributes zero without poisoning the parse', () => {
    assert.deepEqual(parseVia('-\t-\timg.png\n4\t2\ta.js\n'), [
      { additions: 0, deletions: 0, path: 'img.png' },
      { additions: 4, deletions: 2, path: 'a.js' },
    ]);
  });

  test('an empty diff is an empty row list, NOT null', () => {
    // Zero is a fact; null is the absence of evidence. Callers fail closed on
    // the latter, so conflating them would block every empty diff as unknown.
    assert.deepEqual(parseVia(''), []);
  });

  test('unparseable output is null', () => {
    for (const bad of ['garbage', 'x\ty\tz.js']) {
      assert.equal(parseVia(bad), null, bad);
    }
  });

  test('a rename resolves to its destination, and costs nothing', () => {
    assert.deepEqual(parseVia('0\t0\tlib/{old => new}/file.js\n'), [
      { additions: 0, deletions: 0, path: 'lib/new/file.js' },
    ]);
    assert.deepEqual(parseVia('0\t0\told.js => new.js\n'), [
      { additions: 0, deletions: 0, path: 'new.js' },
    ]);
  });

  test('passes the three-dot range to git', () => {
    let args;
    readNumstatRows({
      baseRef: 'main',
      headRef: 'story-1',
      gitSpawnFn: (...rest) => {
        args = rest;
        return { status: 0, stdout: '' };
      },
    });
    assert.deepEqual(args.slice(1), ['diff', '--numstat', 'main...story-1']);
  });

  test('null on a non-zero exit, a throw, or a missing ref', () => {
    assert.equal(parseVia('3\t1\ta.js\n', 128), null);
    assert.equal(
      readNumstatRows({
        baseRef: 'main',
        headRef: 'story-1',
        gitSpawnFn: () => {
          throw new Error('spawn failed');
        },
      }),
      null,
    );
    assert.equal(readNumstatRows({ headRef: 'story-1' }), null);
    assert.equal(readNumstatRows({ baseRef: 'main' }), null);
    assert.equal(readNumstatRows(), null);
  });
});

describe('summarizeDiffMagnitude — the companion boundary', () => {
  /** Summarize a single file, reporting whether it counted as implementation. */
  const countsAsImplementation = (file) => {
    const s = summarizeDiffMagnitude({
      changedFiles: [file],
      rows: rowsOf([10, 0, file]),
    });
    return s.implFiles === 1 && s.implLines === 10;
  };

  test('mandated companions are exempt from the counts', () => {
    for (const file of [
      'tests/lib/x.test.js',
      'foo.test.js',
      '.agents/scripts/lib/__tests__/x.js',
      'features/login.feature',
      'docs/onboarding.md',
      'README.md',
      '.agents/workflows/helpers/deliver-light.md',
      'baselines/crap.json',
      'baselines/agents-loc.csv',
      'package-lock.json',
    ]) {
      assert.equal(countsAsImplementation(file), false, file);
    }
  });

  test('behavior-bearing config is NOT exempt, however JSON it looks', () => {
    // The load-bearing half of the boundary. audit-rules.json is the
    // sensitive-path SSOT: exempting it would let a change widen the allowlist
    // that decides whether that very change is risky.
    for (const file of [
      '.agentrc.json',
      '.agents/schemas/audit-rules.json',
      '.agents/schemas/agentrc.schema.json',
      '.github/workflows/ci.yml',
      'package.json',
      '.agents/scripts/deliver-light.js',
    ]) {
      assert.equal(countsAsImplementation(file), true, file);
    }
  });

  test('the baselines exemption is anchored at the repo root', () => {
    // Generated baseline DATA is exempt; the baseline SCHEMAS are behavior.
    assert.equal(
      countsAsImplementation('baselines/maintainability.json'),
      false,
    );
    assert.equal(
      countsAsImplementation('.agents/schemas/baselines/coverage.schema.json'),
      true,
    );
  });

  test('the companion globs are positive — a ! negation would widen the match', () => {
    // The glob engine treats a leading `!` as negation, which WIDENS rather than
    // narrows, so the behavior-bearing exceptions are expressed by omission.
    // Pinned against the source because the list is deliberately not exported.
    const src = readFileSync(
      path.join(
        REPO_ROOT,
        '.agents',
        'scripts',
        'lib',
        'orchestration',
        'diff-magnitude.js',
      ),
      'utf8',
    );
    const list =
      /const COMPANION_PATH_GLOBS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
    assert.ok(list, 'the companion glob list must be a frozen literal');
    assert.doesNotMatch(list[1], /'!/);
  });
});

describe('summarizeDiffMagnitude — implementation vs companion halves', () => {
  test('splits lines and files by the companion boundary', () => {
    const summary = summarizeDiffMagnitude({
      changedFiles: ['src/a.js', 'tests/a.test.js', 'docs/x.md'],
      rows: rowsOf(
        [100, 20, 'src/a.js'],
        [300, 10, 'tests/a.test.js'],
        [50, 5, 'docs/x.md'],
      ),
    });
    assert.deepEqual(summary, {
      implFiles: 1,
      implLines: 120,
      companionFiles: 2,
      companionLines: 365,
      totalFiles: 3,
    });
  });

  test('additions plus deletions, never net', () => {
    // The trap this contract exists for: measured as net, a large deletion
    // reads as trivial (the merge retiring the planner snapshot is +1119
    // add+del but -803 net).
    const summary = summarizeDiffMagnitude({
      changedFiles: ['src/a.js'],
      rows: rowsOf([8, 1111, 'src/a.js']),
    });
    assert.equal(summary.implLines, 1119);
  });

  test('a test-only change measures zero implementation lines', () => {
    const files = Array.from({ length: 40 }, (_v, i) => `tests/g${i}.test.js`);
    const summary = summarizeDiffMagnitude({
      changedFiles: files,
      rows: rowsOf(...files.map((f) => [200, 0, f])),
    });
    assert.equal(summary.implFiles, 0);
    assert.equal(summary.implLines, 0);
    assert.equal(summary.totalFiles, 40);
  });

  test('an empty diff summarizes to zero, not null', () => {
    assert.deepEqual(summarizeDiffMagnitude({ changedFiles: [], rows: [] }), {
      implFiles: 0,
      implLines: 0,
      companionFiles: 0,
      companionLines: 0,
      totalFiles: 0,
    });
  });

  test('either input missing yields null — the magnitude is unknown', () => {
    assert.equal(
      summarizeDiffMagnitude({ changedFiles: ['a.js'], rows: null }),
      null,
    );
    assert.equal(
      summarizeDiffMagnitude({ changedFiles: null, rows: [] }),
      null,
    );
    assert.equal(summarizeDiffMagnitude(), null);
  });

  test('blank and non-string file entries are dropped from the file tally', () => {
    const summary = summarizeDiffMagnitude({
      changedFiles: ['src/a.js', '', '   ', null, 7],
      rows: rowsOf([1, 1, 'src/a.js']),
    });
    assert.equal(summary.implFiles, 1);
    assert.equal(summary.totalFiles, 1);
  });

  test('a throwing classifier counts everything as implementation, never less', () => {
    // The conservative direction: a classification failure must never shrink
    // the measured magnitude.
    const summary = summarizeDiffMagnitude({
      changedFiles: ['tests/a.test.js'],
      rows: rowsOf([50, 0, 'tests/a.test.js']),
      isCompanionFn: () => {
        throw new Error('boom');
      },
    });
    assert.equal(summary.implFiles, 1);
    assert.equal(summary.implLines, 50);
  });
});
