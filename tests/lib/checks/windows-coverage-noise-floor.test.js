/**
 * Unit tests for the windows-coverage-noise-floor check.
 *
 * The check reads `state.coverage = { branchDelta, noiseFloor?, file? }`
 * and warns when the absolute delta is within (or equal to) the
 * configured noise floor (default 0.25%). Above the floor, the delta
 * is treated as real signal and the check returns null.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/windows-coverage-noise-floor.js';

describe('windows-coverage-noise-floor.detect', () => {
  it('returns a warning finding when the absolute delta is within the default 0.25% floor', () => {
    const finding = check.detect({
      coverage: { branchDelta: 0.0015, file: 'foo/bar.js' },
    });
    assert.ok(finding, 'expected a warning finding');
    assert.equal(finding.id, 'windows-coverage-noise-floor');
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.autoCorrectable, false);
    assert.match(finding.summary, /Windows noise floor/);
    assert.match(finding.summary, /foo\/bar\.js/);
  });

  it('treats a negative delta within the floor as a flap (absolute value)', () => {
    const finding = check.detect({
      coverage: { branchDelta: -0.0012 },
    });
    assert.ok(finding);
    assert.match(finding.summary, /-0\.120%/);
  });

  it('returns null when the delta exceeds the noise floor (real signal)', () => {
    const finding = check.detect({
      coverage: { branchDelta: 0.005, file: 'big-drop.js' },
    });
    assert.equal(finding, null);
  });

  it('honors a custom noiseFloor override', () => {
    // 0.5% delta is well over the default 0.25% floor — would return
    // null with defaults — but a custom 1% floor treats it as flap.
    const finding = check.detect({
      coverage: { branchDelta: 0.005, noiseFloor: 0.01 },
    });
    assert.ok(finding);
    assert.match(finding.summary, /1\.000%/);
  });

  it('returns null when coverage state is absent', () => {
    assert.equal(check.detect({}), null);
    assert.equal(check.detect({ coverage: null }), null);
    assert.equal(check.detect(undefined), null);
  });

  it('returns null when branchDelta is missing or NaN', () => {
    assert.equal(check.detect({ coverage: {} }), null);
    assert.equal(check.detect({ coverage: { branchDelta: NaN } }), null);
    assert.equal(
      check.detect({ coverage: { branchDelta: 'not-a-number' } }),
      null,
    );
  });

  it('emits a fixCommand advising against ratcheting from a flapping artifact', () => {
    const finding = check.detect({
      coverage: { branchDelta: 0.0001 },
    });
    assert.ok(finding);
    assert.match(finding.fixCommand, /Do NOT ratchet/);
    assert.match(finding.fixCommand, /noise floor/i);
  });

  it('treats a delta exactly at the floor as flapping (boundary inclusive)', () => {
    const finding = check.detect({
      coverage: { branchDelta: 0.0025 },
    });
    assert.ok(finding, 'expected boundary delta to be treated as flap');
    assert.equal(finding.severity, 'warning');
  });
});
