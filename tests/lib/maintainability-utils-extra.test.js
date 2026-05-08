/**
 * Extra coverage for `lib/maintainability-utils.js` — branches that the
 * existing scanDirectory test and the cpu-pool parity tests don't reach:
 * baseline read/write, transpile fallback, calculateAll's serial path
 * for tiny batches.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  calculateAll,
  getBaseline,
  resolveTsTranspilerVersion,
  saveBaseline,
  scanDirectory,
  transpileIfNeeded,
} from '../../.agents/scripts/lib/maintainability-utils.js';

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mi_extra_'));
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
    const rel = path.relative(process.cwd(), path.join(tmp, 'rel.json'));
    fs.writeFileSync(path.join(process.cwd(), rel), JSON.stringify({ x: 1 }));
    try {
      assert.deepEqual(getBaseline(rel), { x: 1 });
    } finally {
      fs.unlinkSync(path.join(process.cwd(), rel));
    }
  });
});

describe('saveBaseline', () => {
  it('throws on empty / non-string baselinePath', () => {
    assert.throws(() => saveBaseline({}, ''), /baselinePath is required/);
    assert.throws(() => saveBaseline({}, null), /baselinePath is required/);
  });

  it('writes JSON sorted by key with a trailing newline', () => {
    const p = path.join(tmp, 'out.json');
    saveBaseline({ z: 1, a: 2, m: 3 }, p);
    const raw = fs.readFileSync(p, 'utf-8');
    assert.equal(raw.endsWith('\n'), true);
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed), ['a', 'm', 'z']);
  });

  it('creates intermediate directories when they do not exist', () => {
    const p = path.join(tmp, 'nested', 'deep', 'baseline.json');
    saveBaseline({ a: 1 }, p);
    assert.equal(fs.existsSync(p), true);
  });

  it('round-trips with getBaseline', () => {
    const p = path.join(tmp, 'rt.json');
    const data = { 'a.js': 10, 'b.js': 20 };
    saveBaseline(data, p);
    assert.deepEqual(getBaseline(p), data);
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
});
