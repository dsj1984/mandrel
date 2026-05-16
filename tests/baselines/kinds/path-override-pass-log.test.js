import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enforceMaintainabilityFloor } from '../../../.agents/scripts/lib/baselines/kinds/maintainability.js';
import { enforceCrapFloor } from '../../../.agents/scripts/lib/baselines/kinds/crap.js';
import { DEFAULT_FLOORS } from '../../../.agents/scripts/lib/quality-floors.js';

/**
 * Story #2029: every active path override MUST be surfaced in the
 * gate's pass-log so green CI cannot hide a stale override. The line
 * is emitted on both pass and fail outcomes.
 */

function captureConsoleError(fn) {
  const messages = [];
  const originalErr = console.error;
  const originalLog = console.log;
  const sink = (...args) => {
    messages.push(args.map(String).join(' '));
  };
  console.error = sink;
  console.log = sink;
  try {
    fn();
  } finally {
    console.error = originalErr;
    console.log = originalLog;
  }
  return messages.join('\n');
}

describe('path-override pass-log — Story #2029', () => {
  it('maintainability gate emits a Logger.info line for a matched override on pass', () => {
    const floors = {
      ...DEFAULT_FLOORS,
      pathOverrides: new Map([
        [
          'lib/relaxed.js',
          { maintainability: 40, follow_up: '#42' },
        ],
      ]),
    };
    const scores = {
      'lib/relaxed.js': 50, // >= 40 (override) and < 70 (default) — passes only because of override
      'lib/other.js': 90,
    };
    const output = captureConsoleError(() => {
      const code = enforceMaintainabilityFloor(scores, [], { floors });
      assert.equal(code, 0, 'gate should pass under the override');
    });
    assert.match(
      output,
      /lib\/relaxed\.js: maintainability floor relaxed to 40 per #42/,
      'pass-log line must name path, relaxed value, and follow_up',
    );
  });

  it('maintainability gate emits the same line on fail (override hit but still below override)', () => {
    const floors = {
      ...DEFAULT_FLOORS,
      pathOverrides: new Map([
        ['lib/very-bad.js', { maintainability: 40, follow_up: '#42' }],
      ]),
    };
    const scores = { 'lib/very-bad.js': 30 };
    const output = captureConsoleError(() => {
      const code = enforceMaintainabilityFloor(scores, [], { floors });
      assert.equal(code, 1, 'still fails — observed (30) < override floor (40)');
    });
    assert.match(
      output,
      /lib\/very-bad\.js: maintainability floor relaxed to 40 per #42/,
    );
  });

  it('maintainability gate emits zero override-related lines when no overrides match', () => {
    const floors = {
      ...DEFAULT_FLOORS,
      pathOverrides: new Map([
        ['lib/never-scored.js', { maintainability: 40, follow_up: '#42' }],
      ]),
    };
    const scores = { 'lib/other.js': 90 };
    const output = captureConsoleError(() => {
      enforceMaintainabilityFloor(scores, [], { floors });
    });
    assert.doesNotMatch(output, /floor relaxed/);
  });

  it('maintainability gate emits zero override lines when pathOverrides Map is empty', () => {
    const floors = { ...DEFAULT_FLOORS, pathOverrides: new Map() };
    const scores = { 'lib/a.js': 90 };
    const output = captureConsoleError(() => {
      enforceMaintainabilityFloor(scores, [], { floors });
    });
    assert.doesNotMatch(output, /floor relaxed/);
  });

  it('crap gate emits a Logger.info line for a matched override on pass', () => {
    const floors = {
      ...DEFAULT_FLOORS,
      pathOverrides: new Map([
        ['lib/messy.js', { crap: 50, follow_up: '#7' }],
      ]),
    };
    const scan = {
      rows: [
        { file: 'lib/messy.js', method: 'tangled', crap: 35 }, // ≤ 50 (override), > 20 (default)
        { file: 'lib/clean.js', method: 'simple', crap: 5 },
      ],
    };
    const output = captureConsoleError(() => {
      const code = enforceCrapFloor(scan, [], { floors });
      assert.equal(code, 0, 'gate should pass under the override');
    });
    assert.match(
      output,
      /lib\/messy\.js: crap floor relaxed to 50 per #7/,
    );
  });

  it('crap gate emits the same line on fail', () => {
    const floors = {
      ...DEFAULT_FLOORS,
      pathOverrides: new Map([
        ['lib/messy.js', { crap: 50, follow_up: '#7' }],
      ]),
    };
    const scan = {
      rows: [{ file: 'lib/messy.js', method: 'still-bad', crap: 75 }],
    };
    const output = captureConsoleError(() => {
      const code = enforceCrapFloor(scan, [], { floors });
      assert.equal(code, 1, 'still fails — observed (75) > override (50)');
    });
    assert.match(output, /lib\/messy\.js: crap floor relaxed to 50 per #7/);
  });

  it('crap gate emits zero override lines when no overrides match', () => {
    const floors = {
      ...DEFAULT_FLOORS,
      pathOverrides: new Map([
        ['lib/never-scanned.js', { crap: 50, follow_up: '#7' }],
      ]),
    };
    const scan = {
      rows: [{ file: 'lib/other.js', method: 'fine', crap: 5 }],
    };
    const output = captureConsoleError(() => {
      enforceCrapFloor(scan, [], { floors });
    });
    assert.doesNotMatch(output, /floor relaxed/);
  });
});
