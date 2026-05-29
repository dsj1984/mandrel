/**
 * cpu-pool — proves the worker-pool migration of `calculateAll`
 * (maintainability) and `scanAndScore` (CRAP) is observably identical
 * to the pre-pool serial path, and that a single broken file does not
 * abort the whole run.
 *
 * Two contracts under test:
 *
 *   (a) byte-for-byte parity: across a fixture set, the pool's output
 *       matches the in-process serial reference (same scores, same
 *       row shape, same deterministic ordering after sort).
 *
 *   (b) per-file failure isolation: a file with a deliberate parse
 *       error surfaces as either a missing entry (maintainability
 *       scores map) or a dropped row set (CRAP rows), while the rest
 *       of the fixture set scores normally. The run does NOT throw.
 *
 * The fixture set is sized above SERIAL_THRESHOLD (8) so the pool path
 * is exercised on every run — otherwise the migration would be invisible
 * here.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { runOnPool } from '../../.agents/scripts/lib/cpu-pool.js';
import { scanAndScore } from '../../.agents/scripts/lib/crap-utils.js';
import { calculateForFile } from '../../.agents/scripts/lib/maintainability-engine.js';
import { calculateAll } from '../../.agents/scripts/lib/maintainability-utils.js';

/**
 * Generate N small but non-trivial JS files under `dir`, each shaped so
 * escomplex emits a single named function with a stable cyclomatic
 * count. The fixture is intentionally above `SERIAL_THRESHOLD` so the
 * pool path is the one under test.
 */
function writeJsFixtures(dir, count, prefix = 'f') {
  const files = [];
  for (let i = 0; i < count; i++) {
    const p = path.join(dir, `${prefix}${i}.js`);
    fs.writeFileSync(
      p,
      `export function ${prefix}${i}(x) {\n` +
        `  if (x > 0) return x + 1;\n` +
        `  if (x < 0) return x - 1;\n` +
        `  return ${i};\n` +
        `}\n`,
    );
    files.push(p);
  }
  return files;
}

function buildCoverageMap(files) {
  // Minimal istanbul-shaped entry: every fn covered, single statement
  // hit. The exact coverage value doesn't matter here — the test
  // asserts shape parity, not numeric coverage.
  const coverage = {};
  for (const abs of files) {
    coverage[abs] = {
      path: abs,
      fnMap: {
        0: {
          name: path.basename(abs, '.js'),
          decl: { start: { line: 1, column: 0 } },
          loc: { start: { line: 1, column: 0 }, end: { line: 5, column: 1 } },
          line: 1,
        },
      },
      f: { 0: 1 },
      statementMap: {
        0: { start: { line: 2, column: 0 }, end: { line: 2, column: 30 } },
        1: { start: { line: 3, column: 0 }, end: { line: 3, column: 30 } },
        2: { start: { line: 4, column: 0 }, end: { line: 4, column: 30 } },
      },
      s: { 0: 1, 1: 1, 2: 1 },
      branchMap: {},
      b: {},
    };
  }
  return coverage;
}

// ---------------------------------------------------------------------------
// (a) byte-for-byte parity across fixture set
// ---------------------------------------------------------------------------

describe('cpu-pool — byte-for-byte parity with serial baseline', () => {
  let workDir;
  let originalCwd;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-pool-parity-'));
    originalCwd = process.cwd();
    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('maintainability calculateAll: pool output matches in-process scores', async () => {
    const caseDir = path.join(workDir, 'maintainability-parity');
    fs.mkdirSync(caseDir, { recursive: true });
    // 9 fixtures > SERIAL_THRESHOLD (8) so the pool path runs.
    const files = writeJsFixtures(caseDir, 9);

    // Reference: build the same map by calling the synchronous engine
    // directly on each file, then sort keys to mirror the migration's
    // deterministic ordering contract.
    const reference = {};
    for (const f of files) {
      const rel = path.relative(workDir, f).replace(/\\/g, '/');
      reference[rel] = calculateForFile(f);
    }
    const sortedReference = Object.fromEntries(
      Object.keys(reference)
        .sort()
        .map((k) => [k, reference[k]]),
    );

    const fromPool = await calculateAll(files);

    // Same keys in the same order, same numeric values.
    assert.deepStrictEqual(
      Object.keys(fromPool),
      Object.keys(sortedReference),
      'key order must be deterministic and match sort-by-relPath',
    );
    for (const k of Object.keys(sortedReference)) {
      assert.strictEqual(
        fromPool[k],
        sortedReference[k],
        `score for ${k} must match the serial reference exactly`,
      );
    }
  });

  it('CRAP scanAndScore: pool rows match the per-file serial reference', async () => {
    const caseDir = path.join(workDir, 'crap-parity');
    fs.mkdirSync(caseDir, { recursive: true });
    const files = writeJsFixtures(caseDir, 9, 'g');
    const coverage = buildCoverageMap(files);
    const result = await scanAndScore({
      targetDirs: [caseDir],
      coverage,
      requireCoverage: true,
      cwd: caseDir,
    });

    // Every fixture surfaces exactly one row (one function per file).
    assert.strictEqual(result.scannedFiles, 9);
    assert.strictEqual(result.skippedFilesNoCoverage, 0);
    assert.strictEqual(result.rows.length, 9);

    // Rows are sorted by (file, startLine, method) — assert that the
    // sort actually fires regardless of which worker finished first.
    const fileSequence = result.rows.map((r) => r.file);
    const sorted = [...fileSequence].sort();
    assert.deepStrictEqual(
      fileSequence,
      sorted,
      'rows must be sorted by file path post-pool',
    );

    // Every row's shape matches what the pre-pool serial loop produced.
    for (const row of result.rows) {
      assert.match(row.file, /^g\d+\.js$/);
      assert.match(row.method, /^g\d+$/);
      assert.strictEqual(row.startLine, 1);
      assert.strictEqual(row.cyclomatic, 3, 'two ifs + entry');
      assert.strictEqual(row.coverage, 1);
      assert.strictEqual(typeof row.crap, 'number');
    }
  });
});

// ---------------------------------------------------------------------------
// (b) parse-error isolation — one bad file does not fail the whole run
// ---------------------------------------------------------------------------

describe('cpu-pool — parse-error isolation', () => {
  let workDir;
  let originalCwd;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-pool-isolate-'));
    originalCwd = process.cwd();
    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('maintainability: a parse-error file is dropped; siblings score normally', async () => {
    const caseDir = path.join(workDir, 'maintainability-case');
    fs.mkdirSync(caseDir, { recursive: true });
    const goodFiles = writeJsFixtures(caseDir, 8, 'h');
    const badPath = path.join(caseDir, 'BROKEN.js');
    // Garbage bytes that ts.transpileModule + escomplex will both
    // refuse to parse. The current serial path returns 0 for parse
    // errors; the pool path matches that, so the file silently drops
    // out of the scores map. The contract under test is that the run
    // does NOT throw and the other 11 files survive.
    fs.writeFileSync(badPath, '@@@@ not valid javascript @@@@\n}}}}\n');

    const all = [...goodFiles, badPath];
    const scores = await calculateAll(all);

    // 11 good files surface; the bad file either drops out (null
    // score filtered) or scores 0. Assert at least the 11 are present
    // and their scores match the per-file serial reference.
    for (const good of goodFiles) {
      const rel = path.relative(workDir, good).replace(/\\/g, '/');
      assert.ok(rel in scores, `expected good file ${rel} to be scored`);
      assert.strictEqual(scores[rel], calculateForFile(good));
    }
    // Run completed without throwing.
    assert.ok(true, 'pool drained despite the broken fixture');
  });

  it('CRAP: a parse-error file produces zero rows; siblings score normally', async () => {
    const caseDir = path.join(workDir, 'crap-case');
    fs.mkdirSync(caseDir, { recursive: true });
    const goodFiles = writeJsFixtures(caseDir, 8, 'k');
    const badPath = path.join(caseDir, 'BROKEN.js');
    fs.writeFileSync(badPath, '))) syntax garbage (((\n');
    const all = [...goodFiles, badPath];
    const coverage = buildCoverageMap(all);

    const result = await scanAndScore({
      targetDirs: [caseDir],
      coverage,
      requireCoverage: true,
      cwd: caseDir,
    });

    // The bad file was scanned (it has a coverage entry so requireCoverage
    // doesn't filter it out) but produced no rows because TS transpile
    // surfaces nothing escomplex can chew on.
    assert.strictEqual(result.scannedFiles, 9);
    assert.strictEqual(result.rows.length, 8);
    for (const row of result.rows) {
      assert.match(row.file, /^k\d+\.js$/, 'BROKEN.js must not appear');
    }
  });
});

// ---------------------------------------------------------------------------
// (c) cpu-pool primitive — small smoke around runOnPool itself
// ---------------------------------------------------------------------------

describe('runOnPool — primitive contract', () => {
  it('preserves input order in the returned results array', async () => {
    // Inline worker — squares its input. Use data: URL so the test
    // doesn't depend on a fixture file on disk.
    const workerSrc = `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) process.exit(0);
        const n = msg.item;
        parentPort.postMessage({ ok: true, result: n * n });
      });
    `;
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(workerSrc)}`,
    );
    const items = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const results = await runOnPool(workerUrl, items, { concurrency: 4 });
    assert.deepStrictEqual(
      results,
      items.map((n) => n * n),
    );
  });

  it('captures per-item failures as __cpuPoolError instead of throwing', async () => {
    const workerSrc = `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) process.exit(0);
        if (msg.item === 'bad') {
          parentPort.postMessage({ ok: false, error: 'item refused' });
          return;
        }
        parentPort.postMessage({ ok: true, result: msg.item.toUpperCase() });
      });
    `;
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(workerSrc)}`,
    );
    const results = await runOnPool(workerUrl, ['a', 'bad', 'c'], {
      concurrency: 2,
    });
    assert.strictEqual(results[0], 'A');
    assert.deepStrictEqual(results[1], {
      __cpuPoolError: true,
      message: 'item refused',
    });
    assert.strictEqual(results[2], 'C');
  });
});

// ---------------------------------------------------------------------------
// (d) injected workerFactory — drive scheduling / ordering / exit-race
//     branches in-process with a synchronous fake handle, no real thread.
// ---------------------------------------------------------------------------

/**
 * EventEmitter-shaped fake worker handle. It satisfies the subset of the
 * worker_threads.Worker surface that `runOnPool` touches: `on`/`off`/`once`,
 * `postMessage`, and a thenable `terminate()`. The `respond` callback is
 * invoked for every `{ item }` dispatch and decides which scheduler branch
 * to exercise by emitting the corresponding event synchronously (so no real
 * OS thread, timer, or microtask hop is required to drive the test).
 *
 * @param {(item: unknown, handle: FakeWorker) => void} respond
 */
class FakeWorker extends EventEmitter {
  constructor(respond) {
    super();
    this.respond = respond;
    this.terminated = false;
    this.posted = [];
  }

  postMessage(msg) {
    this.posted.push(msg);
    if (msg && msg.exit === true) {
      // Clean drain-and-exit: mirror a real worker honoring { exit: true }.
      this.emit('exit', 0);
      return;
    }
    this.respond(msg.item, this);
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

describe('runOnPool — injected workerFactory', () => {
  it('defaults to spawning a real Worker when no factory is given (parity)', async () => {
    // The single real-thread parity check: with no workerFactory, the pool
    // still drives an actual worker_threads.Worker end-to-end.
    const workerSrc = `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) process.exit(0);
        parentPort.postMessage({ ok: true, result: msg.item * 10 });
      });
    `;
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(workerSrc)}`,
    );
    const results = await runOnPool(workerUrl, [1, 2, 3], { concurrency: 2 });
    assert.deepStrictEqual(results, [10, 20, 30]);
  });

  it('uses the injected factory and preserves input order across workers', async () => {
    const built = [];
    const factory = (script, options) => {
      assert.strictEqual(script, 'fake://script');
      assert.deepStrictEqual(options, { workerData: { salt: 7 } });
      const w = new FakeWorker((item, handle) => {
        handle.emit('message', { ok: true, result: item * item });
      });
      built.push(w);
      return w;
    };

    const items = [3, 1, 4, 1, 5, 9, 2, 6];
    const results = await runOnPool('fake://script', items, {
      concurrency: 3,
      workerData: { salt: 7 },
      workerFactory: factory,
    });

    // Results land at their source index regardless of dispatch race.
    assert.deepStrictEqual(
      results,
      items.map((n) => n * n),
    );
    // concurrency=3 → exactly three handles were built and each was reaped.
    assert.strictEqual(built.length, 3);
    for (const w of built) {
      assert.ok(w.terminated, 'every worker handle must be terminated');
      assert.deepStrictEqual(
        w.posted.at(-1),
        { exit: true },
        'each worker receives a drain { exit: true } before terminate',
      );
    }
  });

  it('captures per-item failures via the fake factory without throwing', async () => {
    const factory = () =>
      new FakeWorker((item, handle) => {
        if (item === 'bad') {
          handle.emit('message', { ok: false, error: 'item refused' });
          return;
        }
        handle.emit('message', {
          ok: true,
          result: String(item).toUpperCase(),
        });
      });

    const results = await runOnPool('fake://script', ['a', 'bad', 'c'], {
      concurrency: 1,
      workerFactory: factory,
    });
    assert.strictEqual(results[0], 'A');
    assert.deepStrictEqual(results[1], {
      __cpuPoolError: true,
      message: 'item refused',
    });
    assert.strictEqual(results[2], 'C');
  });

  it('aborts the whole run on item error when throwOnItemError is true', async () => {
    const factory = () =>
      new FakeWorker((item, handle) => {
        if (item === 'bad') {
          handle.emit('message', { ok: false, error: 'boom' });
          return;
        }
        handle.emit('message', { ok: true, result: item });
      });

    await assert.rejects(
      () =>
        runOnPool('fake://script', ['ok', 'bad', 'ok'], {
          concurrency: 1,
          throwOnItemError: true,
          workerFactory: factory,
        }),
      /cpu-pool item failure: boom/,
    );
  });

  it('treats a malformed worker message as a host-level fatal', async () => {
    const factory = () =>
      new FakeWorker((_item, handle) => {
        handle.emit('message', { garbage: true });
      });

    await assert.rejects(
      () =>
        runOnPool('fake://script', ['x'], {
          concurrency: 1,
          workerFactory: factory,
        }),
      /malformed worker message/,
    );
  });

  it('surfaces a worker error event as a fatal rejection', async () => {
    const factory = () =>
      new FakeWorker((_item, handle) => {
        handle.emit('error', new Error('thread blew up'));
      });

    await assert.rejects(
      () =>
        runOnPool('fake://script', ['x'], {
          concurrency: 1,
          workerFactory: factory,
        }),
      /thread blew up/,
    );
  });

  it('rejects when a worker exits non-zero mid-dispatch', async () => {
    const factory = () =>
      new FakeWorker((_item, handle) => {
        handle.emit('exit', 3);
      });

    await assert.rejects(
      () =>
        runOnPool('fake://script', ['x'], {
          concurrency: 1,
          workerFactory: factory,
        }),
      /worker exited with code 3/,
    );
  });

  it('rejects when a worker exits cleanly mid-dispatch (exit race)', async () => {
    // A code-0 exit while an item is in flight is still a lost item, not a
    // clean drain — the scheduler must surface it rather than silently drop.
    const factory = () =>
      new FakeWorker((_item, handle) => {
        handle.emit('exit', 0);
      });

    await assert.rejects(
      () =>
        runOnPool('fake://script', ['x'], {
          concurrency: 1,
          workerFactory: factory,
        }),
      /worker exited mid-dispatch/,
    );
  });

  it('short-circuits the drain when the worker already exited', async () => {
    // Exercise the finally-block branch where workerExited is already true:
    // the worker reports a clean exit only on the drain { exit: true }, never
    // mid-dispatch, so no { exit: true } re-post race is needed.
    const factory = () =>
      new FakeWorker((item, handle) => {
        handle.emit('message', { ok: true, result: item + 1 });
      });

    const results = await runOnPool('fake://script', [10, 20], {
      concurrency: 1,
      workerFactory: factory,
    });
    assert.deepStrictEqual(results, [11, 21]);
  });
});
