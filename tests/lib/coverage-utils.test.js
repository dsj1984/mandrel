import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildCoverageIndex,
  buildEntryIndex,
  coverageByMethod,
  coverageForMethodInEntry,
  hasCoverageFor,
  loadCoverage,
} from '../../.agents/scripts/lib/coverage-utils.js';

function writeTemp(contents, suffix = '.json') {
  const p = path.join(
    os.tmpdir(),
    `coverage_utils_test_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`,
  );
  fs.writeFileSync(p, contents);
  return p;
}

function makeEntry({ fnStart, fnEnd, statements }) {
  // statements: array of { line, hits }
  const statementMap = {};
  const s = {};
  statements.forEach((stmt, i) => {
    statementMap[String(i)] = {
      start: { line: stmt.line, column: 0 },
      end: { line: stmt.line, column: 10 },
    };
    s[String(i)] = stmt.hits;
  });
  return {
    path: '/abs/file.js',
    fnMap: {
      0: {
        name: 'target',
        decl: {
          start: { line: fnStart, column: 0 },
          end: { line: fnStart, column: 10 },
        },
        loc: {
          start: { line: fnStart, column: 0 },
          end: { line: fnEnd, column: 1 },
        },
      },
    },
    f: { 0: statements.some((st) => st.hits > 0) ? 1 : 0 },
    statementMap,
    s,
    branchMap: {},
    b: {},
  };
}

test('loadCoverage — missing file returns null', () => {
  const missing = path.join(os.tmpdir(), `no_such_${Date.now()}.json`);
  assert.strictEqual(loadCoverage(missing), null);
});

test('loadCoverage — empty / falsy path returns null', () => {
  assert.strictEqual(loadCoverage(''), null);
  assert.strictEqual(loadCoverage(null), null);
  assert.strictEqual(loadCoverage(undefined), null);
});

test('loadCoverage — malformed JSON returns null (no throw)', () => {
  const p = writeTemp('{ this is not json');
  try {
    assert.strictEqual(loadCoverage(p), null);
  } finally {
    fs.unlinkSync(p);
  }
});

test('loadCoverage — JSON that is not an object returns null', () => {
  const p = writeTemp('[1, 2, 3]');
  try {
    assert.strictEqual(loadCoverage(p), null);
  } finally {
    fs.unlinkSync(p);
  }
});

test('loadCoverage — valid coverage-final returns parsed object', () => {
  const map = {
    '/repo/src/a.js': { path: '/repo/src/a.js', fnMap: {}, statementMap: {} },
  };
  const p = writeTemp(JSON.stringify(map));
  try {
    const got = loadCoverage(p);
    assert.deepStrictEqual(got, map);
  } finally {
    fs.unlinkSync(p);
  }
});

test('hasCoverageFor — matches by exact suffix', () => {
  const map = { '/abs/path/to/foo.js': { fnMap: {} } };
  assert.strictEqual(hasCoverageFor(map, 'path/to/foo.js'), true);
  assert.strictEqual(hasCoverageFor(map, 'to/foo.js'), true);
});

test('hasCoverageFor — tolerates Windows-style backslashes on either side', () => {
  const map = { 'C:\\repo\\src\\foo.js': { fnMap: {} } };
  assert.strictEqual(hasCoverageFor(map, 'src/foo.js'), true);
  assert.strictEqual(hasCoverageFor(map, 'src\\foo.js'), true);
});

test('hasCoverageFor — no match returns false', () => {
  const map = { '/abs/path/to/foo.js': { fnMap: {} } };
  assert.strictEqual(hasCoverageFor(map, 'bar.js'), false);
  assert.strictEqual(hasCoverageFor(null, 'foo.js'), false);
  assert.strictEqual(hasCoverageFor({}, ''), false);
});

test('hasCoverageFor — avoids false-positive partial filename match', () => {
  // 'oo.js' is a suffix of 'foo.js' as a string, but not as a path segment.
  const map = { '/abs/path/to/foo.js': { fnMap: {} } };
  assert.strictEqual(hasCoverageFor(map, 'oo.js'), false);
});

test('coverageForMethodInEntry — all statements hit returns 1.0', () => {
  const entry = makeEntry({
    fnStart: 10,
    fnEnd: 14,
    statements: [
      { line: 11, hits: 1 },
      { line: 12, hits: 3 },
      { line: 13, hits: 1 },
    ],
  });
  assert.strictEqual(coverageForMethodInEntry(entry, 10), 1);
});

test('coverageForMethodInEntry — no statements hit returns 0', () => {
  const entry = makeEntry({
    fnStart: 10,
    fnEnd: 14,
    statements: [
      { line: 11, hits: 0 },
      { line: 12, hits: 0 },
    ],
  });
  assert.strictEqual(coverageForMethodInEntry(entry, 10), 0);
});

test('coverageForMethodInEntry — partial coverage returns fractional ratio', () => {
  const entry = makeEntry({
    fnStart: 10,
    fnEnd: 14,
    statements: [
      { line: 11, hits: 1 },
      { line: 12, hits: 0 },
      { line: 13, hits: 1 },
      { line: 14, hits: 0 },
    ],
  });
  assert.strictEqual(coverageForMethodInEntry(entry, 10), 0.5);
});

test('coverageForMethodInEntry — statements outside function loc are ignored', () => {
  const entry = makeEntry({
    fnStart: 10,
    fnEnd: 12,
    statements: [
      { line: 11, hits: 1 },
      // these fall outside the function and must not dilute the ratio
      { line: 50, hits: 0 },
      { line: 60, hits: 0 },
    ],
  });
  assert.strictEqual(coverageForMethodInEntry(entry, 10), 1);
});

test('coverageForMethodInEntry — off-line-number returns null', () => {
  const entry = makeEntry({
    fnStart: 10,
    fnEnd: 14,
    statements: [{ line: 11, hits: 1 }],
  });
  assert.strictEqual(coverageForMethodInEntry(entry, 7), null);
  assert.strictEqual(coverageForMethodInEntry(entry, 11), null);
});

test('coverageForMethodInEntry — empty / missing entry returns null', () => {
  assert.strictEqual(coverageForMethodInEntry(null, 10), null);
  assert.strictEqual(coverageForMethodInEntry(undefined, 10), null);
  assert.strictEqual(coverageForMethodInEntry({}, 10), null);
});

test('coverageForMethodInEntry — function with zero statements in range returns 0', () => {
  const entry = makeEntry({ fnStart: 10, fnEnd: 12, statements: [] });
  assert.strictEqual(coverageForMethodInEntry(entry, 10), 0);
});

test('coverageByMethod — resolves by relative path then delegates to entry lookup', () => {
  const entry = makeEntry({
    fnStart: 5,
    fnEnd: 8,
    statements: [
      { line: 6, hits: 1 },
      { line: 7, hits: 0 },
    ],
  });
  const map = { '/repo/src/thing.js': entry };
  assert.strictEqual(coverageByMethod(map, 'src/thing.js', 5), 0.5);
});

test('coverageByMethod — file not in map returns null', () => {
  const map = {
    '/repo/src/thing.js': makeEntry({
      fnStart: 5,
      fnEnd: 8,
      statements: [{ line: 6, hits: 1 }],
    }),
  };
  assert.strictEqual(coverageByMethod(map, 'src/other.js', 5), null);
});

test('coverageByMethod — null map returns null', () => {
  assert.strictEqual(coverageByMethod(null, 'src/x.js', 1), null);
});

test('buildCoverageIndex — null/array map yields an empty index', () => {
  assert.deepStrictEqual(buildCoverageIndex(null).byNormalizedSuffix.size, 0);
  assert.deepStrictEqual(buildCoverageIndex([]).byNormalizedSuffix.size, 0);
  assert.deepStrictEqual(
    buildCoverageIndex(undefined).byNormalizedSuffix.size,
    0,
  );
});

test('buildEntryIndex — null/non-object entry yields empty maps', () => {
  for (const bad of [null, undefined, 42, 'abc']) {
    const idx = buildEntryIndex(bad);
    assert.strictEqual(idx.fnByStartLine.size, 0);
    assert.strictEqual(idx.fnLocByStartLine.size, 0);
    assert.strictEqual(idx.statementsByLine.size, 0);
  }
});

test('buildEntryIndex — indexes a function whose decl line differs from its loc line', () => {
  const entry = {
    fnMap: {
      0: {
        name: 'wrapped',
        decl: { start: { line: 7, column: 0 } },
        loc: { start: { line: 9, column: 0 }, end: { line: 12, column: 1 } },
      },
    },
    statementMap: {
      0: { start: { line: 10, column: 0 }, end: { line: 10, column: 5 } },
    },
    s: { 0: 1 },
  };
  const idx = buildEntryIndex(entry);
  // Both decl line (7) and loc line (9) must resolve to the same fn entry so
  // callers keying by escomplex's `lineStart` (which can match either) hit.
  assert.strictEqual(idx.fnByStartLine.has(7), true);
  assert.strictEqual(idx.fnByStartLine.has(9), true);
  assert.strictEqual(idx.statementsByLine.size, 1);
});

test('buildEntryIndex — skips functions with no usable start line', () => {
  const entry = {
    fnMap: {
      0: { name: 'broken', decl: {}, loc: {} },
    },
    statementMap: {},
    s: {},
  };
  const idx = buildEntryIndex(entry);
  assert.strictEqual(idx.fnByStartLine.size, 0);
});

test('buildEntryIndex — statements without a numeric start line are dropped', () => {
  const entry = {
    fnMap: {},
    statementMap: {
      0: { start: { column: 0 }, end: { line: 1, column: 5 } },
      1: { start: { line: 5, column: 0 }, end: { line: 5, column: 5 } },
    },
    s: { 0: 1, 1: 0 },
  };
  const idx = buildEntryIndex(entry);
  assert.strictEqual(idx.statementsByLine.size, 1);
  const bucket = idx.statementsByLine.get(5);
  assert.deepStrictEqual(bucket, { total: 1, covered: 0 });
});

test('hasCoverageFor — Object.keys(map) called exactly once across 1000 lookups (O(1) per lookup after build)', () => {
  const map = {};
  for (let i = 0; i < 1000; i += 1) {
    map[`/repo/src/file${i}.js`] = { fnMap: {}, statementMap: {}, s: {} };
  }
  const originalKeys = Object.keys;
  let callsForMap = 0;
  Object.keys = function patched(obj) {
    if (obj === map) callsForMap += 1;
    return originalKeys.call(Object, obj);
  };
  try {
    for (let i = 0; i < 1000; i += 1) {
      assert.strictEqual(hasCoverageFor(map, `/repo/src/file${i}.js`), true);
    }
  } finally {
    Object.keys = originalKeys;
  }
  assert.strictEqual(
    callsForMap,
    1,
    `Expected Object.keys(map) to be called exactly once, got ${callsForMap}`,
  );
});
