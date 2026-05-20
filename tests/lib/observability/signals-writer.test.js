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
  appendEpicSignal,
  appendSignal,
  appendTrace,
  forEachLine,
} from '../../../.agents/scripts/lib/observability/signals-writer.js';

let workRoot;
let cfg;

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'signals-writer-'));
  cfg = { project: { paths: { tempRoot: workRoot } } };
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
    // The writer injects a `source` tag (Story #2553) — the rest of the
    // payload must survive verbatim.
    assert.ok(raw.endsWith('\n'));
    const parsed = JSON.parse(raw.replace(/\n$/, ''));
    assert.equal(parsed.kind, 'lazy');
    assert.equal(parsed.value, 1);
    assert.equal(parsed.source, 'consumer');
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

describe('signals-writer — source tagging (Story #2553)', () => {
  it('tags consumer signals with source="consumer"', async () => {
    await appendSignal({
      epicId: 100,
      storyId: 101,
      signal: { kind: 'lint-failure', failingPath: 'src/foo.ts' },
      config: cfg,
    });
    const raw = await fs.readFile(signalsPath(100, 101), 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.source, 'consumer');
    assert.equal(parsed.failingPath, 'src/foo.ts');
  });

  it('tags framework signals (by failingPath) with source="framework"', async () => {
    await appendSignal({
      epicId: 100,
      storyId: 102,
      signal: {
        kind: 'test-failure',
        failingPath: '.agents/scripts/story-init.js',
      },
      config: cfg,
    });
    const raw = await fs.readFile(signalsPath(100, 102), 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.source, 'framework');
  });

  it('tags framework signals (by command) with source="framework"', async () => {
    await appendSignal({
      epicId: 100,
      storyId: 103,
      signal: {
        kind: 'command-failure',
        command: 'node .agents/scripts/story-close.js',
      },
      config: cfg,
    });
    const raw = await fs.readFile(signalsPath(100, 103), 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.source, 'framework');
  });

  it('preserves caller-supplied source (does not overwrite)', async () => {
    await appendSignal({
      epicId: 100,
      storyId: 104,
      signal: {
        kind: 'wave-tick',
        // failingPath says consumer, but caller has tagged framework
        failingPath: 'src/checkout/index.ts',
        source: 'framework',
      },
      config: cfg,
    });
    const raw = await fs.readFile(signalsPath(100, 104), 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.source, 'framework');
  });

  it('preserves caller-supplied source even when set to "consumer"', async () => {
    await appendSignal({
      epicId: 100,
      storyId: 105,
      signal: {
        kind: 'pinned',
        failingPath: '.agents/scripts/story-init.js',
        source: 'consumer',
      },
      config: cfg,
    });
    const raw = await fs.readFile(signalsPath(100, 105), 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.source, 'consumer');
  });

  it('tags signals appended via appendEpicSignal', async () => {
    await appendEpicSignal({
      epicId: 200,
      signal: {
        kind: 'wave-start',
        command: 'node .agents/scripts/epic-deliver.js',
      },
      config: cfg,
    });
    const raw = await fs.readFile(
      path.join(workRoot, 'epic-200', 'signals.ndjson'),
      'utf8',
    );
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.source, 'framework');
  });

  it('appendEpicSignal preserves caller-supplied source', async () => {
    await appendEpicSignal({
      epicId: 201,
      signal: { kind: 'manual', source: 'consumer' },
      config: cfg,
    });
    const raw = await fs.readFile(
      path.join(workRoot, 'epic-201', 'signals.ndjson'),
      'utf8',
    );
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.source, 'consumer');
  });

  it('degrades to a swallowed warn when classifier accessor throws', async () => {
    // Build a signal whose `failingPath` is a throwing getter. The
    // writer's tagSignalSource MUST catch that (Tech Spec #2550: classifier
    // failures degrade to Logger.warn and do not throw out of the writer).
    // The returned status may be `false` because JSON.stringify also fails
    // on the throwing getter, but `appendSignal` MUST NOT throw — that
    // contract is the heart of the best-effort guarantee.
    const exploding = { kind: 'getter-bomb' };
    Object.defineProperty(exploding, 'failingPath', {
      enumerable: true,
      get() {
        throw new Error('boom from getter');
      },
    });
    // No throw is the assertion. Resolution to true/false is allowed —
    // both are "best-effort". We just need the await to settle without
    // propagating an exception out of the writer.
    await assert.doesNotReject(async () => {
      await appendSignal({
        epicId: 300,
        storyId: 301,
        signal: exploding,
        config: cfg,
      });
    });
  });

  it('passes through non-object signals (string/number) without tagging', async () => {
    // The writer must not blow up if a detector posts a scalar (legacy
    // shape). It just persists the value verbatim — no tag injection.
    const ok = await appendSignal({
      epicId: 400,
      storyId: 401,
      signal: 'just-a-string',
      config: cfg,
    });
    assert.equal(ok, true);
    const raw = await fs.readFile(signalsPath(400, 401), 'utf8');
    assert.equal(raw, '"just-a-string"\n');
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

  // Story #2553 / Task #2559 — back-compat: forEachLine MUST yield
  // records unchanged regardless of whether the `source` key is present.
  // This is what guarantees pre-Story fixtures and brand-new framework
  // signals coexist in the same stream without crashing readers.
  it('yields records with the source field intact (Story #2553)', async () => {
    const dir = path.dirname(signalsPath(1300, 1301));
    await fs.mkdir(dir, { recursive: true });
    const target = signalsPath(1300, 1301);
    await fs.writeFile(
      target,
      [
        JSON.stringify({ kind: 'friction', source: 'framework', id: 1 }),
        JSON.stringify({ kind: 'friction', source: 'consumer', id: 2 }),
      ].join('\n') + '\n',
      'utf8',
    );

    const seen = [];
    const result = await forEachLine(
      1300,
      1301,
      (parsed) => {
        seen.push(parsed);
      },
      cfg,
    );
    assert.equal(result.linesParsed, 2);
    assert.equal(seen[0].source, 'framework');
    assert.equal(seen[1].source, 'consumer');
    // ID + kind survive verbatim.
    assert.deepEqual(
      seen.map((s) => s.id),
      [1, 2],
    );
  });

  it('yields records without the source field unchanged (Story #2553)', async () => {
    // Legacy fixture — pre-Story-2553 records lack the `source` key.
    // forEachLine MUST passthrough them without injecting anything.
    const dir = path.dirname(signalsPath(1400, 1401));
    await fs.mkdir(dir, { recursive: true });
    const target = signalsPath(1400, 1401);
    await fs.writeFile(
      target,
      [
        JSON.stringify({ kind: 'friction', id: 1 }),
        JSON.stringify({ kind: 'retry', id: 2 }),
      ].join('\n') + '\n',
      'utf8',
    );

    const seen = [];
    await forEachLine(
      1400,
      1401,
      (parsed) => {
        seen.push(parsed);
      },
      cfg,
    );
    assert.equal(seen.length, 2);
    assert.equal('source' in seen[0], false);
    assert.equal('source' in seen[1], false);
  });

  it('yields a mixed stream (with and without source) unchanged (Story #2553)', async () => {
    // Real-world transition shape: in-flight Stories may have a partial
    // signals.ndjson that mixes legacy records with new source-tagged
    // records depending on when the writer was deployed. forEachLine
    // MUST walk this without complaint.
    const dir = path.dirname(signalsPath(1500, 1501));
    await fs.mkdir(dir, { recursive: true });
    const target = signalsPath(1500, 1501);
    await fs.writeFile(
      target,
      [
        JSON.stringify({ kind: 'friction', id: 1 }), // legacy
        JSON.stringify({ kind: 'friction', source: 'framework', id: 2 }),
        JSON.stringify({ kind: 'friction', source: 'consumer', id: 3 }),
        JSON.stringify({ kind: 'retry', id: 4 }), // legacy
      ].join('\n') + '\n',
      'utf8',
    );

    const seen = [];
    const result = await forEachLine(
      1500,
      1501,
      (parsed) => {
        seen.push(parsed);
      },
      cfg,
    );
    assert.equal(result.linesParsed, 4);
    assert.deepEqual(
      seen.map((s) => s.source),
      [undefined, 'framework', 'consumer', undefined],
    );
  });
});
