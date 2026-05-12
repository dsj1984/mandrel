import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendEpicSignal as observabilityAppendEpicSignal,
  appendSignal as observabilityAppendSignal,
  appendTrace as observabilityAppendTrace,
  forEachLine as observabilityForEachLine,
} from '../.agents/scripts/lib/observability/signals-writer.js';
import {
  appendEpicSignal as barrelAppendEpicSignal,
  appendSignal as barrelAppendSignal,
  appendTrace as barrelAppendTrace,
  forEachLine as barrelForEachLine,
  buildSpanTree,
  read,
  schema,
} from '../.agents/scripts/lib/signals/index.js';
import {
  appendEpicSignal as writeAppendEpicSignal,
  appendSignal as writeAppendSignal,
  appendTrace as writeAppendTrace,
  forEachLine as writeForEachLine,
} from '../.agents/scripts/lib/signals/write.js';

/**
 * Story #1476 — `lib/signals/` now re-exports the writer surface so new
 * code can converge on one barrel for both reads and writes. The
 * implementation still lives in `lib/observability/signals-writer.js`;
 * the re-export must point at the same function objects so behaviour is
 * literally identical and tests/mocks that swap the implementation by
 * reference work transparently.
 */

describe('lib/signals/write.js — writer re-export', () => {
  it('appendSignal is identity-equal to the observability writer', () => {
    assert.equal(writeAppendSignal, observabilityAppendSignal);
  });
  it('appendEpicSignal is identity-equal to the observability writer', () => {
    assert.equal(writeAppendEpicSignal, observabilityAppendEpicSignal);
  });
  it('appendTrace is identity-equal to the observability writer', () => {
    assert.equal(writeAppendTrace, observabilityAppendTrace);
  });
  it('forEachLine is identity-equal to the observability writer', () => {
    assert.equal(writeForEachLine, observabilityForEachLine);
  });
});

describe('lib/signals/index.js — barrel surface', () => {
  it('exposes the writer surface via the barrel', () => {
    assert.equal(barrelAppendSignal, observabilityAppendSignal);
    assert.equal(barrelAppendEpicSignal, observabilityAppendEpicSignal);
    assert.equal(barrelAppendTrace, observabilityAppendTrace);
    assert.equal(barrelForEachLine, observabilityForEachLine);
  });

  it('keeps the legacy reader / schema / span-tree exports', () => {
    assert.equal(typeof read, 'function');
    assert.equal(typeof buildSpanTree, 'function');
    assert.equal(typeof schema, 'object');
  });
});
