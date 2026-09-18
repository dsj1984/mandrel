// tests/lib/baselines/scope-inventory.test.js
/**
 * Story #5012 — the shared in-scope inventory behind the baseline honesty
 * surface.
 *
 * The load-bearing property is not "it lists files". It is that each kind's
 * file set is recomputed from **the same configuration its refresh scorer
 * reads**, through the same helpers — `.c8rc.cjs` include/exclude via
 * `buildScopePredicate` for coverage, `delivery.quality.gates.<kind>`
 * `targetDirs`/`ignoreGlobs` via `scanDirectory` for the rest. A second walker
 * written for the gate would report the two implementations disagreeing as
 * divergence, which is the failure `check-baseline-drift.js` already avoids by
 * re-scoring through the producer's own scorer.
 *
 * So the fixtures below deliberately encode scope decisions ONLY in those two
 * config surfaces, and assert the inventory follows them — including the
 * negative direction, where a file present on disk is excluded because the
 * config says so.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import {
  buildScopeInventory,
  deriveWalkRoots,
  directionsFor,
  isFileKeyed,
  KIND_SCOPE_POLICY,
  keyFieldFor,
  SCOPE_KINDS,
} from '../../../scripts/lib/baselines/scope-inventory.js';

const TMP = fs.realpathSync(makeTempDir('scope-inventory-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Monotonic fixture counter so each case gets its own require-cache slot. */
let fixtureSeq = 0;

/**
 * Materialise a throwaway repo.
 *
 * @param {{ files: Record<string, string>, c8rc?: object }} spec
 * @returns {string} Absolute fixture root.
 */
function fixture({ files, c8rc }) {
  fixtureSeq += 1;
  const root = path.join(TMP, `repo-${fixtureSeq}`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (c8rc !== undefined) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, '.c8rc.cjs'),
      `module.exports = ${JSON.stringify(c8rc, null, 2)};\n`,
    );
  }
  return root;
}

const SOURCE = 'export function noop() {\n  return 1;\n}\n';

describe('buildScopeInventory — coverage reads .c8rc.cjs, not a second walker', () => {
  test('the coverage set is exactly what .c8rc.cjs include/exclude admits', () => {
    const cwd = fixture({
      files: {
        'src/kept.js': SOURCE,
        'src/nested/also-kept.js': SOURCE,
        'src/__tests__/dropped.js': SOURCE,
        'vendor/outside.js': SOURCE,
      },
      c8rc: { include: ['src/**'], exclude: ['src/__tests__/**'] },
    });

    const inventory = buildScopeInventory({ kind: 'coverage', cwd });

    assert.equal(inventory.degraded, false);
    assert.deepEqual(inventory.files.sort(), [
      'src/kept.js',
      'src/nested/also-kept.js',
    ]);
    // `vendor/` is on disk and never walked: the roots come from the literal
    // prefixes of `include`, so scope decides the walk rather than the walk
    // deciding scope.
    assert.deepEqual(inventory.roots, ['src']);
  });

  test('a file dropped ONLY by an exclude glob is absent from the inventory', () => {
    const withoutExclude = buildScopeInventory({
      kind: 'coverage',
      cwd: fixture({
        files: { 'src/a.js': SOURCE, 'src/generated.js': SOURCE },
        c8rc: { include: ['src/**'], exclude: [] },
      }),
    });
    const withExclude = buildScopeInventory({
      kind: 'coverage',
      cwd: fixture({
        files: { 'src/a.js': SOURCE, 'src/generated.js': SOURCE },
        c8rc: { include: ['src/**'], exclude: ['src/generated.js'] },
      }),
    });

    assert.deepEqual(withoutExclude.files.sort(), [
      'src/a.js',
      'src/generated.js',
    ]);
    assert.deepEqual(withExclude.files, ['src/a.js']);
  });

  test('an unreadable .c8rc.cjs degrades to unknown scope, never to empty scope', () => {
    const cwd = fixture({ files: { 'src/a.js': SOURCE } });

    const inventory = buildScopeInventory({ kind: 'coverage', cwd });

    // `files: null` and `files: []` are opposite claims. Empty would mean
    // "every committed row is out of scope", which hands the pruner the whole
    // baseline; null means "scope unknown", which suspends the judgement.
    assert.equal(inventory.files, null);
    assert.equal(inventory.degraded, true);
    assert.match(inventory.reason, /\.c8rc\.cjs unreadable/);
  });

  test('a .c8rc.cjs declaring no include globs degrades rather than walking the repo', () => {
    const cwd = fixture({
      files: { 'src/a.js': SOURCE },
      c8rc: { include: [], exclude: [] },
    });

    const inventory = buildScopeInventory({ kind: 'coverage', cwd });

    assert.equal(inventory.files, null);
    assert.equal(inventory.degraded, true);
    assert.match(inventory.reason, /no include globs/);
  });
});

describe('buildScopeInventory — targetDirs kinds read the gate block', () => {
  const quality = {
    gates: {
      maintainability: {
        targetDirs: ['src', 'bin'],
        ignoreGlobs: ['src/**/__tests__/**', 'src/schema/*.schema.js'],
      },
    },
  };

  test('the maintainability set is targetDirs walked minus ignoreGlobs', () => {
    const cwd = fixture({
      files: {
        'src/a.js': SOURCE,
        'src/deep/b.js': SOURCE,
        'src/__tests__/t.js': SOURCE,
        'src/schema/one.schema.js': SOURCE,
        'bin/cli.js': SOURCE,
        'docs/not-a-target.js': SOURCE,
      },
    });

    const inventory = buildScopeInventory({
      kind: 'maintainability',
      cwd,
      quality,
    });

    assert.equal(inventory.degraded, false);
    assert.deepEqual(inventory.files.sort(), [
      'bin/cli.js',
      'src/a.js',
      'src/deep/b.js',
    ]);
    assert.deepEqual(inventory.roots, ['src', 'bin']);
  });

  test('an ignoreGlob is the ONLY reason a walked file is dropped', () => {
    const files = {
      'src/a.js': SOURCE,
      'src/schema/one.schema.js': SOURCE,
    };
    const withIgnore = buildScopeInventory({
      kind: 'maintainability',
      cwd: fixture({ files }),
      quality,
    });
    const withoutIgnore = buildScopeInventory({
      kind: 'maintainability',
      cwd: fixture({ files }),
      quality: { gates: { maintainability: { targetDirs: ['src'] } } },
    });

    assert.deepEqual(withIgnore.files, ['src/a.js']);
    assert.deepEqual(withoutIgnore.files.sort(), [
      'src/a.js',
      'src/schema/one.schema.js',
    ]);
  });

  test('an absent targetDirs declaration degrades to unknown scope', () => {
    const inventory = buildScopeInventory({
      kind: 'crap',
      cwd: fixture({ files: { 'src/a.js': SOURCE } }),
      quality: { gates: {} },
    });

    assert.equal(inventory.files, null);
    assert.equal(inventory.degraded, true);
    assert.match(inventory.reason, /gates\.crap\.targetDirs/);
  });

  test('a non-file-keyed kind resolves to no inventory at all', () => {
    const inventory = buildScopeInventory({
      kind: 'lighthouse',
      cwd: fixture({ files: { 'src/a.js': SOURCE } }),
      quality: { gates: { lighthouse: { targetDirs: ['src'] } } },
    });

    assert.equal(inventory.files, null);
    assert.equal(inventory.degraded, false);
    assert.equal(inventory.keyField, 'route');
    assert.match(inventory.reason, /not file-keyed/);
  });
});

describe('deriveWalkRoots — literal prefixes of the include globs', () => {
  test('trims each pattern at its first glob segment', () => {
    assert.deepEqual(
      deriveWalkRoots(['.agents/scripts/**', 'bin/**', 'lib/**']),
      ['.agents/scripts', 'bin', 'lib'],
    );
  });

  test('a pattern that is glob from the first segment walks the repo root', () => {
    assert.deepEqual(deriveWalkRoots(['**/*.js']), ['.']);
  });

  test('de-duplicates roots and ignores non-string entries', () => {
    assert.deepEqual(deriveWalkRoots(['lib/**', 'lib/*.js', '', 7, null]), [
      'lib',
    ]);
  });
});

describe('KIND_SCOPE_POLICY — the classification the gate is built on', () => {
  test('every kind carries a keyField and a direction list', () => {
    for (const kind of SCOPE_KINDS) {
      assert.equal(typeof keyFieldFor(kind), 'string');
      assert.ok(Array.isArray(KIND_SCOPE_POLICY[kind].directions));
    }
  });

  test('an unknown kind asserts nothing rather than defaulting to both', () => {
    assert.deepEqual(directionsFor('not-a-kind'), []);
    assert.equal(isFileKeyed('not-a-kind'), false);
  });
});
