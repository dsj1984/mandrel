// tests/scripts/recurring-failure-detector.test.js
/**
 * Unit test for the pure helper from Story #3062 Task #3072. Feeds the
 * detector synthetic ledger fixtures and asserts grouping by `failedGate`,
 * storyId uniqueness, and the no-recurrence empty-array case.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { detectRecurringFailures } from '../../.agents/scripts/lib/orchestration/recurring-failure-detector.js';

/**
 * Build a synthetic `close-validate.end` emitted record matching the
 * shape `LedgerWriter.buildEmitted` produces.
 */
function emitted({ seqId, ts, storyId, failedGate, ok = false }) {
  const payload = { epicId: 3051, storyId, ok };
  if (failedGate !== undefined) payload.failedGate = failedGate;
  return {
    kind: 'emitted',
    seqId,
    ts,
    event: 'close-validate.end',
    payload,
  };
}

describe('recurring-failure-detector', () => {
  it('emits one finding when two distinct stories share a failed gate', () => {
    const records = [
      emitted({
        seqId: 1,
        ts: '2026-05-26T10:00:00.000Z',
        storyId: 9101,
        failedGate: 'lint',
      }),
      emitted({
        seqId: 2,
        ts: '2026-05-26T10:05:00.000Z',
        storyId: 9102,
        failedGate: 'lint',
      }),
    ];

    const findings = detectRecurringFailures(3051, { records });

    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0], {
      gate: 'lint',
      storyIds: [9101, 9102],
      firstSeenAt: '2026-05-26T10:00:00.000Z',
      lastSeenAt: '2026-05-26T10:05:00.000Z',
    });
  });

  it('emits one finding with three storyIds when three stories share a gate', () => {
    const records = [
      emitted({
        seqId: 1,
        ts: '2026-05-26T10:00:00.000Z',
        storyId: 9101,
        failedGate: 'test',
      }),
      emitted({
        seqId: 2,
        ts: '2026-05-26T10:01:00.000Z',
        storyId: 9102,
        failedGate: 'test',
      }),
      emitted({
        seqId: 3,
        ts: '2026-05-26T10:02:00.000Z',
        storyId: 9103,
        failedGate: 'test',
      }),
    ];

    const findings = detectRecurringFailures(3051, { records });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].gate, 'test');
    assert.deepEqual(findings[0].storyIds, [9101, 9102, 9103]);
    assert.equal(findings[0].firstSeenAt, '2026-05-26T10:00:00.000Z');
    assert.equal(findings[0].lastSeenAt, '2026-05-26T10:02:00.000Z');
  });

  it('returns an empty array when every story has a distinct gate', () => {
    const records = [
      emitted({
        seqId: 1,
        ts: '2026-05-26T10:00:00.000Z',
        storyId: 9101,
        failedGate: 'lint',
      }),
      emitted({
        seqId: 2,
        ts: '2026-05-26T10:01:00.000Z',
        storyId: 9102,
        failedGate: 'test',
      }),
      emitted({
        seqId: 3,
        ts: '2026-05-26T10:02:00.000Z',
        storyId: 9103,
        failedGate: 'format',
      }),
    ];

    const findings = detectRecurringFailures(3051, { records });

    assert.deepEqual(findings, []);
  });

  it('treats repeated failures from the same single story as not recurring', () => {
    const records = [
      emitted({
        seqId: 1,
        ts: '2026-05-26T10:00:00.000Z',
        storyId: 9101,
        failedGate: 'lint',
      }),
      emitted({
        seqId: 2,
        ts: '2026-05-26T10:05:00.000Z',
        storyId: 9101,
        failedGate: 'lint',
      }),
    ];

    const findings = detectRecurringFailures(3051, { records });

    assert.deepEqual(findings, []);
  });

  it('ignores ok:true close-validate.end records', () => {
    const records = [
      emitted({
        seqId: 1,
        ts: '2026-05-26T10:00:00.000Z',
        storyId: 9101,
        ok: true,
      }),
      emitted({
        seqId: 2,
        ts: '2026-05-26T10:05:00.000Z',
        storyId: 9102,
        ok: true,
      }),
    ];

    const findings = detectRecurringFailures(3051, { records });

    assert.deepEqual(findings, []);
  });

  it('ignores unrelated event kinds (e.g. story.heartbeat, completed)', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 1,
        ts: '2026-05-26T10:00:00.000Z',
        event: 'story.heartbeat',
        payload: { storyId: 9101 },
      },
      {
        kind: 'completed',
        seqId: 1,
        ts: '2026-05-26T10:00:00.001Z',
        event: 'close-validate.end',
      },
      emitted({
        seqId: 2,
        ts: '2026-05-26T10:01:00.000Z',
        storyId: 9102,
        failedGate: 'lint',
      }),
    ];

    const findings = detectRecurringFailures(3051, { records });

    // Only one story registered a real close-validate.end failure → not recurring.
    assert.deepEqual(findings, []);
  });

  it('sorts findings lexicographically by gate for determinism', () => {
    const records = [
      emitted({
        seqId: 1,
        ts: '2026-05-26T10:00:00.000Z',
        storyId: 9101,
        failedGate: 'test',
      }),
      emitted({
        seqId: 2,
        ts: '2026-05-26T10:01:00.000Z',
        storyId: 9102,
        failedGate: 'test',
      }),
      emitted({
        seqId: 3,
        ts: '2026-05-26T10:02:00.000Z',
        storyId: 9103,
        failedGate: 'lint',
      }),
      emitted({
        seqId: 4,
        ts: '2026-05-26T10:03:00.000Z',
        storyId: 9104,
        failedGate: 'lint',
      }),
    ];

    const findings = detectRecurringFailures(3051, { records });

    assert.equal(findings.length, 2);
    assert.equal(findings[0].gate, 'lint');
    assert.equal(findings[1].gate, 'test');
  });

  it('reads + parses an NDJSON ledger from disk when records[] is omitted', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'recurring-failure-'));
    try {
      const ledgerPath = path.join(sandbox, 'lifecycle.ndjson');
      const lines = [
        emitted({
          seqId: 1,
          ts: '2026-05-26T10:00:00.000Z',
          storyId: 9101,
          failedGate: 'lint',
        }),
        emitted({
          seqId: 2,
          ts: '2026-05-26T10:05:00.000Z',
          storyId: 9102,
          failedGate: 'lint',
        }),
      ];
      writeFileSync(
        ledgerPath,
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
        'utf8',
      );

      const findings = detectRecurringFailures(3051, { ledgerPath });

      assert.equal(findings.length, 1);
      assert.equal(findings[0].gate, 'lint');
      assert.deepEqual(findings[0].storyIds, [9101, 9102]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('returns [] when the ledger file does not exist (stateless tick contract)', () => {
    const ledgerPath = path.join(
      tmpdir(),
      `does-not-exist-${Date.now()}-${Math.random()}.ndjson`,
    );
    const findings = detectRecurringFailures(3051, { ledgerPath });
    assert.deepEqual(findings, []);
  });

  it('throws TypeError on a non-positive-integer epicId', () => {
    assert.throws(
      () => detectRecurringFailures(0, { records: [] }),
      /epicId must be a positive integer/,
    );
    assert.throws(
      () => detectRecurringFailures('3051', { records: [] }),
      /epicId must be a positive integer/,
    );
  });
});
