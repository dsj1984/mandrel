/**
 * render-report.test.js — the `test-isolate` text report (Story #5316).
 *
 * Extracted from the unreachable CLI shell, where it scored CRAP 72 at 0%
 * coverage. The report is what an operator reads to decide which test file to
 * open, so these assert the content that carries that decision — which files
 * are named, which suspects, which env keys — rather than the exact framing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderReport } from '../../../.agents/scripts/lib/test-isolate/render-report.js';

/** A clean run: files scanned, nothing wrong. */
function cleanReport(over = {}) {
  return {
    files: ['tests/a.test.js', 'tests/b.test.js'],
    durationMs: 12_300,
    flippers: [],
    bisections: [],
    envMutators: [],
    ...over,
  };
}

describe('renderReport — the clean run', () => {
  it('reports the scan size and wall duration in seconds', () => {
    const out = renderReport(cleanReport());
    assert.match(out, /Files scanned:\s+2/);
    assert.match(out, /Wall duration:\s+12\.3s/);
  });

  it('says so explicitly when there are no flippers and no env leaks', () => {
    const out = renderReport(cleanReport());
    assert.match(out, /No flippers detected/);
    assert.match(out, /No env-var leaks detected/);
  });

  it('names no file when nothing is wrong', () => {
    assert.doesNotMatch(renderReport(cleanReport()), /tests\/a\.test\.js/);
  });
});

describe('renderReport — flippers', () => {
  it('counts and names every flipper', () => {
    const out = renderReport(
      cleanReport({ flippers: ['tests/x.test.js', 'tests/y.test.js'] }),
    );
    assert.match(out, /2 flipper\(s\) detected/);
    assert.match(out, /- tests\/x\.test\.js/);
    assert.match(out, /- tests\/y\.test\.js/);
    assert.doesNotMatch(out, /No flippers detected/);
  });

  it('lists bisection suspects under their flipper', () => {
    const out = renderReport(
      cleanReport({
        flippers: ['tests/x.test.js'],
        bisections: [
          {
            file: 'tests/x.test.js',
            suspects: ['tests/p.test.js', 'tests/q.test.js'],
            inconclusive: false,
          },
        ],
      }),
    );
    assert.match(out, /Likely polluters \(bisection suspects\)/);
    assert.match(out, /← tests\/p\.test\.js/);
    assert.match(out, /← tests\/q\.test\.js/);
  });

  it('marks an inconclusive bisection so its suspects are not over-trusted', () => {
    const out = renderReport(
      cleanReport({
        flippers: ['tests/x.test.js'],
        bisections: [
          { file: 'tests/x.test.js', suspects: [], inconclusive: true },
        ],
      }),
    );
    assert.match(out, /tests\/x\.test\.js \[inconclusive\]/);
  });

  it('omits the polluters heading when a flipper produced no bisection', () => {
    const out = renderReport(cleanReport({ flippers: ['tests/x.test.js'] }));
    assert.doesNotMatch(out, /Likely polluters/);
  });
});

describe('renderReport — env mutators', () => {
  it('counts the files and names each one', () => {
    const out = renderReport(
      cleanReport({
        envMutators: [
          {
            file: 'tests/p.test.js',
            envDiff: { added: ['FOO'], removed: [], changed: [] },
          },
        ],
      }),
    );
    assert.match(out, /1 file\(s\) left process\.env mutated/);
    assert.match(out, /tests\/p\.test\.js/);
  });

  it('renders only the non-empty halves of the diff', () => {
    const out = renderReport(
      cleanReport({
        envMutators: [
          {
            file: 'tests/p.test.js',
            envDiff: { added: ['FOO'], removed: [], changed: [] },
          },
        ],
      }),
    );
    assert.match(out, /added=\[FOO\]/);
    assert.doesNotMatch(out, /removed=/);
    assert.doesNotMatch(out, /changed=/);
  });

  it('renders all three halves together, comma-joined', () => {
    const out = renderReport(
      cleanReport({
        envMutators: [
          {
            file: 'tests/p.test.js',
            envDiff: {
              added: ['A', 'B'],
              removed: ['C'],
              changed: ['D'],
            },
          },
        ],
      }),
    );
    assert.match(out, /added=\[A, B\]/);
    assert.match(out, /removed=\[C\]/);
    assert.match(out, /changed=\[D\]/);
  });
});
