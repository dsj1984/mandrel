/**
 * Unit tests for `emit-slice-lifecycle.js` (Epic #4475, M4-A).
 *
 * Covers the three single-delivery slice lifecycle emitters — schema-valid
 * append, the `emitted` envelope shape, optional-field inclusion, and the
 * argument/enum guards. The events are introduced INERT (no executor emits
 * them until M4-B), so these are the only exercise the emitters get in this
 * milestone.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  emitSliceEnd,
  emitSliceHeartbeat,
  emitSliceStart,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/emit-slice-lifecycle.js';

describe('emit-slice-lifecycle', () => {
  let dir;
  let ledgerPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slice-lifecycle-'));
    ledgerPath = path.join(dir, 'lifecycle.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('slice.start appends one schema-valid emitted record', () => {
    const { record } = emitSliceStart({
      epicId: 4475,
      sliceId: 'slice-1',
      sliceIndex: 0,
      title: 'Seed the schema',
      timestamp: '2026-07-13T00:00:00.000Z',
      ledgerPath,
    });
    assert.equal(record.kind, 'emitted');
    assert.equal(record.event, 'slice.start');
    assert.deepEqual(record.payload, {
      event: 'slice.start',
      epicId: 4475,
      sliceId: 'slice-1',
      sliceIndex: 0,
      title: 'Seed the schema',
      timestamp: '2026-07-13T00:00:00.000Z',
    });
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  });

  it('slice.start omits optional fields when absent', () => {
    const { record } = emitSliceStart({
      epicId: 1,
      sliceId: 'slice-2',
      timestamp: '2026-07-13T00:00:00.000Z',
      ledgerPath,
    });
    assert.deepEqual(record.payload, {
      event: 'slice.start',
      epicId: 1,
      sliceId: 'slice-2',
      timestamp: '2026-07-13T00:00:00.000Z',
    });
  });

  it('slice.end records the outcome + durationMs', () => {
    const { record } = emitSliceEnd({
      epicId: 4475,
      sliceId: 'slice-1',
      outcome: 'done',
      durationMs: 4200,
      timestamp: '2026-07-13T00:00:01.000Z',
      ledgerPath,
    });
    assert.equal(record.event, 'slice.end');
    assert.equal(record.payload.outcome, 'done');
    assert.equal(record.payload.durationMs, 4200);
  });

  it('slice.heartbeat includes operator only when supplied', () => {
    const withOp = emitSliceHeartbeat({
      epicId: 4475,
      sliceId: 'slice-1',
      phase: 'implementing',
      operator: 'dsj1984',
      timestamp: '2026-07-13T00:00:02.000Z',
      ledgerPath,
    });
    assert.equal(withOp.record.payload.operator, 'dsj1984');

    const noOp = emitSliceHeartbeat({
      epicId: 4475,
      sliceId: 'slice-1',
      timestamp: '2026-07-13T00:00:03.000Z',
      ledgerPath,
    });
    assert.equal('operator' in noOp.record.payload, false);
    assert.equal(noOp.record.payload.phase, 'implementing');
  });

  it('guards reject bad arguments and enum values', () => {
    assert.throws(
      () => emitSliceStart({ epicId: 0, sliceId: 'slice-1', ledgerPath }),
      /epicId must be a positive integer/,
    );
    assert.throws(
      () => emitSliceStart({ epicId: 1, sliceId: '', ledgerPath }),
      /sliceId must be a non-empty string/,
    );
    assert.throws(
      () =>
        emitSliceEnd({
          epicId: 1,
          sliceId: 'slice-1',
          outcome: 'nope',
          ledgerPath,
        }),
      /outcome "nope" must be one of/,
    );
    assert.throws(
      () =>
        emitSliceHeartbeat({
          epicId: 1,
          sliceId: 'slice-1',
          phase: 'nope',
          ledgerPath,
        }),
      /phase "nope" must be one of/,
    );
    assert.throws(
      () =>
        emitSliceHeartbeat({
          epicId: 1,
          sliceId: 'slice-1',
          operator: '',
          ledgerPath,
        }),
      /operator, when supplied/,
    );
  });
});
