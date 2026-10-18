/**
 * tests/lifecycle/merge-flip-failed.test.js — Story #5685.
 *
 * Contract for the `merge.flip-failed` lifecycle emitter. Its production
 * caller (`single-story-close/phases/confirm-merge.js`) swallows emit
 * errors, so a regression here would never surface at close — this suite
 * drives the REAL `emitMergeFlipFailed` against a throwaway ledgerPath:
 *   1. the written record validates against
 *      `.agents/schemas/lifecycle/merge.flip-failed.schema.json` and carries
 *      `blockClass: 'merged-flip-failed'`;
 *   2. a missing required field throws before anything is written.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  emitMergeFlipFailed,
  MERGED_FLIP_FAILED_BLOCK_CLASS,
} from '../../.agents/scripts/lib/orchestration/lifecycle/emit-merge-flip-failed.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { createAjv2020 } from '../../.agents/scripts/lib/util/ajv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'lifecycle',
  'merge.flip-failed.schema.json',
);

function compileSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = createAjv2020({ allErrors: true });
  return ajv.compile(schema);
}

function readRecords(ledgerPath) {
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

const VALID_OPTS = Object.freeze({
  scope: 'story',
  ticketId: 5685,
  prNumber: 5700,
  reason: 'agent::done label write failed: HTTP 502',
  elapsedSeconds: 12,
  timestamp: '2026-10-14T12:00:00.000Z',
});

describe('lifecycle/emit-merge-flip-failed', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempLedger(prefix) {
    const root = makeTempDir(prefix);
    roots.push(root);
    return path.join(root, 'ledger.ndjson');
  }

  it('writes a schema-valid merge.flip-failed record to the ledger', () => {
    const ledgerPath = tempLedger('merge-flip-failed-');

    const result = emitMergeFlipFailed({ ...VALID_OPTS, ledgerPath });

    assert.equal(result.ledgerPath, ledgerPath);
    const emitted = readRecords(ledgerPath).find(
      (r) => r.kind === 'emitted' && r.event === 'merge.flip-failed',
    );
    assert.ok(emitted, 'expected an emitted merge.flip-failed record');
    const validate = compileSchema();
    assert.equal(
      validate(emitted.payload),
      true,
      JSON.stringify(validate.errors),
    );
    assert.equal(emitted.payload.blockClass, 'merged-flip-failed');
    assert.equal(MERGED_FLIP_FAILED_BLOCK_CLASS, 'merged-flip-failed');
    assert.deepEqual(emitted.payload, {
      event: 'merge.flip-failed',
      scope: 'story',
      ticketId: 5685,
      prNumber: 5700,
      blockClass: 'merged-flip-failed',
      reason: 'agent::done label write failed: HTTP 502',
      elapsedSeconds: 12,
      timestamp: '2026-10-14T12:00:00.000Z',
    });
  });

  for (const field of [
    'scope',
    'ticketId',
    'prNumber',
    'reason',
    'elapsedSeconds',
  ]) {
    it(`throws without writing when required field "${field}" is missing`, () => {
      const ledgerPath = tempLedger(`merge-flip-failed-no-${field}-`);
      const { [field]: _omitted, ...rest } = VALID_OPTS;

      assert.throws(
        () => emitMergeFlipFailed({ ...rest, ledgerPath }),
        /emitMergeFlipFailed:/,
      );
      assert.equal(existsSync(ledgerPath), false);
    });
  }

  it('throws on a missing options object', () => {
    assert.throws(() => emitMergeFlipFailed(), /emitMergeFlipFailed:/);
  });
});
