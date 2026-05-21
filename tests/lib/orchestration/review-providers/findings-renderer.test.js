/**
 * Unit tests for `findings-renderer.js`.
 *
 * Story #2825 (Epic #2815) — the renderer is the single source of
 * truth for the `code-review` structured-comment body. The snapshot
 * test pins the deterministic output for a fixed `Finding[]` input so
 * future renderer changes are reviewed explicitly rather than slipping
 * in unnoticed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countBySeverity,
  renderFinding,
  renderFindings,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/findings-renderer.js';

test('countBySeverity: tallies all four tiers and ignores unknowns', () => {
  const counts = countBySeverity([
    { severity: 'critical', title: 'a', body: '' },
    { severity: 'high', title: 'b', body: '' },
    { severity: 'high', title: 'c', body: '' },
    { severity: 'medium', title: 'd', body: '' },
    { severity: 'suggestion', title: 'e', body: '' },
    { severity: 'bogus', title: 'f', body: '' },
  ]);
  assert.deepEqual(counts, {
    critical: 1,
    high: 2,
    medium: 1,
    suggestion: 1,
  });
});

test('countBySeverity: handles empty input', () => {
  assert.deepEqual(countBySeverity([]), {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  });
});

test('renderFinding: includes file:line attribution and category', () => {
  const out = renderFinding({
    severity: 'high',
    title: 'Missing null check',
    body: 'Guard the `user` lookup.',
    file: 'src/foo.js',
    line: 42,
    category: 'security',
  });
  assert.match(out, /^#### 🟠 Missing null check — `src\/foo\.js:42` _\[security\]_/);
  assert.match(out, /Guard the `user` lookup\./);
});

test('renderFinding: file without line drops the line suffix', () => {
  const out = renderFinding({
    severity: 'medium',
    title: 't',
    body: 'b',
    file: 'README.md',
  });
  assert.match(out, /— `README\.md`/);
  assert.doesNotMatch(out, /README\.md:/);
});

test('renderFinding: no file omits attribution entirely', () => {
  const out = renderFinding({ severity: 'suggestion', title: 't', body: 'b' });
  assert.equal(out.split('\n')[0], '#### 🟢 t');
});

test('renderFindings: empty findings list renders the "no findings" branch', () => {
  const out = renderFindings({
    scope: 'story',
    ticketId: 2825,
    baseRef: 'epic/2815',
    headRef: 'story-2825',
    findings: [],
    provider: 'native',
  });
  assert.match(out, /## 🔬 Code Review — Story #2825/);
  assert.match(out, /\*\*Findings\*\*: 0/);
  assert.match(out, /### ✅ No findings/);
  // Tier counts always render even when zero, in canonical order.
  const criticalIdx = out.indexOf('🔴 Critical Blocker: 0');
  const highIdx = out.indexOf('🟠 High Risk: 0');
  const mediumIdx = out.indexOf('🟡 Medium Risk: 0');
  const suggestionIdx = out.indexOf('🟢 Suggestion: 0');
  assert.ok(criticalIdx >= 0 && criticalIdx < highIdx);
  assert.ok(highIdx < mediumIdx);
  assert.ok(mediumIdx < suggestionIdx);
});

test('renderFindings: deterministic snapshot for a fixed Finding[]', () => {
  const findings = [
    {
      severity: 'critical',
      title: 'SQL injection risk',
      body: 'Concatenating user input into the query.',
      file: 'src/db/query.js',
      line: 17,
      category: 'security',
    },
    {
      severity: 'suggestion',
      title: 'Rename helper',
      body: '`doThing` reads as a verb-only noun.',
      file: 'src/util.js',
      line: 3,
    },
    {
      severity: 'high',
      title: 'Missing await',
      body: 'Promise from `save()` is dropped.',
      file: 'src/api/handler.js',
      line: 88,
    },
    {
      severity: 'medium',
      title: 'Docstring drift',
      body: 'Args list does not match signature.',
    },
  ];

  const out = renderFindings({
    scope: 'epic',
    ticketId: 2815,
    baseRef: 'main',
    headRef: 'epic/2815',
    findings,
    provider: 'native',
  });

  const expected = [
    '## 🔬 Code Review — Epic #2815',
    '',
    '**Comparison**: `main` … `epic/2815`',
    '**Provider**: `native`',
    '**Findings**: 4',
    '',
    '### 📦 Severity Tier Counts',
    '',
    '- 🔴 Critical Blocker: 1',
    '- 🟠 High Risk: 1',
    '- 🟡 Medium Risk: 1',
    '- 🟢 Suggestion: 1',
    '',
    '### 🔴 Critical Blocker (1)',
    '',
    '#### 🔴 SQL injection risk — `src/db/query.js:17` _[security]_',
    '',
    'Concatenating user input into the query.',
    '',
    '### 🟠 High Risk (1)',
    '',
    '#### 🟠 Missing await — `src/api/handler.js:88`',
    '',
    'Promise from `save()` is dropped.',
    '',
    '### 🟡 Medium Risk (1)',
    '',
    '#### 🟡 Docstring drift',
    '',
    'Args list does not match signature.',
    '',
    '### 🟢 Suggestion (1)',
    '',
    '#### 🟢 Rename helper — `src/util.js:3`',
    '',
    '`doThing` reads as a verb-only noun.',
    '',
  ].join('\n');

  assert.equal(out, expected);
});

test('renderFindings: same input twice produces byte-identical output', () => {
  const input = {
    scope: /** @type {'story'} */ ('story'),
    ticketId: 1,
    baseRef: 'main',
    headRef: 'story-1',
    findings: [
      { severity: 'high', title: 't', body: 'b' },
      { severity: 'high', title: 'u', body: 'b' },
    ],
    provider: 'native',
  };
  assert.equal(renderFindings(input), renderFindings(input));
});

test('renderFindings: omits provider line as "(unspecified)" when absent', () => {
  const out = renderFindings({
    scope: 'story',
    ticketId: 1,
    baseRef: 'main',
    headRef: 'story-1',
    findings: [],
  });
  assert.match(out, /\*\*Provider\*\*: _\(unspecified\)_/);
});
