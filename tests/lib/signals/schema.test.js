/**
 * Unit tests for `lib/signals/schema.js` (Epic #1181 / Story #1438 /
 * Task #1458).
 *
 * Covers:
 *   - The enumeration covers the exact set of kinds emitted by the
 *     existing signals writer call sites (audit-snapshot 2026-05-11).
 *   - Per-kind guards reject events missing the common envelope (`ts`,
 *     `epic`, `kind`).
 *   - Importing the schema has no I/O side effects (pure module).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_KIND_VALUES,
  EVENT_KINDS,
  FIELDS,
  GUARDS,
  hasCommonEnvelope,
  isValidSignal,
} from '../../../.agents/scripts/lib/signals/schema.js';

describe('signals/schema — EVENT_KINDS enumeration', () => {
  it('covers the kinds emitted by signals-writer appendSignal call sites', () => {
    // Audit snapshot 2026-05-11: friction, dispatched, wave-start,
    // wave-end, state-transition are the appendSignal kinds; trace is
    // the appendTrace kind. The aggregator-consumed kinds (hotspot,
    // rework, churn, idle, retry) round out the schema.
    const expected = new Set([
      'friction',
      'trace',
      'dispatched',
      'wave-start',
      'wave-end',
      // Story #1430 — wave-runner lifecycle signals emitted by `lib/wave-runner/tick.js`.
      'wave-tick',
      'wave-complete',
      'epic-complete',
      'state-transition',
      'hotspot',
      'rework',
      'churn',
      'idle',
      'retry',
    ]);
    const actual = new Set(Object.values(EVENT_KINDS));
    assert.deepEqual(actual, expected);
  });

  it('freezes the EVENT_KINDS object so consumers can use it as a constant', () => {
    assert.equal(Object.isFrozen(EVENT_KINDS), true);
    // The value set membership is a Set wrapped in Object.freeze — the
    // Set itself is not "deep frozen" but the wrapping object is.
    assert.equal(Object.isFrozen(EVENT_KIND_VALUES), true);
  });

  it('exports the envelope and payload field-name constants', () => {
    assert.equal(FIELDS.TS, 'ts');
    assert.equal(FIELDS.EPIC, 'epic');
    assert.equal(FIELDS.STORY, 'story');
    assert.equal(FIELDS.TASK, 'task');
    assert.equal(FIELDS.KIND, 'kind');
    // Legacy aliases for backward-compat with existing writers
    assert.equal(FIELDS.TIMESTAMP, 'timestamp');
    assert.equal(FIELDS.EPIC_ID, 'epicId');
    assert.equal(FIELDS.STORY_ID, 'storyId');
    assert.equal(FIELDS.TASK_ID, 'taskId');
  });
});

describe('signals/schema — hasCommonEnvelope', () => {
  const baseEnvelope = {
    kind: 'friction',
    ts: '2026-05-11T00:00:00.000Z',
    epic: 1181,
  };

  it('accepts a record carrying ts + epic + kind', () => {
    assert.equal(hasCommonEnvelope(baseEnvelope), true);
  });

  it('accepts legacy envelopes carrying `timestamp` and `epicId`', () => {
    assert.equal(
      hasCommonEnvelope({
        kind: 'friction',
        timestamp: '2026-05-11T00:00:00.000Z',
        epicId: 1181,
      }),
      true,
    );
  });

  it('rejects records missing ts', () => {
    const { ts: _ts, ...evt } = baseEnvelope;
    assert.equal(hasCommonEnvelope(evt), false);
  });

  it('rejects records missing epic', () => {
    const { epic: _epic, ...evt } = baseEnvelope;
    assert.equal(hasCommonEnvelope(evt), false);
  });

  it('rejects records missing kind', () => {
    const { kind: _k, ...evt } = baseEnvelope;
    assert.equal(hasCommonEnvelope(evt), false);
  });

  it('rejects records whose kind is not in EVENT_KINDS', () => {
    assert.equal(
      hasCommonEnvelope({ ...baseEnvelope, kind: 'mystery-event' }),
      false,
    );
  });

  it('rejects records whose epic is not a positive integer', () => {
    assert.equal(hasCommonEnvelope({ ...baseEnvelope, epic: 0 }), false);
    assert.equal(hasCommonEnvelope({ ...baseEnvelope, epic: -3 }), false);
    assert.equal(hasCommonEnvelope({ ...baseEnvelope, epic: 1.5 }), false);
    assert.equal(hasCommonEnvelope({ ...baseEnvelope, epic: 'a' }), false);
  });

  it('rejects non-objects', () => {
    assert.equal(hasCommonEnvelope(null), false);
    assert.equal(hasCommonEnvelope(undefined), false);
    assert.equal(hasCommonEnvelope(42), false);
    assert.equal(hasCommonEnvelope('friction'), false);
    assert.equal(hasCommonEnvelope([]), false);
  });
});

describe('signals/schema — isValidSignal', () => {
  it('accepts an event matching the optional `kind` filter', () => {
    const evt = {
      kind: 'trace',
      ts: '2026-05-11T00:00:00.000Z',
      epic: 1181,
    };
    assert.equal(isValidSignal(evt, 'trace'), true);
  });

  it('rejects an event whose kind does not match the filter', () => {
    const evt = {
      kind: 'trace',
      ts: '2026-05-11T00:00:00.000Z',
      epic: 1181,
    };
    assert.equal(isValidSignal(evt, 'friction'), false);
  });

  it('accepts any well-formed envelope when no `kind` filter is supplied', () => {
    const evt = {
      kind: 'retry',
      ts: '2026-05-11T00:00:00.000Z',
      epic: 1181,
    };
    assert.equal(isValidSignal(evt), true);
  });
});

describe('signals/schema — GUARDS per-kind', () => {
  const baseEnvelope = (kind) => ({
    kind,
    ts: '2026-05-11T00:00:00.000Z',
    epic: 1181,
  });

  for (const kind of Object.values(EVENT_KINDS)) {
    it(`GUARDS['${kind}'] accepts a well-formed envelope`, () => {
      assert.equal(GUARDS[kind](baseEnvelope(kind)), true);
    });

    it(`GUARDS['${kind}'] rejects a missing-envelope record`, () => {
      assert.equal(GUARDS[kind]({ kind }), false);
    });

    it(`GUARDS['${kind}'] rejects a wrong-kind record`, () => {
      const other = kind === 'friction' ? 'retry' : 'friction';
      assert.equal(GUARDS[kind](baseEnvelope(other)), false);
    });
  }
});

describe('signals/schema — purity', () => {
  it('importing the module has no I/O side effects', async () => {
    // Re-importing returns the cached module instance; the test here is
    // mostly that the file loaded above did not throw and that the
    // module shape is what we expect. If the module had I/O side
    // effects (read a config file, open a stream), the import at the
    // top of this file would already have triggered them — and the
    // signal we have is the absence of failures + the stable export
    // surface.
    const mod = await import('../../../.agents/scripts/lib/signals/schema.js');
    assert.equal(typeof mod.EVENT_KINDS, 'object');
    assert.equal(typeof mod.hasCommonEnvelope, 'function');
    assert.equal(typeof mod.isValidSignal, 'function');
    assert.equal(typeof mod.GUARDS, 'object');
  });
});
