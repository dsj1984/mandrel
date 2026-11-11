import assert from 'node:assert';
import { test } from 'node:test';
import { rollup } from '../.agents/scripts/lib/baselines/kinds/coverage.js';
import {
  scoreEntry,
  writeBaseline,
} from '../.agents/scripts/lib/coverage-baseline.js';

/**
 * Story #6044: an axis with no denominator (0/0) persists as 100, the
 * istanbul/c8 convention, not 0. A 0 would score a branch-free file as
 * fully uncovered and drag the unweighted `*` rollup below its floor.
 */

function persist(entries) {
  let written = null;
  const fakeFs = {
    mkdirSync: () => {},
    writeFileSync: (_path, content) => {
      written = content;
    },
  };
  const scored = Object.fromEntries(
    Object.entries(entries).map(([file, entry]) => [file, scoreEntry(entry)]),
  );
  writeBaseline('/cwd', scored, fakeFs, { prior: null });
  return JSON.parse(written).rows;
}

const rowOf = (rows, file) => rows.find((r) => r.path === file);

test('a file with no branches persists branches: 100', () => {
  const rows = persist({
    'flat.js': { s: { 0: 1, 1: 3 }, b: {}, f: { 0: 1 } },
  });
  assert.deepStrictEqual(rowOf(rows, 'flat.js'), {
    path: 'flat.js',
    lines: 100,
    branches: 100,
    functions: 100,
  });
});

test('a file with no functions or statements persists 100 on those axes', () => {
  const rows = persist({
    'consts.js': { s: { 0: 1 }, b: { 0: [1, 0] }, f: {} },
    'types-only.js': { s: {}, b: {}, f: {} },
  });
  assert.strictEqual(rowOf(rows, 'consts.js').functions, 100);
  assert.strictEqual(rowOf(rows, 'consts.js').branches, 50);
  assert.strictEqual(rowOf(rows, 'types-only.js').lines, 100);
});

test('real 0/N coverage still persists 0', () => {
  const rows = persist({
    'untested.js': { s: { 0: 0, 1: 0 }, b: { 0: [0, 0] }, f: { 0: 0 } },
  });
  assert.deepStrictEqual(rowOf(rows, 'untested.js'), {
    path: 'untested.js',
    lines: 0,
    branches: 0,
    functions: 0,
  });
});

test('the * rollup over a branch-free row and a 50% row is 75, not 25', () => {
  const rows = persist({
    'flat.js': { s: { 0: 1 }, b: {}, f: { 0: 1 } },
    'half.js': { s: { 0: 1 }, b: { 0: [1, 0] }, f: { 0: 1 } },
  });
  assert.strictEqual(rollup(rows)['*'].branches, 75);
});
