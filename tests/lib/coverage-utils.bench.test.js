import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { coverageForMethodInEntry } from '../../.agents/scripts/lib/coverage-utils.js';

// Legacy implementation copied verbatim from coverage-utils.js prior to the
// per-entry index — used as the comparison baseline for the benchmark.
function legacyCoverageForMethodInEntry(entry, startLine) {
  if (!entry || typeof entry !== 'object') return null;
  const fnMap = entry.fnMap ?? {};
  const statementMap = entry.statementMap ?? {};
  const statementHits = entry.s ?? {};

  let fn = null;
  for (const fnId of Object.keys(fnMap)) {
    const f = fnMap[fnId];
    const declLine = f?.decl?.start?.line;
    const locLine = f?.loc?.start?.line;
    if (declLine === startLine || locLine === startLine) {
      fn = f;
      break;
    }
  }
  if (!fn) return null;

  const fnStart = fn.loc?.start?.line ?? fn.decl?.start?.line ?? null;
  const fnEnd = fn.loc?.end?.line ?? null;
  if (fnStart === null || fnEnd === null) return null;

  let total = 0;
  let covered = 0;
  for (const stmtId of Object.keys(statementMap)) {
    const stmt = statementMap[stmtId];
    const sLine = stmt?.start?.line;
    if (typeof sLine !== 'number') continue;
    if (sLine < fnStart || sLine > fnEnd) continue;
    total += 1;
    if ((statementHits[stmtId] ?? 0) > 0) covered += 1;
  }
  if (total === 0) return 0;
  return covered / total;
}

function buildSyntheticEntry(methodCount, statementCount) {
  const fnMap = {};
  const statementMap = {};
  const s = {};
  const linesPerMethod = Math.max(1, Math.ceil(statementCount / methodCount));
  const methodStarts = [];
  let nextLine = 1;
  for (let m = 0; m < methodCount; m += 1) {
    const fnStart = nextLine;
    const fnEnd = fnStart + linesPerMethod - 1;
    fnMap[String(m)] = {
      name: `m${m}`,
      decl: {
        start: { line: fnStart, column: 0 },
        end: { line: fnStart, column: 1 },
      },
      loc: {
        start: { line: fnStart, column: 0 },
        end: { line: fnEnd, column: 1 },
      },
    };
    methodStarts.push(fnStart);
    nextLine = fnEnd + 1;
  }
  let stmtIdx = 0;
  for (let m = 0; m < methodCount && stmtIdx < statementCount; m += 1) {
    const fn = fnMap[String(m)];
    for (
      let line = fn.loc.start.line;
      line <= fn.loc.end.line && stmtIdx < statementCount;
      line += 1
    ) {
      const id = String(stmtIdx);
      statementMap[id] = {
        start: { line, column: 0 },
        end: { line, column: 1 },
      };
      s[id] = stmtIdx % 2;
      stmtIdx += 1;
    }
  }
  return {
    entry: { fnMap, statementMap, s, branchMap: {}, b: {}, f: {} },
    methodStarts,
  };
}

function timeBest(fn, iterations) {
  // JIT warm-up.
  for (let i = 0; i < 5; i += 1) fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < iterations; i += 1) {
    const t = performance.now();
    fn();
    const dt = performance.now() - t;
    if (dt < best) best = dt;
  }
  return best;
}

test('coverageForMethodInEntry — indexed path is ≥5× faster than legacy on 50-method / 500-statement entry', () => {
  const METHOD_COUNT = 50;
  const STATEMENT_COUNT = 500;
  const ITERATIONS = 50;

  const { entry, methodStarts } = buildSyntheticEntry(
    METHOD_COUNT,
    STATEMENT_COUNT,
  );

  // Pre-warm the per-entry index cache so the timed loop reflects the
  // amortized "consecutive lookups in the same file" path.
  for (const startLine of methodStarts) {
    coverageForMethodInEntry(entry, startLine);
  }

  // Sanity: indexed and legacy paths agree on every method's ratio.
  for (const startLine of methodStarts) {
    assert.strictEqual(
      coverageForMethodInEntry(entry, startLine),
      legacyCoverageForMethodInEntry(entry, startLine),
    );
  }

  const newTime = timeBest(() => {
    for (const startLine of methodStarts) {
      coverageForMethodInEntry(entry, startLine);
    }
  }, ITERATIONS);

  const oldTime = timeBest(() => {
    for (const startLine of methodStarts) {
      legacyCoverageForMethodInEntry(entry, startLine);
    }
  }, ITERATIONS);

  const ratio = newTime > 0 ? oldTime / newTime : Number.POSITIVE_INFINITY;
  assert.ok(
    ratio >= 5,
    `Expected indexed path to be ≥5× faster; legacy=${oldTime.toFixed(4)}ms new=${newTime.toFixed(4)}ms ratio=${ratio.toFixed(2)}×`,
  );
});
