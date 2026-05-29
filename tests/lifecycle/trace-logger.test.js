// tests/lifecycle/trace-logger.test.js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Bus } from '../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import {
  parseLedger,
  render,
  TraceLogger,
} from '../../.agents/scripts/lib/orchestration/lifecycle/trace-logger.js';

const SAMPLE_LEDGER = [
  {
    kind: 'emitted',
    seqId: 1,
    ts: '2026-05-17T10:00:00.000Z',
    event: 'epic.snapshot.start',
    payload: { epicId: 42 },
  },
  {
    kind: 'completed',
    seqId: 1,
    ts: '2026-05-17T10:00:00.150Z',
    event: 'epic.snapshot.start',
  },
  {
    kind: 'emitted',
    seqId: 2,
    ts: '2026-05-17T10:00:01.000Z',
    event: 'epic.snapshot.end',
    payload: { epicId: 42, storyIds: [1, 2, 3] },
  },
  {
    kind: 'completed',
    seqId: 2,
    ts: '2026-05-17T10:00:01.200Z',
    event: 'epic.snapshot.end',
  },
  {
    kind: 'emitted',
    seqId: 3,
    ts: '2026-05-17T10:00:02.000Z',
    event: 'pr.created',
    payload: { prUrl: 'https://example/1', head: 'epic/42', base: 'main' },
  },
  {
    kind: 'completed',
    seqId: 3,
    ts: '2026-05-17T10:00:02.050Z',
    event: 'pr.created',
  },
];

describe('lifecycle/trace-logger', () => {
  it('render(ledger) is a pure function — same input yields byte-identical Markdown', () => {
    const a = render(SAMPLE_LEDGER, { epicId: 42 });
    const b = render(SAMPLE_LEDGER, { epicId: 42 });
    assert.equal(a, b);
    // Also: parsing a serialized version of the ledger yields the same
    // output, because render() accepts either an array OR a string.
    const text = SAMPLE_LEDGER.map((r) => JSON.stringify(r)).join('\n');
    const c = render(text, { epicId: 42 });
    assert.equal(a, c);
  });

  it('render groups events by phase in stable order', () => {
    const md = render(SAMPLE_LEDGER, { epicId: 42 });
    assert.match(md, /# Lifecycle — epic 42/);
    assert.match(md, /## Snapshot/);
    assert.match(md, /## Finalize/);
    // Snapshot must appear before Finalize.
    const snapIdx = md.indexOf('## Snapshot');
    const finalIdx = md.indexOf('## Finalize');
    assert.ok(snapIdx >= 0 && snapIdx < finalIdx);
  });

  it('render includes a Summary block with event counts', () => {
    const md = render(SAMPLE_LEDGER, { epicId: 42 });
    assert.match(md, /## Summary/);
    assert.match(md, /- Events: 3/);
    assert.match(md, /- Completed: 3/);
    assert.match(md, /- Failed: 0/);
  });

  it('render marks failed events with a ⚠️ FAILED suffix', () => {
    const failedLedger = [
      ...SAMPLE_LEDGER.slice(0, 2),
      {
        kind: 'emitted',
        seqId: 2,
        ts: '2026-05-17T10:00:01.000Z',
        event: 'epic.snapshot.end',
        payload: { epicId: 42, storyIds: [] },
      },
      {
        kind: 'failed',
        seqId: 2,
        ts: '2026-05-17T10:00:01.300Z',
        event: 'epic.snapshot.end',
        listener: 'TestListener',
        error: { name: 'Error', message: 'boom' },
      },
    ];
    const md = render(failedLedger, { epicId: 42 });
    assert.match(md, /⚠️ FAILED/);
    assert.match(md, /- Failed: 1/);
  });

  it('render marks emitted-without-terminal records as pending', () => {
    const pendingLedger = [
      {
        kind: 'emitted',
        seqId: 1,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'epic.snapshot.start',
        payload: { epicId: 1 },
      },
    ];
    const md = render(pendingLedger);
    assert.match(md, /\(pending\)/);
  });

  it('parseLedger tolerates blank lines and throws on malformed JSON', () => {
    const text = `${JSON.stringify(SAMPLE_LEDGER[0])}\n\n${JSON.stringify(SAMPLE_LEDGER[1])}\n`;
    const parsed = parseLedger(text);
    assert.equal(parsed.length, 2);
    assert.throws(() => parseLedger('not json'), /malformed JSON/);
  });

  it('TraceLogger.rerender() writes the companion next to the ledger', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mandrel-trace-'));
    try {
      const bus = new Bus();
      const writer = new LedgerWriter({ epicId: 99, tempRoot: dir });
      writer.register(bus);
      const tracer = new TraceLogger({
        ledgerPath: writer.ledgerPath,
        epicId: 99,
      });
      tracer.register(bus);
      bus.on('epic.snapshot.start', () => {});
      await bus.emit('epic.snapshot.start', { epicId: 99 });
      const md = readFileSync(tracer.companionPath, 'utf8');
      assert.match(md, /# Lifecycle — epic 99/);
      assert.match(md, /epic\.snapshot\.start/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TraceLogger.rerender() is a no-op when the ledger does not yet exist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mandrel-trace-'));
    try {
      const tracer = new TraceLogger({
        ledgerPath: path.join(dir, 'no-such.ndjson'),
        epicId: 1,
      });
      // Should not throw.
      tracer.rerender();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TraceLogger constructor rejects missing ledgerPath', () => {
    assert.throws(() => new TraceLogger({}), TypeError);
    assert.throws(() => new TraceLogger({ ledgerPath: '' }), TypeError);
  });

  it('Editing the companion does not affect resume — only NDJSON is canonical', () => {
    // Validate the contract that re-rendering produces a byte-identical
    // result regardless of any human edits to the companion: the function
    // ignores companionPath entirely and always re-projects from ledger.
    const dir = mkdtempSync(path.join(tmpdir(), 'mandrel-trace-'));
    try {
      const ledgerPath = path.join(dir, 'lifecycle.ndjson');
      writeFileSync(
        ledgerPath,
        SAMPLE_LEDGER.map((r) => JSON.stringify(r)).join('\n'),
        'utf8',
      );
      const tracer = new TraceLogger({ ledgerPath, epicId: 42 });
      tracer.rerender();
      const a = readFileSync(tracer.companionPath, 'utf8');
      // Operator hand-edits the companion.
      writeFileSync(tracer.companionPath, 'EDITED BY OPERATOR\n', 'utf8');
      tracer.rerender();
      const b = readFileSync(tracer.companionPath, 'utf8');
      assert.equal(a, b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A throwing rerender does not propagate out of the bus emit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mandrel-trace-'));
    const originalStderrWrite = process.stderr.write;
    const stderrChunks = [];
    try {
      const bus = new Bus();
      const writer = new LedgerWriter({ epicId: 7, tempRoot: dir });
      writer.register(bus);
      const tracer = new TraceLogger({
        ledgerPath: writer.ledgerPath,
        epicId: 7,
      });
      // Force the companion render to throw on every invocation. The
      // wildcard listener must log+swallow so the in-flight emit still
      // completes and the companion silently degrades to stale.
      tracer.rerender = () => {
        throw new Error('boom: companion render exploded');
      };
      tracer.register(bus);

      // Capture stderr so we can assert the swallow was logged without
      // polluting the test runner output.
      process.stderr.write = (chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      };

      // Emit must resolve (not reject) even though the wildcard listener's
      // rerender throws.
      const result = await bus.emit('epic.snapshot.start', { epicId: 7 });
      process.stderr.write = originalStderrWrite;

      assert.equal(typeof result.seqId, 'number');
      const logged = stderrChunks.join('');
      assert.match(logged, /\[TraceLogger\] companion rerender failed/);
      assert.match(logged, /boom: companion render exploded/);
    } finally {
      process.stderr.write = originalStderrWrite;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
