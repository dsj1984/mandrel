// tests/c8rc-scope.test.js
//
// Story #4922 — the coverage scope is a contract between three files that
// must agree, and it used to be declared twice inside one of them.
//
//   1. `.c8rc.cjs`      — what `c8 report` instruments and prints.
//   2. `.agentrc.json`  — `delivery.quality.gates.<crap|maintainability|
//                          duplication>.targetDirs`, the configured target
//                          directories the quality gates police. The
//                          coverage gate's own schema is closed and carries
//                          no `targetDirs` of its own (see
//                          `lib/config/gates/coverage.schema.js`), so these
//                          are the repository's target-dir declaration — and
//                          the CRAP gate joins coverage rows with complexity
//                          rows across exactly this set, so a file c8 does
//                          not measure silently drops out of that join.
//   3. each excluded source — its `node:coverage ignore file` pragma, the
//                          second line of defence when the two configs are
//                          read from different cwds.
//
// When (1) and (2) drift, the gate polices a surface the reporter never
// measured — which is exactly how a coverage instrument reports green over
// code it has never executed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';

import { rollup } from '../.agents/scripts/lib/baselines/kinds/coverage.js';
import { buildScopePredicate } from '../.agents/scripts/lib/coverage-baseline.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const C8RC_PATH = path.join(REPO_ROOT, '.c8rc.cjs');

const c8rc = require(C8RC_PATH);
const agentrc = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.agentrc.json'), 'utf8'),
);
const gates = agentrc.delivery?.quality?.gates ?? {};
const TARGET_DIR_GATES = ['crap', 'maintainability', 'duplication'];

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs']);

/**
 * Every source file c8 is configured to instrument, walked from the same
 * include/exclude declaration `c8 report` is handed. Mirrors the scope
 * predicate rather than restating it.
 */
function enumerateInScopeSources() {
  const inScope = buildScopePredicate({
    include: c8rc.include,
    exclude: c8rc.exclude,
  });
  const roots = c8rc.include.map((g) => g.replace(/\/\*\*$/, ''));
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(REPO_ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        walk(rel);
      } else if (SOURCE_EXT.has(path.extname(ent.name)) && inScope(rel)) {
        out.push(rel);
      }
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

describe('.c8rc.cjs — declared scope matches the configured target dirs', () => {
  test('the coverage gate is configured at all', () => {
    // A missing `coverage` block makes `check-baselines.js --gate coverage`
    // select zero gates and exit 0 unconditionally (Story #4922).
    assert.ok(
      gates.coverage && typeof gates.coverage === 'object',
      'delivery.quality.gates.coverage must be configured',
    );
    assert.ok(gates.coverage.floors?.['*'], 'coverage needs a `*` floor');
  });

  test('the target-dir declaration is consistent across every gate', () => {
    const declared = TARGET_DIR_GATES.map((k) => gates[k]?.targetDirs);
    for (const [i, dirs] of declared.entries()) {
      assert.ok(
        Array.isArray(dirs) && dirs.length > 0,
        `gate ${TARGET_DIR_GATES[i]} must declare targetDirs`,
      );
      assert.deepEqual(
        [...dirs].sort(),
        [...declared[0]].sort(),
        `gate ${TARGET_DIR_GATES[i]} polices a different target-dir set than ` +
          `${TARGET_DIR_GATES[0]} — the CRAP join reads coverage and ` +
          'complexity over one surface, not two',
      );
    }
  });

  test('every c8 include glob is a configured target dir', () => {
    const includeRoots = c8rc.include.map((g) => g.replace(/\/\*\*$/, ''));
    assert.deepEqual(
      [...includeRoots].sort(),
      [...gates[TARGET_DIR_GATES[0]].targetDirs].sort(),
      'the c8 include globs and the configured quality-gate targetDirs name ' +
        'different roots — the gates would police a surface c8 never measured',
    );
  });

  test('every c8 include glob is a recursive root glob', () => {
    for (const glob of c8rc.include) {
      assert.match(
        glob,
        /\/\*\*$/,
        `include glob ${glob} must end in /** so the whole root is measured`,
      );
    }
  });

  test('every configured target dir exists on disk', () => {
    for (const dir of gates[TARGET_DIR_GATES[0]].targetDirs) {
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, dir)),
        `targetDir ${dir} does not exist`,
      );
    }
  });

  test('c8 measures every in-scope source file (all: true)', () => {
    // Without `all`, a module no test loads is absent from
    // coverage-final.json entirely — no row, no floor, nothing to regress.
    assert.equal(
      c8rc.all,
      true,
      '.c8rc.cjs must set `all: true` so an unloaded source file scores 0 ' +
        'rather than vanishing from the measurement',
    );
  });
});

describe('baselines/coverage.json covers exactly the declared scope', () => {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'baselines', 'coverage.json'), 'utf8'),
  );
  const inScope = enumerateInScopeSources();
  const rowPaths = new Set(baseline.rows.map((r) => r.path));

  test('no row names a path absent from the tree', () => {
    const ghosts = baseline.rows
      .map((r) => r.path)
      .filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
    assert.deepEqual(
      ghosts,
      [],
      `${ghosts.length} baseline rows name files that no longer exist. A ` +
        'baseline scored against a deleted tree is not a measurement; ' +
        're-run `npm run test:coverage && npm run coverage:update -- --full-scope`.',
    );
  });

  test('every in-scope source file has a row', () => {
    const missing = inScope.filter((f) => !rowPaths.has(f));
    assert.deepEqual(
      missing,
      [],
      `${missing.length} in-scope source files have no baseline row, so they ` +
        'have no floor and nothing to regress against.',
    );
  });

  test('the floors police the arithmetic mean of the rows, never a stored rollup', () => {
    // Story #5400 — a persisted rollup could drift from its rows, and then the
    // gate policed a number nothing produced. The baseline no longer carries
    // one; the floors read the kind's rollup derived from the rows.
    assert.equal(
      Object.hasOwn(baseline, 'rollup'),
      false,
      'baselines/coverage.json must not persist a `rollup` — it is derived',
    );
    const derived = rollup(baseline.rows)['*'];
    for (const axis of ['lines', 'branches', 'functions']) {
      const mean =
        baseline.rows.reduce((s, r) => s + (r[axis] ?? 0), 0) /
        baseline.rows.length;
      assert.ok(
        Math.abs(mean - derived[axis]) < 0.01,
        `derived rollup["*"].${axis}=${derived[axis]} does not match the ` +
          `row mean ${mean.toFixed(2)}`,
      );
    }
  });
});

describe('.c8rc.cjs — the scope is declared exactly once', () => {
  const source = fs.readFileSync(C8RC_PATH, 'utf8');

  test('no exclude path is restated anywhere else in the file', () => {
    // The header used to carry a prose inventory of the exclude list, so the
    // scope was declared twice in one file and the copies drifted (27 files
    // apart by the time Story #4922 measured it). Rationale now lives inline
    // next to the path it justifies, where it cannot drift.
    const restated = c8rc.exclude.filter(
      (entry) => source.split(entry).length - 1 !== 1,
    );
    assert.deepEqual(
      restated,
      [],
      `these exclude paths appear more than once in .c8rc.cjs — the scope is ` +
        `declared twice: ${restated.join(', ')}`,
    );
  });

  test('every exclude entry carries a rationale comment', () => {
    const lines = source.split('\n');
    for (const entry of c8rc.exclude) {
      const idx = lines.findIndex((l) => l.includes(`'${entry}'`));
      assert.ok(idx > 0, `exclude entry ${entry} not found as a literal line`);
      // Walk back over the contiguous run of comment lines and sibling path
      // literals; at least one comment must govern the group.
      let cursor = idx - 1;
      let rationale = false;
      while (cursor >= 0) {
        const line = lines[cursor].trim();
        if (line.startsWith('//')) {
          rationale = true;
          break;
        }
        if (!line.startsWith("'")) break;
        cursor -= 1;
      }
      assert.ok(
        rationale,
        `exclude entry ${entry} has no inline rationale — a bare path with ` +
          `no justification is a review block`,
      );
    }
  });
});

describe('.c8rc.cjs — excluded files carry the source-side pragma', () => {
  test('every excluded file exists and declares node:coverage ignore file', () => {
    const missing = [];
    const unpragmad = [];
    for (const entry of c8rc.exclude) {
      if (entry.includes('*')) continue; // directory globs have no single source
      const abs = path.join(REPO_ROOT, entry);
      if (!fs.existsSync(abs)) {
        missing.push(entry);
        continue;
      }
      if (!fs.readFileSync(abs, 'utf8').includes('node:coverage ignore file')) {
        unpragmad.push(entry);
      }
    }
    assert.deepEqual(missing, [], `excluded paths not on disk: ${missing}`);
    assert.deepEqual(
      unpragmad,
      [],
      `excluded files missing the /* node:coverage ignore file */ pragma: ${unpragmad}`,
    );
  });

  // The converse does NOT hold and must not be asserted: many in-scope files
  // carry the pragma without being c8-excluded. The pragma only governs
  // Node's built-in `--experimental-test-coverage`; c8 reads V8's dumps and
  // still measures those files. Promoting every pragma'd file into
  // `exclude[]` would SHRINK the measured surface — the opposite of what
  // Story #4922 exists to fix.
});
