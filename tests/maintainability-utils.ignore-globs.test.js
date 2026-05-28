import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanDirectory } from '../.agents/scripts/lib/maintainability-utils.js';

/**
 * Story #3217 — configurable `ignoreGlobs` for CRAP/MI baseline file
 * discovery. `scanDirectory` accepts an optional `opts` bag with
 * `ignoreGlobs` (minimatch patterns) and `cwd` (root for relative-path
 * computation). Files whose canonicalised relative path matches any glob
 * are excluded before scoring.
 */

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mi_ignore_globs_'));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function rels(found, base) {
  return found.map((p) => path.relative(base, p).replace(/\\/g, '/')).sort();
}

// ── empty / missing ignoreGlobs is a no-op ────────────────────────────────

test('scanDirectory — absent opts produces same result as no opts', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), '// a');
    fs.writeFileSync(path.join(dir, 'b.ts'), '// b');
    const withoutOpts = scanDirectory(dir)
      .map((p) => path.relative(dir, p))
      .sort();
    const withEmptyOpts = scanDirectory(dir, [], {})
      .map((p) => path.relative(dir, p))
      .sort();
    assert.deepStrictEqual(withEmptyOpts, withoutOpts);
  } finally {
    rmTmp(dir);
  }
});

test('scanDirectory — empty ignoreGlobs is a no-op', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), '// a');
    const baseline = scanDirectory(dir)
      .map((p) => path.relative(dir, p))
      .sort();
    const withEmpty = scanDirectory(dir, [], { ignoreGlobs: [], cwd: dir })
      .map((p) => path.relative(dir, p))
      .sort();
    assert.deepStrictEqual(withEmpty, baseline);
  } finally {
    rmTmp(dir);
  }
});

// ── single glob excludes matching files ───────────────────────────────────

test('scanDirectory — single glob excludes matching files', () => {
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'fixtures'));
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), '// app');
    fs.writeFileSync(path.join(dir, 'fixtures', 'mock.js'), '// mock');

    const found = scanDirectory(dir, [], {
      cwd: dir,
      ignoreGlobs: ['fixtures/**'],
    });
    assert.deepStrictEqual(rels(found, dir), ['src/app.js']);
  } finally {
    rmTmp(dir);
  }
});

test('scanDirectory — single glob with ** prefix excludes deeply nested files', () => {
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'src', '__fixtures__'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'utils', '__fixtures__'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// a');
    fs.writeFileSync(
      path.join(dir, 'src', '__fixtures__', 'fake.js'),
      '// fake1',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'utils', '__fixtures__', 'fake2.js'),
      '// fake2',
    );

    const found = scanDirectory(dir, [], {
      cwd: dir,
      ignoreGlobs: ['**/__fixtures__/**'],
    });
    assert.deepStrictEqual(rels(found, dir), ['src/a.js']);
  } finally {
    rmTmp(dir);
  }
});

// ── multiple globs ────────────────────────────────────────────────────────

test('scanDirectory — multiple globs each exclude their matching files', () => {
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'gen'));
    fs.mkdirSync(path.join(dir, 'fixtures'));
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// a');
    fs.writeFileSync(path.join(dir, 'gen', 'auto.generated.ts'), '// gen');
    fs.writeFileSync(path.join(dir, 'fixtures', 'fake.js'), '// fake');

    const found = scanDirectory(dir, [], {
      cwd: dir,
      ignoreGlobs: ['gen/**', 'fixtures/**'],
    });
    assert.deepStrictEqual(rels(found, dir), ['src/a.js']);
  } finally {
    rmTmp(dir);
  }
});

test('scanDirectory — glob matching *.generated.ts excludes generated files', () => {
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), '// app');
    fs.writeFileSync(path.join(dir, 'src', 'schema.generated.ts'), '// gen');

    const found = scanDirectory(dir, [], {
      cwd: dir,
      ignoreGlobs: ['**/*.generated.ts'],
    });
    assert.deepStrictEqual(rels(found, dir), ['src/app.ts']);
  } finally {
    rmTmp(dir);
  }
});

// ── interaction with targetDirs (scoped exclusion) ────────────────────────

test('scanDirectory — exclusion is scoped within the targetDir root', () => {
  const root = mkTmp();
  try {
    // Simulate a monorepo: app/ and packages/ as separate targetDirs.
    // fixtures/ inside app/ is excluded; fixtures/ inside packages/ is NOT.
    fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'app', 'fixtures'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages', 'lib', 'src'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, 'packages', 'lib', 'fixtures'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, 'app', 'src', 'main.js'), '// main');
    fs.writeFileSync(path.join(root, 'app', 'fixtures', 'fix.js'), '// fix');
    fs.writeFileSync(
      path.join(root, 'packages', 'lib', 'src', 'util.js'),
      '// util',
    );
    fs.writeFileSync(
      path.join(root, 'packages', 'lib', 'fixtures', 'fix2.js'),
      '// fix2',
    );

    // Both targetDirs share the same cwd (repo root) and ignoreGlobs.
    const globs = ['app/fixtures/**'];
    const files = [];
    for (const dir of ['app', 'packages']) {
      const abs = path.resolve(root, dir);
      scanDirectory(abs, files, { cwd: root, ignoreGlobs: globs });
    }
    const found = rels(files, root);
    // app/fixtures/fix.js is excluded; packages/**  is kept.
    assert.ok(
      !found.includes('app/fixtures/fix.js'),
      'app fixture should be excluded',
    );
    assert.ok(
      found.includes('app/src/main.js'),
      'app/src/main.js should be present',
    );
    assert.ok(
      found.includes('packages/lib/src/util.js'),
      'packages util should be present',
    );
    assert.ok(
      found.includes('packages/lib/fixtures/fix2.js'),
      'packages fixture is NOT excluded',
    );
  } finally {
    rmTmp(root);
  }
});

// ── interaction with components (excluded row never in any bucket) ────────

test('scanDirectory — excluded file is absent from calculateAll result', async () => {
  const { calculateAll } = await import(
    '../.agents/scripts/lib/maintainability-utils.js'
  );
  const { groupRows } = await import(
    '../.agents/scripts/lib/baselines/components.js'
  );
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'fixtures'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.js'),
      'export function add(x, y) { return x + y; }\n',
    );
    fs.writeFileSync(
      path.join(dir, 'fixtures', 'stub.js'),
      'export const stub = () => {};\n',
    );

    const files = scanDirectory(dir, [], {
      cwd: dir,
      ignoreGlobs: ['fixtures/**'],
    });
    const scores = await calculateAll(files);

    // 'fixtures/stub.js' must not appear in scores at all.
    assert.ok(
      !Object.keys(scores).some((k) => k.includes('fixtures')),
      'fixtures/stub.js should not appear in scores',
    );

    // Also verify components grouper sees nothing for fixtures.
    const rows = Object.entries(scores).map(([p, mi]) => ({ path: p, mi }));
    const components = { all: ['**'] };
    const grouped = groupRows(rows, components, 'path');
    const allPaths = grouped.all?.map((r) => r.path) ?? [];
    assert.ok(
      !allPaths.some((p) => p.includes('fixtures')),
      'fixtures/stub.js should not appear in any component bucket',
    );
  } finally {
    rmTmp(dir);
  }
});

// ── canonical path matching (Windows separators, worktree prefix) ─────────

test('scanDirectory — worktree-prefix paths canonicalise correctly', () => {
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, '.worktrees', 'story-999', 'src'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// a');
    // The worktree-prefixed dir is inside IGNORED_DIRS (.worktrees), so it won't
    // be walked at all. This test verifies the no-op case where IGNORED_DIRS
    // handles that — ignoreGlobs is orthogonal.
    const found = scanDirectory(dir, [], { cwd: dir, ignoreGlobs: ['src/**'] });
    // src/** should exclude src/a.js.
    assert.deepStrictEqual(rels(found, dir), []);
  } finally {
    rmTmp(dir);
  }
});
