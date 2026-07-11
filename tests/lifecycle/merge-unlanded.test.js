/**
 * tests/lifecycle/merge-unlanded.test.js — Story #4426 (Epic #4425).
 *
 * Contract for the `merge.unlanded` lifecycle event:
 *   1. The schema exists and validates a sample payload carrying scope,
 *      ticketId, prNumber, blockClass, reason, and elapsedSeconds — and
 *      rejects an unknown blockClass value.
 *   2. `emitMergeUnlanded` (pattern of `emit-story-heartbeat.js`) writes
 *      a schema-valid `emitted` record to the ledger.
 *   3. A `scope: 'story'` emit has a defined on-disk ledger destination
 *      — the story-scope seam in `temp-paths.js` (`storyLedgerPath`) —
 *      asserted here by writing through the REAL resolved path (not an
 *      injected fake) under a throwaway tempRoot and reading it back.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  epicLedgerPath,
  storyLedgerPath,
} from '../../.agents/scripts/lib/config/temp-paths.js';
import { emitMergeUnlanded } from '../../.agents/scripts/lib/orchestration/lifecycle/emit-merge-unlanded.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'lifecycle',
  'merge.unlanded.schema.json',
);

function compileSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function readRecords(ledgerPath) {
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

const SAMPLE_PAYLOAD = Object.freeze({
  event: 'merge.unlanded',
  scope: 'epic',
  ticketId: 4425,
  prNumber: 4440,
  blockClass: 'checks-pending-timeout',
  reason: 'watch budget exhausted after 3600 seconds with checks still pending',
  elapsedSeconds: 3600,
  timestamp: '2026-07-11T12:00:00.000Z',
});

describe('lifecycle/merge.unlanded schema', () => {
  it('validates a sample merge.unlanded payload', () => {
    const validate = compileSchema();
    const ok = validate(SAMPLE_PAYLOAD);
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects a payload missing a required field', () => {
    const validate = compileSchema();
    const { reason: _reason, ...withoutReason } = SAMPLE_PAYLOAD;
    const ok = validate(withoutReason);
    assert.equal(ok, false);
  });

  it('rejects an unknown blockClass value', () => {
    const validate = compileSchema();
    const ok = validate({ ...SAMPLE_PAYLOAD, blockClass: 'gremlins-ate-it' });
    assert.equal(ok, false);
  });

  it('rejects an out-of-enum scope value', () => {
    const validate = compileSchema();
    const ok = validate({ ...SAMPLE_PAYLOAD, scope: 'task' });
    assert.equal(ok, false);
  });

  it('rejects an unknown additional property (strict shape)', () => {
    const validate = compileSchema();
    const ok = validate({ ...SAMPLE_PAYLOAD, storyId: 4426 });
    assert.equal(ok, false);
  });
});

describe('lifecycle/emit-merge-unlanded', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scope:"epic" emits a schema-valid record at the canonical epic ledger path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'merge-unlanded-epic-'));
    roots.push(root);
    const config = { project: { paths: { tempRoot: root } } };

    const result = emitMergeUnlanded({
      scope: 'epic',
      ticketId: 4425,
      prNumber: 4440,
      blockClass: 'branch-protection-human-required',
      reason:
        'PR requires human action (reviewDecision=REVIEW_REQUIRED, mergeStateStatus=BLOCKED)',
      elapsedSeconds: 120,
      timestamp: '2026-07-11T12:05:00.000Z',
      config,
    });

    const expectedPath = epicLedgerPath(4425, config);
    assert.equal(result.ledgerPath, expectedPath);

    const validate = compileSchema();
    const records = readRecords(expectedPath);
    const emitted = records.find(
      (r) => r.kind === 'emitted' && r.event === 'merge.unlanded',
    );
    assert.ok(
      emitted,
      'expected an emitted merge.unlanded record in the ledger',
    );
    assert.equal(
      validate(emitted.payload),
      true,
      JSON.stringify(validate.errors),
    );
    assert.equal(emitted.payload.scope, 'epic');
    assert.equal(emitted.payload.ticketId, 4425);
  });

  it('scope:"story" resolves the story-scope ledger destination and round-trips through it (not only via injected fakes)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'merge-unlanded-story-'));
    roots.push(root);
    const config = { project: { paths: { tempRoot: root } } };

    const result = emitMergeUnlanded({
      scope: 'story',
      ticketId: 4428,
      prNumber: 4441,
      blockClass: 'arm-failure',
      reason: 'gh pr merge --auto failed: rate limit exceeded',
      elapsedSeconds: 5,
      timestamp: '2026-07-11T12:10:00.000Z',
      config,
    });

    // Assert against the REAL resolved storyLedgerPath (eid=null,
    // standalone) — not a caller-supplied override — so the seam
    // extended in temp-paths.js is what's actually under test.
    const expectedPath = storyLedgerPath(null, 4428, config);
    assert.equal(result.ledgerPath, expectedPath);
    assert.ok(
      expectedPath.includes(path.join('standalone', 'stories', 'story-4428')),
      `expected the standalone story-scope layout, got ${expectedPath}`,
    );

    const validate = compileSchema();
    const records = readRecords(expectedPath);
    const emitted = records.find(
      (r) => r.kind === 'emitted' && r.event === 'merge.unlanded',
    );
    assert.ok(
      emitted,
      'expected an emitted merge.unlanded record in the story-scope ledger',
    );
    assert.equal(
      validate(emitted.payload),
      true,
      JSON.stringify(validate.errors),
    );
    assert.deepEqual(emitted.payload, {
      event: 'merge.unlanded',
      scope: 'story',
      ticketId: 4428,
      prNumber: 4441,
      blockClass: 'arm-failure',
      reason: 'gh pr merge --auto failed: rate limit exceeded',
      elapsedSeconds: 5,
      timestamp: '2026-07-11T12:10:00.000Z',
    });
  });

  it('rejects an invalid blockClass before writing anything to disk', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'merge-unlanded-invalid-'));
    roots.push(root);
    const config = { project: { paths: { tempRoot: root } } };

    assert.throws(() =>
      emitMergeUnlanded({
        scope: 'epic',
        ticketId: 4425,
        prNumber: 4440,
        blockClass: 'not-a-real-class',
        reason: 'should never be written',
        elapsedSeconds: 1,
        config,
      }),
    );
  });
});
