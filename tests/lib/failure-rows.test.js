import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractFailureRows,
  quoteFailureRows,
  tapFailureRows,
} from '../../.agents/scripts/lib/failure-rows.js';

const ESC = String.fromCharCode(27);

describe('extractFailureRows', () => {
  it('quotes a failure marker and up to three indented rows after it', () => {
    const out = [
      'noise',
      '[run-lint] ✗ biome exited 1',
      '  row one',
      '  row two',
      '  row three',
      '  row four',
      'trailing',
    ].join('\n');
    assert.deepEqual(extractFailureRows(out), [
      '✗ biome exited 1',
      'row one',
      'row two',
      'row three',
    ]);
  });

  it('quotes a biome header without its rule and the Found summary', () => {
    const out = [
      'src/a.js:3:1 lint/style/useConst  FIXABLE  ━━━━━━━━━━━━',
      '  × This let is never reassigned.',
      'Found 2 errors.',
      'Found 1 warning.',
    ].join('\n');
    assert.deepEqual(extractFailureRows(out), [
      'src/a.js:3:1 lint/style/useConst  FIXABLE',
      'Found 2 errors.',
      'Found 1 warning.',
    ]);
  });

  it('quotes check-baselines FAIL, remedy, row and schema-error lines', () => {
    const out = [
      '[check-baselines] 2 gate(s) — breaches=0, regressions=1',
      '[gate-x]   - crap: FAIL (breaches=0, regressions=1)',
      '[gate-x]     ↳ remedy: fix the named rows',
      '[gate-x]     · a.js::f: crap 3 → 9',
      '  - coverage: PASS',
      '  ! schema error (mutation): bad',
    ].join('\n');
    assert.deepEqual(extractFailureRows(out), [
      '- crap: FAIL (breaches=0, regressions=1)',
      '↳ remedy: fix the named rows',
      '· a.js::f: crap 3 → 9',
      '! schema error (mutation): bad',
    ]);
  });

  it('quotes quality-preview body rows and Totals, not header or placeholder', () => {
    const out = [
      '| file | MI delta | worst CRAP delta | n |',
      '| --- | --- | --- | --- |',
      '| a.js | -1.00 | +2.00 | 0 |',
      '| _(no per-file regressions)_ | — | — | — |',
      'Totals: MI regressions=1 · CRAP violations=0',
    ].join('\n');
    assert.deepEqual(extractFailureRows(out), [
      '| a.js | -1.00 | +2.00 | 0 |',
      'Totals: MI regressions=1 · CRAP violations=0',
    ]);
  });

  it('strips ANSI, de-duplicates, truncates to 200 chars and caps', () => {
    const long = `✖ ${'x'.repeat(300)}`;
    const out = [
      `${ESC}[31m✖ red${ESC}[0m`,
      '✖ red',
      long,
      ...Array.from({ length: 20 }, (_, i) => `✖ item ${i}`),
    ].join('\n');
    const rows = extractFailureRows(out, { max: 4 });
    assert.equal(rows.length, 4);
    assert.equal(rows[0], '✖ red');
    assert.equal(rows[1].length, 200);
    assert.equal(rows[2], '✖ item 0');
  });

  it('returns an empty list when nothing matches', () => {
    assert.deepEqual(extractFailureRows('all good\nnothing here'), []);
    assert.deepEqual(extractFailureRows(undefined), []);
  });

  it('taps an opted-in stream, passing every line through', () => {
    const seen = [];
    const { tap, rowsResult } = tapFailureRows(true, (l) => seen.push(l));
    for (const l of ['noise', '✖ a', '✖ b']) tap(l);
    assert.deepEqual(seen, ['noise', '✖ a', '✖ b']);
    assert.deepEqual(rowsResult(), { failureRows: ['✖ a', '✖ b'] });
    const off = tapFailureRows(false, () => {});
    off.tap('✖ a');
    assert.deepEqual(off.rowsResult(), {});
  });

  it('quotes rows for a finding, or nothing', () => {
    assert.equal(
      quoteFailureRows('✖ a\nFound 1 error.'),
      ': ✖ a; Found 1 error.',
    );
    assert.equal(quoteFailureRows('fine'), '');
  });
});
