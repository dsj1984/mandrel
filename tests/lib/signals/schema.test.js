/**
 * Unit tests for `lib/signals/schema.js` (Epic #1181 / Story #1438;
 * canonical-envelope cutover Epic #4406 / Story #4413).
 *
 * Covers:
 *   - The enumeration covers the exact set of kinds emitted by the
 *     signals writer call sites (the `dispatched` kind was retired).
 *   - `hasCommonEnvelope` enforces the canonical envelope (`ts`, `epicId`,
 *     `kind`) — the legacy `timestamp` / `epic` aliases are rejected.
 *   - Importing the schema has no I/O side effects (pure module).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_KIND_VALUES,
  EVENT_KINDS,
  FIELDS,
  hasCommonEnvelope,
  isValidSignal,
} from '../../../.agents/scripts/lib/signals/schema.js';

describe('signals/schema — EVENT_KINDS enumeration', () => {
  it('covers the kinds emitted by signals-writer call sites (no `dispatched`)', () => {
    const expected = new Set([
      'friction',
      'trace',
      'wave-start',
      'wave-end',
      'wave-complete',
      'state-transition',
      'hotspot',
      'rework',
      'churn',
      'idle',
      'retry',
      'acceptance-eval',
      'notification.emitted',
    ]);
    const actual = new Set(Object.values(EVENT_KINDS));
    assert.deepEqual(actual, expected);
  });

  it('does not carry the retired `dispatched` kind', () => {
    assert.equal(EVENT_KIND_VALUES.has('dispatched'), false);
    assert.equal(Object.hasOwn(EVENT_KINDS, 'DISPATCHED'), false);
  });

  it('freezes the EVENT_KINDS object so consumers can use it as a constant', () => {
    assert.equal(Object.isFrozen(EVENT_KINDS), true);
    assert.equal(Object.isFrozen(EVENT_KIND_VALUES), true);
  });

  it('exports the canonical envelope and payload field-name constants', () => {
    assert.equal(FIELDS.TS, 'ts');
    assert.equal(FIELDS.EPIC_ID, 'epicId');
    assert.equal(FIELDS.STORY_ID, 'storyId');
    assert.equal(FIELDS.TASK_ID, 'taskId');
    assert.equal(FIELDS.KIND, 'kind');
    assert.equal(FIELDS.EMITTER, 'emitter');
    assert.equal(FIELDS.SOURCE, 'source');
    assert.equal(FIELDS.CATEGORY, 'category');
    // The legacy `timestamp` / `epic` / `story` / `task` aliases are gone.
    assert.equal(Object.hasOwn(FIELDS, 'TIMESTAMP'), false);
    assert.equal(Object.hasOwn(FIELDS, 'EPIC'), false);
    assert.equal(Object.hasOwn(FIELDS, 'STORY'), false);
    assert.equal(Object.hasOwn(FIELDS, 'TASK'), false);
  });
});

describe('signals/schema — hasCommonEnvelope', () => {
  const baseEnvelope = {
    kind: 'friction',
    ts: '2026-05-11T00:00:00.000Z',
    epicId: 1181,
  };

  it('accepts a record carrying ts + epicId + kind', () => {
    assert.equal(hasCommonEnvelope(baseEnvelope), true);
  });

  it('rejects the legacy `timestamp` alias', () => {
    assert.equal(
      hasCommonEnvelope({
        kind: 'friction',
        timestamp: '2026-05-11T00:00:00.000Z',
        epicId: 1181,
      }),
      false,
    );
  });

  it('rejects the legacy `epic` alias', () => {
    assert.equal(
      hasCommonEnvelope({
        kind: 'friction',
        ts: '2026-05-11T00:00:00.000Z',
        epic: 1181,
      }),
      false,
    );
  });

  it('rejects records missing ts', () => {
    const { ts: _ts, ...evt } = baseEnvelope;
    assert.equal(hasCommonEnvelope(evt), false);
  });

  it('rejects records missing epicId', () => {
    const { epicId: _epicId, ...evt } = baseEnvelope;
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

  it('rejects records whose epicId is not a positive integer', () => {
    assert.equal(hasCommonEnvelope({ ...baseEnvelope, epicId: 0 }), false);
    assert.equal(hasCommonEnvelope({ ...baseEnvelope, epicId: -3 }), false);
    assert.equal(hasCommonEnvelope({ ...baseEnvelope, epicId: 1.5 }), false);
    assert.equal(hasCommonEnvelope({ ...baseEnvelope, epicId: 'a' }), false);
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
    const evt = { kind: 'trace', ts: '2026-05-11T00:00:00.000Z', epicId: 1181 };
    assert.equal(isValidSignal(evt, 'trace'), true);
  });

  it('rejects an event whose kind does not match the filter', () => {
    const evt = { kind: 'trace', ts: '2026-05-11T00:00:00.000Z', epicId: 1181 };
    assert.equal(isValidSignal(evt, 'friction'), false);
  });

  it('accepts any well-formed envelope when no `kind` filter is supplied', () => {
    const evt = { kind: 'retry', ts: '2026-05-11T00:00:00.000Z', epicId: 1181 };
    assert.equal(isValidSignal(evt), true);
  });
});

describe('signals/schema — purity', () => {
  it('importing the module has no I/O side effects', async () => {
    const mod = await import('../../../.agents/scripts/lib/signals/schema.js');
    assert.equal(typeof mod.EVENT_KINDS, 'object');
    assert.equal(typeof mod.hasCommonEnvelope, 'function');
    assert.equal(typeof mod.isValidSignal, 'function');
    assert.equal(Object.hasOwn(mod, 'GUARDS'), false);
  });
});
