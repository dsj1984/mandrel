/**
 * Unit tests for `lib/observability/signals-writer.js` (Epic #1030
 * Story #1041 / Task #1056). Covers append correctness, JSON validity
 * per line, lazy directory creation, error swallowing, the trace
 * sibling, and the streaming `forEachLine` reader.
 *
 * Each test uses an isolated `os.tmpdir()` workspace and threads it
 * through the writer's `config.paths.tempRoot` so we never touch the
 * repo's real `temp/` tree.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  appendSignal,
  appendTrace,
  forEachLine,
} from '../../../.agents/scripts/lib/observability/signals-writer.js';

let workRoot;
let cfg;

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'signals-writer-'));
  cfg = { paths: { tempRoot: workRoot } };
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

const signalsPath = (eid, sid) =>
  path.join(workRoot, `epic-${eid}`, `story-${sid}`, 'signals.ndjson');
const tracesPath = (eid, sid) =>
  path.join(workRoot, `epic-${eid}`, `story-${sid}`, 'traces.ndjson');

describe('signals-writer — appendSignal correctness', () => {
  it('writes 100 valid newline-terminated JSON lines', async () => {
    for (let i = 0; i < 100; i += 1) {
      const ok = await appendSignal({
        epicId: 1030,
        storyId: 1041,
        signal: { kind: 'test', i, msg: `signal ${i}` },
        config: cfg,
      });
      assert.equal(ok, true);
    }

    const raw = await fs.readFile(signalsPath(1030, 1041), 'utf8');
    assert.ok(raw.endsWith('\n'), 'file must end with newline');
    const lines = raw.split('\n').slice(0, -1); // drop empty tail
    assert.equal(lines.length, 100);

    lines.forEach((line, idx) => {
      const parsed = JSON.parse(line);
      assert.equal(parsed.kind, 'test');
      assert.equal(parsed.i, idx);
      assert.equal(parsed.msg, `signal ${idx}`);
    });
  });

  it('lazily creates the per-Story directory on first append', async () => {
    const dir = path.dirname(signalsPath(2000, 2100));
    // pre-flight: directory does not yet exist
    await assert.rejects(() => fs.stat(dir));

    const ok = await appendSignal({
      epicId: 2000,
      storyId: 2100,
      signal: { kind: 'lazy', value: 1 },
      config: cfg,
    });
    assert.equal(ok, true);

    const stat = await fs.stat(dir);
    assert.ok(stat.isDirectory());
    const raw = await fs.readFile(signalsPath(2000, 2100), 'utf8');
    assert.equal(raw, `${JSON.stringify({ kind: 'lazy', value: 1 })}\n`);
  });

  it('returns false (not throw) when the record cannot be serialised', async () => {
    // Circular reference — JSON.stringify throws TypeError
    const a = { name: 'a' };
    const b = { name: 'b', a };
    a.b = b;

    const ok = await appendSignal({
      epicId: 1,
      storyId: 2,
      signal: a,
      config: cfg,
    });
    assert.equal(ok, false);
    // No file should have been created
    await assert.rejects(() => fs.stat(signalsPath(1, 2)));
  });

  it('returns false (not throw) on invalid epicId / storyId', async () => {
    assert.equal(
      await appendSignal({
        epicId: 0,
        storyId: 1,
        signal: {},
        config: cfg,
      }),
      false,
    );
    assert.equal(
      await appendSignal({
        epicId: 1,
        storyId: -3,
        signal: {},
        config: cfg,
      }),
      false,
    );
    assert.equal(
      await appendSignal({
        epicId: 'oops',
        storyId: 1,
        signal: {},
        config: cfg,
      }),
      false,
    );
  });

  it('returns false (not throw) when called with no args', async () => {
    assert.equal(await appendSignal(), false);
    assert.equal(await appendSignal(undefined), false);
  });

  it('swallows underlying fs failures (simulated EACCES)', async () => {
    // Pre-create the file as a directory so appendFile fails with EISDIR.
    // This exercises the same "fs threw, swallow it, log a warn" path
    // that an EACCES on a permission-locked file would hit.
    const target = signalsPath(7, 8);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(target); // directory where a file should be

    const ok = await appendSignal({
      epicId: 7,
      storyId: 8,
      signal: { kind: 'eacces' },
      config: cfg,
    });
    assert.equal(ok, false);
    // The directory should still exist (we did not delete on failure).
    const stat = await fs.stat(target);
    assert.ok(stat.isDirectory());
  });
});

describe('signals-writer — appendTrace correctness', () => {
  it('writes traces to the traces.ndjson sibling, not signals.ndjson', async () => {
    await appendTrace({
      epicId: 1030,
      storyId: 1041,
      trace: { kind: 'span', name: 'task-commit', durMs: 42 },
      config: cfg,
    });

    const traceRaw = await fs.readFile(tracesPath(1030, 1041), 'utf8');
    assert.equal(
      traceRaw,
      `${JSON.stringify({ kind: 'span', name: 'task-commit', durMs: 42 })}\n`,
    );
    // signals.ndjson must not be touched
    await assert.rejects(() => fs.stat(signalsPath(1030, 1041)));
  });

  it('returns false on invalid ids without throwing', async () => {
    assert.equal(
      await appendTrace({
        epicId: -1,
        storyId: 1,
        trace: {},
        config: cfg,
      }),
      false,
    );
  });
});

describe('signals-writer — forEachLine reader', () => {
  it('streams every parsed line in order', async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendSignal({
        epicId: 9,
        storyId: 10,
        signal: { i },
        config: cfg,
      });
    }

    const seen = [];
    const result = await forEachLine(
      9,
      10,
      (parsed, lineNo) => {
        seen.push({ parsed, lineNo });
      },
      cfg,
    );

    assert.equal(result.missing, false);
    assert.equal(result.linesRead, 5);
    assert.equal(result.linesParsed, 5);
    assert.deepEqual(
      seen.map((s) => s.parsed.i),
      [0, 1, 2, 3, 4],
    );
    // 1-based line numbers
    assert.deepEqual(
      seen.map((s) => s.lineNo),
      [1, 2, 3, 4, 5],
    );
  });

  it('returns missing:true when the file does not exist (no throw)', async () => {
    let invocations = 0;
    const result = await forEachLine(
      404,
      405,
      () => {
        invocations += 1;
      },
      cfg,
    );
    assert.equal(result.missing, true);
    assert.equal(result.linesRead, 0);
    assert.equal(result.linesParsed, 0);
    assert.equal(invocations, 0);
  });

  it('skips malformed JSON lines but still parses the valid ones', async () => {
    const dir = path.dirname(signalsPath(11, 12));
    await fs.mkdir(dir, { recursive: true });
    const target = signalsPath(11, 12);
    await fs.writeFile(
      target,
      [
        JSON.stringify({ ok: 1 }),
        '{ this is not json',
        JSON.stringify({ ok: 2 }),
        '',
      ].join('\n'),
      'utf8',
    );

    const parsedSeen = [];
    const result = await forEachLine(
      11,
      12,
      (parsed) => {
        parsedSeen.push(parsed);
      },
      cfg,
    );

    assert.equal(result.missing, false);
    assert.equal(result.linesParsed, 2);
    assert.deepEqual(parsedSeen, [{ ok: 1 }, { ok: 2 }]);
  });

  it('swallows callback exceptions and keeps streaming', async () => {
    for (let i = 0; i < 3; i += 1) {
      await appendSignal({
        epicId: 13,
        storyId: 14,
        signal: { i },
        config: cfg,
      });
    }

    const seen = [];
    await forEachLine(
      13,
      14,
      (parsed) => {
        seen.push(parsed.i);
        if (parsed.i === 1) {
          throw new Error('boom from cb');
        }
      },
      cfg,
    );

    // All three should have been visited even though one threw.
    assert.deepEqual(seen, [0, 1, 2]);
  });

  it('returns 0/0 when called without a callback', async () => {
    const result = await forEachLine(1, 2, undefined, cfg);
    assert.equal(result.linesRead, 0);
    assert.equal(result.linesParsed, 0);
    assert.equal(result.missing, false);
  });

  it('returns 0/0 on invalid ids without throwing', async () => {
    const result = await forEachLine(0, 1, () => {}, cfg);
    assert.equal(result.linesRead, 0);
    assert.equal(result.linesParsed, 0);
    assert.equal(result.missing, false);
  });
});
