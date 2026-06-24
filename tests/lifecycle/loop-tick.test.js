// tests/lifecycle/loop-tick.test.js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { emitLoopTick } from '../../.agents/scripts/lib/orchestration/lifecycle/emit-loop-tick.js';

/**
 * Contract for the `loop.tick` lifecycle event (Story #4287, Epic #4284).
 *
 * Two binding acceptance criteria are pinned here:
 *   1. The `loop.tick` schema exists and validates a sample payload
 *      `{ loopName, round, cadence, status, timestamp }` (plus the
 *      `event` const). Negative cases prove the strict shape.
 *   2. Emitting a `loop.tick` THROUGH the lifecycle bus appends a record
 *      to the per-run ledger — asserted by reading the NDJSON ledger back
 *      and finding the `emitted` line carrying the payload.
 *
 * The ledger is written under a per-test OS temp dir so the suite never
 * touches the repo's `temp/` tree and stays parallel-safe.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'lifecycle',
  'loop.tick.schema.json',
);

function compileSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Build a canonical ledger path under a throwaway temp root. */
function makeLedger(epicId) {
  const root = mkdtempSync(path.join(tmpdir(), 'loop-tick-'));
  return {
    root,
    ledgerPath: path.join(root, `epic-${epicId}`, 'lifecycle.ndjson'),
  };
}

function readRecords(ledgerPath) {
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('lifecycle/loop.tick schema', () => {
  it('validates a sample loop.tick payload', () => {
    const validate = compileSchema();
    const ok = validate({
      event: 'loop.tick',
      loopName: 'pr-babysit',
      round: 3,
      cadence: '5m',
      status: 'running',
      timestamp: '2026-06-24T14:39:06.208Z',
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects a payload missing a required field', () => {
    const validate = compileSchema();
    const ok = validate({
      event: 'loop.tick',
      loopName: 'pr-babysit',
      round: 3,
      cadence: '5m',
      // status omitted
      timestamp: '2026-06-24T14:39:06.208Z',
    });
    assert.equal(ok, false);
  });

  it('rejects an out-of-enum status', () => {
    const validate = compileSchema();
    const ok = validate({
      event: 'loop.tick',
      loopName: 'pr-babysit',
      round: 3,
      cadence: '5m',
      status: 'paused',
      timestamp: '2026-06-24T14:39:06.208Z',
    });
    assert.equal(ok, false);
  });

  it('rejects an unknown additional property (strict shape)', () => {
    const validate = compileSchema();
    const ok = validate({
      event: 'loop.tick',
      loopName: 'pr-babysit',
      round: 3,
      cadence: '5m',
      status: 'running',
      timestamp: '2026-06-24T14:39:06.208Z',
      storyId: 4287,
    });
    assert.equal(ok, false);
  });
});

describe('lifecycle/emit-loop-tick', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits loop.tick through the bus and appends an emitted record to the ledger', async () => {
    const { root, ledgerPath } = makeLedger(4284);
    roots.push(root);

    const result = await emitLoopTick({
      loopName: 'pr-babysit',
      round: 1,
      cadence: '5m',
      status: 'running',
      timestamp: '2026-06-24T14:39:06.208Z',
      ledgerPath,
    });

    assert.equal(result.ledgerPath, ledgerPath);

    const records = readRecords(ledgerPath);
    const emitted = records.find(
      (r) => r.kind === 'emitted' && r.event === 'loop.tick',
    );
    assert.ok(emitted, 'expected an emitted loop.tick record in the ledger');
    assert.deepEqual(emitted.payload, {
      event: 'loop.tick',
      loopName: 'pr-babysit',
      round: 1,
      cadence: '5m',
      status: 'running',
      timestamp: '2026-06-24T14:39:06.208Z',
    });

    // The bus path also writes the `completed` boundary record.
    const completed = records.find(
      (r) => r.kind === 'completed' && r.event === 'loop.tick',
    );
    assert.ok(completed, 'expected a completed loop.tick record in the ledger');
  });

  it('rejects an invalid status before any ledger write', async () => {
    const { root, ledgerPath } = makeLedger(4284);
    roots.push(root);
    await assert.rejects(
      () =>
        emitLoopTick({
          loopName: 'pr-babysit',
          round: 1,
          cadence: '5m',
          status: 'paused',
          ledgerPath,
        }),
      /status "paused" must be one of/,
    );
  });

  it('requires exactly one of epicId or ledgerPath', async () => {
    await assert.rejects(
      () =>
        emitLoopTick({
          loopName: 'pr-babysit',
          round: 1,
          cadence: '5m',
        }),
      /supply exactly one of epicId or ledgerPath/,
    );
  });
});
