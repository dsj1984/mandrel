import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  BaselineNotFoundError,
  BaselineWriteError,
  loadBaseline,
  writeBaseline,
} from '../.agents/scripts/lib/gates/baseline-store.js';

/**
 * Story #1476 — pure-I/O baseline store. Covers the four behaviours each
 * gate previously re-implemented:
 *   1. Epic-ref read takes precedence; fallback to working-tree on failure.
 *   2. No-epicRef path delegates straight to the working-tree reader.
 *   3. Atomic write via temp file + rename.
 *   4. Malformed JSON / missing-file errors are explicit, not swallowed.
 */

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-store-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadBaseline — epic-ref fallback chain', () => {
  it('uses readAtRef when epicRef is supplied and the read succeeds', () => {
    let fsCalls = 0;
    let refCalls = 0;
    const out = loadBaseline({
      baselinePath: 'baselines/x.json',
      epicRef: 'epic/42',
      readAtRef: (ref, p) => {
        refCalls += 1;
        assert.equal(ref, 'epic/42');
        assert.equal(p, 'baselines/x.json');
        return { hello: 'world' };
      },
      readFromTree: () => {
        fsCalls += 1;
        return { stale: true };
      },
    });
    assert.equal(refCalls, 1);
    assert.equal(fsCalls, 0);
    assert.deepEqual(out, { hello: 'world' });
  });

  it('falls back to readFromTree with a warning when readAtRef throws', () => {
    let warnings = 0;
    const out = loadBaseline({
      baselinePath: 'baselines/x.json',
      epicRef: 'epic/42',
      readAtRef: () => {
        throw new Error('git unavailable');
      },
      readFromTree: ({ baselinePath }) => {
        assert.equal(baselinePath, 'baselines/x.json');
        return { fallback: true };
      },
      logger: {
        warn: (msg) => {
          warnings += 1;
          assert.match(msg, /failed to read baseline at ref "epic\/42"/);
          assert.match(msg, /falling back to working-tree read/i);
        },
      },
    });
    assert.equal(warnings, 1);
    assert.deepEqual(out, { fallback: true });
  });

  it('falls back to readFromTree when readAtRef returns null/undefined', () => {
    let fsCalls = 0;
    const out = loadBaseline({
      baselinePath: 'baselines/x.json',
      epicRef: 'epic/42',
      readAtRef: () => null,
      readFromTree: () => {
        fsCalls += 1;
        return { fallback: true };
      },
    });
    assert.equal(fsCalls, 1);
    assert.deepEqual(out, { fallback: true });
  });

  it('bypasses readAtRef when epicRef is absent (legacy path)', () => {
    let refCalls = 0;
    const out = loadBaseline({
      baselinePath: 'baselines/x.json',
      epicRef: null,
      readAtRef: () => {
        refCalls += 1;
        return { should: 'not-be-called' };
      },
      readFromTree: () => ({ legacy: true }),
    });
    assert.equal(refCalls, 0);
    assert.deepEqual(out, { legacy: true });
  });
});

describe('loadBaseline default fs reader (no custom readFromTree)', () => {
  it('parses an existing baseline JSON from the working tree', () => {
    const p = path.join(tmpRoot, 'present.json');
    fs.writeFileSync(p, JSON.stringify({ live: 1 }));
    assert.deepEqual(loadBaseline({ baselinePath: p }), { live: 1 });
  });

  it('throws BaselineNotFoundError when file is absent and no epicRef helps', () => {
    const p = path.join(tmpRoot, 'missing.json');
    assert.throws(
      () => loadBaseline({ baselinePath: p }),
      (err) => err instanceof BaselineNotFoundError && err.path === p,
    );
  });

  it('throws SyntaxError (no swallowing) on malformed JSON', () => {
    const p = path.join(tmpRoot, 'bad.json');
    fs.writeFileSync(p, '{ not json');
    assert.throws(
      () => loadBaseline({ baselinePath: p }),
      (err) => err instanceof SyntaxError,
    );
  });
});

describe('writeBaseline — atomic write', () => {
  it('writes JSON with 2-space indent + trailing newline', () => {
    const p = path.join(tmpRoot, 'out.json');
    writeBaseline({ baselinePath: p, data: { a: 1, b: [2, 3] } });
    const raw = fs.readFileSync(p, 'utf8');
    assert.equal(raw, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
  });

  it('creates parent directories that do not yet exist', () => {
    const p = path.join(tmpRoot, 'nested', 'deep', 'b.json');
    writeBaseline({ baselinePath: p, data: { ok: true } });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { ok: true });
  });

  it('leaves no <path>.tmp residue after a successful write', () => {
    const p = path.join(tmpRoot, 'clean.json');
    writeBaseline({ baselinePath: p, data: { ok: true } });
    assert.equal(fs.existsSync(`${p}.tmp`), false);
  });

  it('rejects circular structures with BaselineWriteError', () => {
    const p = path.join(tmpRoot, 'circ.json');
    const circular = {};
    circular.self = circular;
    assert.throws(
      () => writeBaseline({ baselinePath: p, data: circular }),
      (err) => err instanceof BaselineWriteError && err.path === p,
    );
    assert.equal(fs.existsSync(p), false);
  });

  it('resolves relative paths against projectRoot when supplied', () => {
    writeBaseline({
      baselinePath: 'rel/baseline.json',
      data: { rel: true },
      projectRoot: tmpRoot,
    });
    const expected = path.join(tmpRoot, 'rel', 'baseline.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(expected, 'utf8')), {
      rel: true,
    });
  });
});

describe('writeBaseline — error envelope', () => {
  it('BaselineWriteError carries path + cause from the underlying failure', () => {
    // Force a write failure by pointing at a path whose parent is a regular
    // file rather than a directory — mkdir fails on that.
    const blocker = path.join(tmpRoot, 'blocker');
    fs.writeFileSync(blocker, 'not-a-dir');
    const target = path.join(blocker, 'baseline.json');
    let caught;
    try {
      writeBaseline({ baselinePath: target, data: { ok: true } });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof BaselineWriteError);
    assert.equal(caught.path, target);
    assert.ok(caught.cause, 'cause must be threaded through');
  });
});
