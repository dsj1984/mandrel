import assert from 'node:assert';
import { test } from 'node:test';
import {
  FAILURE_MARKERS,
  findLastFailureMarker,
  normalizeLines,
  parseTestOutput,
  sortPayloadsByOs,
} from '../../.agents/scripts/lib/triage/parse-test-output.js';

/**
 * parse-test-output unit tests.
 *
 * Locks the contract documented in the parser's JSDoc:
 *   - Pure function: no I/O, no globals
 *   - Anchors on the last failure marker, returns up to `tailLines` lines
 *   - Falls back to "last tailLines lines" when no marker matched
 *   - Normalizes CRLF (Windows) and LF (Linux) artifacts identically
 *   - sortPayloadsByOs places linux before windows for deterministic comment ordering
 *
 * Fixtures intentionally include lines that look like markers in the middle
 * of the buffer to verify we anchor on the *last* match, not the first.
 */

test('normalizeLines — strips CRLF and trailing newline', () => {
  const raw = 'a\r\nb\r\nc\r\n';
  assert.deepStrictEqual(normalizeLines(raw), ['a', 'b', 'c']);
});

test('normalizeLines — LF input unchanged', () => {
  const raw = 'a\nb\nc';
  assert.deepStrictEqual(normalizeLines(raw), ['a', 'b', 'c']);
});

test('normalizeLines — rejects non-string input', () => {
  assert.throws(() => normalizeLines(123), TypeError);
});

test('FAILURE_MARKERS — is frozen', () => {
  assert.ok(Object.isFrozen(FAILURE_MARKERS));
});

test('findLastFailureMarker — picks the last "not ok"', () => {
  const lines = [
    'ok 1',
    'not ok 2 - early failure',
    'ok 3',
    'not ok 4 - late failure',
    'ok 5',
  ];
  // The last "not ok" is index 3. Trailing 'ok 5' is non-matching so the
  // anchor walks back from EOF and stops at index 3.
  assert.strictEqual(findLastFailureMarker(lines), 3);
});

test('findLastFailureMarker — coverage threshold pattern', () => {
  const lines = [
    'ok 100',
    '# pass 100',
    'ERROR: coverage threshold (lines: 80%) not met',
    '',
  ];
  assert.strictEqual(findLastFailureMarker(lines), 2);
});

test('findLastFailureMarker — returns -1 on no match', () => {
  const lines = ['ok 1', 'ok 2', '# pass 2'];
  assert.strictEqual(findLastFailureMarker(lines), -1);
});

test('findLastFailureMarker — rejects non-array', () => {
  assert.throws(() => findLastFailureMarker('foo'), TypeError);
});

test('parseTestOutput — anchored slice ends at the marker line', () => {
  const raw = ['ok 1', 'ok 2', 'not ok 3 - bad', 'context after marker'].join(
    '\n',
  );
  const result = parseTestOutput(raw, { os: 'ubuntu-latest', tailLines: 30 });
  assert.strictEqual(result.anchored, true);
  assert.strictEqual(result.lines[result.lines.length - 1], 'not ok 3 - bad');
  assert.strictEqual(result.os, 'ubuntu-latest');
});

test('parseTestOutput — slice is capped at tailLines', () => {
  // 50 ok lines then a failure → slice should be the last 30 lines
  // including the failure (which is the last line of the buffer).
  const ok = Array.from({ length: 50 }, (_, i) => `ok ${i + 1}`);
  const raw = [...ok, 'not ok 51 - end'].join('\n');
  const result = parseTestOutput(raw, { os: 'linux', tailLines: 30 });
  assert.strictEqual(result.lines.length, 30);
  assert.strictEqual(result.lines[29], 'not ok 51 - end');
});

test('parseTestOutput — fallback returns last tailLines when no marker', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `ok ${i + 1}`);
  const result = parseTestOutput(lines.join('\n'), { tailLines: 10 });
  assert.strictEqual(result.anchored, false);
  assert.strictEqual(result.lines.length, 10);
  assert.strictEqual(result.lines[0], 'ok 31');
  assert.strictEqual(result.lines[9], 'ok 40');
});

test('parseTestOutput — happy path: tailLines defaults to 30', () => {
  const raw = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const result = parseTestOutput(raw);
  // No marker → fallback → last 30 lines.
  assert.strictEqual(result.lines.length, 30);
});

test('parseTestOutput — empty buffer yields empty slice', () => {
  const result = parseTestOutput('');
  assert.strictEqual(result.anchored, false);
  // After normalizeLines drops trailing empty, lines.length is 0.
  assert.deepStrictEqual(result.lines, []);
});

test('parseTestOutput — rejects non-positive tailLines', () => {
  assert.throws(() => parseTestOutput('x', { tailLines: 0 }), RangeError);
});

test('parseTestOutput — CRLF (Windows) and LF inputs produce identical slices', () => {
  // Combined multi-OS fixture coverage: same content, different line
  // endings, must yield equivalent payloads so the rendered comment is
  // deterministic across legs.
  const lf = ['ok 1', 'ok 2', 'not ok 3'].join('\n');
  const crlf = ['ok 1', 'ok 2', 'not ok 3'].join('\r\n');
  const a = parseTestOutput(lf, { os: 'ubuntu-latest' });
  const b = parseTestOutput(crlf, { os: 'windows-latest' });
  assert.deepStrictEqual(a.lines, b.lines);
  assert.strictEqual(a.anchored, b.anchored);
});

test('sortPayloadsByOs — linux before windows before mac before unknown', () => {
  const input = [
    { os: 'macos-latest', lines: [], anchored: false },
    { os: 'unknown', lines: [], anchored: false },
    { os: 'windows-latest', lines: [], anchored: false },
    { os: 'ubuntu-latest', lines: [], anchored: false },
  ];
  const sorted = sortPayloadsByOs(input);
  assert.deepStrictEqual(
    sorted.map((p) => p.os),
    ['ubuntu-latest', 'windows-latest', 'macos-latest', 'unknown'],
  );
});

test('sortPayloadsByOs — stable on identical ranks (alpha by os)', () => {
  const input = [
    { os: 'ubuntu-22.04', lines: [], anchored: false },
    { os: 'ubuntu-latest', lines: [], anchored: false },
  ];
  const sorted = sortPayloadsByOs(input);
  // Both rank 0 (linux) → alpha sort → '22.04' before 'latest'.
  assert.strictEqual(sorted[0].os, 'ubuntu-22.04');
});

test('sortPayloadsByOs — null/undefined os tolerated', () => {
  const input = [
    { os: null, lines: [], anchored: false },
    { os: 'ubuntu-latest', lines: [], anchored: false },
  ];
  const sorted = sortPayloadsByOs(input);
  // null ranks 99 → ubuntu comes first.
  assert.strictEqual(sorted[0].os, 'ubuntu-latest');
});

test('sortPayloadsByOs — rejects non-array', () => {
  assert.throws(() => sortPayloadsByOs('foo'), TypeError);
});
