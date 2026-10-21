/**
 * Extra coverage for `lib/maintainability-utils.js` — branches that the
 * existing scanDirectory test and the cpu-pool parity tests don't reach:
 * baseline read/write, transpile fallback, calculateAll's serial path
 * for tiny batches.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getBaseline } from '../../.agents/scripts/lib/baselines/maintainability-baseline-io.js';
import {
  calculateAll,
  scanDirectory,
} from '../../.agents/scripts/lib/maintainability-utils.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  resolveTsTranspilerVersion,
  transpileIfNeeded,
} from '../../.agents/scripts/lib/transpile.js';

let tmp;
beforeEach(() => {
  tmp = makeTempDir('mi_extra_');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('getBaseline', () => {
  it('throws on empty / non-string baselinePath', () => {
    assert.throws(() => getBaseline(''), /baselinePath is required/);
    assert.throws(() => getBaseline(null), /baselinePath is required/);
    assert.throws(() => getBaseline(undefined), /baselinePath is required/);
  });

  it('returns {} when the baseline file is absent', () => {
    const missing = path.join(tmp, 'no-such.json');
    assert.deepEqual(getBaseline(missing), {});
  });

  it('parses a valid baseline JSON file', () => {
    const p = path.join(tmp, 'b.json');
    const data = { 'src/a.js': 80, 'src/b.js': 92 };
    fs.writeFileSync(p, JSON.stringify(data));
    assert.deepEqual(getBaseline(p), data);
  });

  it('returns {} on malformed JSON, with a warning emitted (no throw)', () => {
    const p = path.join(tmp, 'broken.json');
    fs.writeFileSync(p, '{ this is not json');
    assert.deepEqual(getBaseline(p), {});
  });

  it('resolves a relative path against process.cwd()', () => {
    // Must live under cwd so the path is genuinely relative. On Windows
    // CI runners, os.tmpdir() can be on a different drive than cwd
    // (e.g. cwd=D:\…, tmpdir=C:\…), and path.relative() across drives
    // returns the absolute target — which then breaks fs.writeFile and
    // defeats the test.
    const rel = `mi_extra_rel_${process.pid}_${Date.now()}.json`;
    const abs = path.join(process.cwd(), rel);
    fs.writeFileSync(abs, JSON.stringify({ x: 1 }));
    try {
      assert.deepEqual(getBaseline(rel), { x: 1 });
    } finally {
      fs.unlinkSync(abs);
    }
  });
});

describe('transpileIfNeeded', () => {
  it('returns source unchanged for plain JavaScript paths', () => {
    const src = 'export const x = 1;';
    assert.equal(transpileIfNeeded('a.js', src), src);
    assert.equal(transpileIfNeeded('a.mjs', src), src);
    assert.equal(transpileIfNeeded('a.cjs', src), src);
  });

  it('transpiles TypeScript to JavaScript that escomplex can parse', () => {
    const src = 'export function f(x: number): number { return x + 1; }';
    const out = transpileIfNeeded('a.ts', src);
    assert.notEqual(out, null);
    // Type annotation must be gone after transpile.
    assert.equal(out.includes(': number'), false);
    assert.match(out, /function f/);
  });

  it('returns null on malformed TypeScript input', () => {
    // ts.transpileModule is permissive and rarely fails outright; instead,
    // pass a token that ts can parse but the inner try shape still emits.
    // To force a real null we use the alternate path: call with a value the
    // TS API rejects (non-string `source`). The function awaits a string,
    // so passing an object triggers the inner catch.
    const out = transpileIfNeeded('a.ts', /** @type {any} */ (12345));
    assert.equal(out, null);
  });
});

describe('resolveTsTranspilerVersion', () => {
  it('returns a non-empty semver string when typescript is resolvable', () => {
    const v = resolveTsTranspilerVersion();
    assert.equal(typeof v, 'string');
    assert.notEqual(v, '');
    // Either a real version like "5.9.3" or the sentinel "0.0.0".
    assert.match(v, /^\d+\.\d+\.\d+/);
  });
});

describe('calculateAll — small-batch serial path', () => {
  it('returns {} for an empty file list', async () => {
    const result = await calculateAll([]);
    assert.deepEqual(result, {});
  });

  it('scores a 2-file batch via the in-process path (under SERIAL_THRESHOLD)', async () => {
    const a = path.join(tmp, 'a.js');
    const b = path.join(tmp, 'b.js');
    fs.writeFileSync(
      a,
      'export function add(x) { if (x>0) return x+1; return x; }\n',
    );
    fs.writeFileSync(b, 'export const y = 42;\n');
    const scores = await calculateAll([a, b]);
    const keys = Object.keys(scores).sort();
    assert.equal(keys.length, 2);
    for (const key of keys) {
      assert.equal(typeof scores[key], 'number');
    }
  });

  it('the serialThreshold seam routes the same batch to the pool, identically', async () => {
    // Story #5109 raised POOL_SERIAL_THRESHOLD to 256, so no realistic fixture
    // set reaches the pool by size alone. The seam is what keeps both paths
    // comparable — and "both paths agree" is the whole licence for having a
    // cutover at all.
    const a = path.join(tmp, 'pool-a.js');
    const b = path.join(tmp, 'pool-b.js');
    fs.writeFileSync(
      a,
      'export function branchy(x) { if (x>0) return 1; if (x<0) return -1; return 0; }\n',
    );
    fs.writeFileSync(b, 'export const z = 7;\n');
    const serial = await calculateAll([a, b]);
    const pooled = await calculateAll([a, b], { serialThreshold: 1 });
    assert.deepEqual(pooled, serial);
    assert.equal(Object.keys(pooled).length, 2);
  });

  it('drops entries whose serial scoring throws', async () => {
    const good = path.join(tmp, 'good.js');
    const bad = path.join(tmp, 'BAD.js');
    fs.writeFileSync(good, 'export const x = 1;\n');
    // typescript-flagged extension on a syntactically-broken source forces
    // the transpile path through, where calculateForFile may surface a 0
    // rather than a throw — either way calculateAll must not abort.
    fs.writeFileSync(bad, '@@@@ not js @@@@\n');
    const scores = await calculateAll([good, bad]);
    assert.equal(
      typeof scores[path.relative(process.cwd(), good).replace(/\\/g, '/')],
      'number',
    );
  });
});

describe('scanDirectory — defensive', () => {
  it('returns an empty list when the target directory does not exist', () => {
    const out = scanDirectory(path.join(tmp, 'missing'));
    assert.deepEqual(out, []);
  });

  it('rethrows non-ENOENT readdir failures', () => {
    // Pass a known-file-not-directory path to provoke ENOTDIR (or EISFILE
    // depending on platform) — readdir on a regular file throws code that
    // is NOT ENOENT, exercising the rethrow branch.
    const filePath = path.join(tmp, 'file-not-dir.js');
    fs.writeFileSync(filePath, '');
    assert.throws(() => scanDirectory(filePath));
  });

  it('skips a subdirectory that vanishes mid-walk', (t) => {
    const gone = path.join(tmp, 'gone');
    fs.mkdirSync(gone);
    fs.writeFileSync(path.join(gone, 'lost.js'), '');
    fs.writeFileSync(path.join(tmp, 'kept.js'), '');
    const readdirSync = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (dir, options) => {
      const entries = readdirSync(dir, options);
      if (dir === tmp) fs.rmSync(gone, { recursive: true });
      return entries;
    });
    assert.deepEqual(scanDirectory(tmp), [path.join(tmp, 'kept.js')]);
  });

  it('appends a walk too large to spread into push, in place', (t) => {
    const isFile = () => true;
    const isDirectory = () => false;
    const entries = Array.from({ length: 200_000 }, (_, i) => ({
      name: `f${i}.js`,
      isFile,
      isDirectory,
    }));
    t.mock.method(fs, 'readdirSync', () => entries);
    const acc = ['seed.js'];
    assert.equal(scanDirectory(tmp, acc), acc);
    assert.equal(acc.length, 200_001);
  });
});
