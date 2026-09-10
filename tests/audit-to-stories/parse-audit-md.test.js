import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import url from 'node:url';
import {
  __testing,
  parseAuditReport,
  parseAuditReports,
  parseSeverityTally,
  readSeverityTally,
} from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  const sourceReport = path.join(FIXTURES, name);
  return { markdown: fs.readFileSync(sourceReport, 'utf8'), sourceReport };
}

test('parseAuditReport extracts every finding from a security report', () => {
  const findings = parseAuditReport(loadFixture('audit-security-results.md'));
  assert.equal(findings.length, 3);

  const titles = findings.map((f) => f.title);
  assert.deepEqual(titles, [
    'Unparameterised SQL query in login handler',
    'Session cookie missing httpOnly flag',
    'Verbose error responses leak stack traces',
  ]);
});

test('parseAuditReport normalises severity from Severity field', () => {
  const findings = parseAuditReport(loadFixture('audit-security-results.md'));
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[1].severity, 'high');
  assert.equal(findings[2].severity, 'medium');
});

test('parseAuditReport normalises severity from Impact field (dependencies template)', () => {
  const findings = parseAuditReport(
    loadFixture('audit-dependencies-results.md'),
  );
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[1].severity, 'medium');
});

test('parseAuditReport accepts Category as a Dimension alias', () => {
  const findings = parseAuditReport(loadFixture('audit-clean-code-results.md'));
  assert.equal(findings[0].dimension, 'maintainability');
  assert.equal(findings[1].dimension, 'hygiene');
});

test('parseAuditReport extracts file paths from Current State and Agent Prompt', () => {
  const findings = parseAuditReport(loadFixture('audit-security-results.md'));
  assert.ok(findings[0].files.includes('src/routes/auth/login.js'));
  assert.ok(findings[1].files.includes('src/routes/auth/login.js'));
  assert.ok(findings[2].files.includes('src/middleware/error-handler.js'));
});

test('parseAuditReport produces a normalised title insensitive to punctuation and case', () => {
  const findings = parseAuditReport(loadFixture('audit-security-results.md'));
  assert.equal(
    findings[1].normalisedTitle,
    'session cookie missing httponly flag',
  );
});

test('parseAuditReport falls back to report name when Dimension is absent', () => {
  const findings = parseAuditReport({
    sourceReport: '/tmp/audit-privacy-results.md',
    markdown:
      '# Privacy Audit\n\n## Detailed Findings\n\n### Some title\n\n- **Impact:** Medium\n- **Current State:** Foo bar.\n',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].dimension, 'privacy');
  assert.equal(findings[0].severity, 'medium');
});

test('parseAuditReport returns an empty array when Detailed Findings is absent', () => {
  const findings = parseAuditReport({
    sourceReport: '/tmp/audit-foo-results.md',
    markdown: '# Foo\n\n## Executive Summary\n\nAll clear.\n',
  });
  assert.deepEqual(findings, []);
});

test('parseAuditReports flattens multiple reports', () => {
  const reports = [
    loadFixture('audit-security-results.md'),
    loadFixture('audit-clean-code-results.md'),
    loadFixture('audit-dependencies-results.md'),
  ];
  const findings = parseAuditReports(reports);
  assert.equal(findings.length, 7);
  const dimensions = new Set(findings.map((f) => f.dimension));
  assert.ok(dimensions.has('injection'));
  assert.ok(dimensions.has('maintainability'));
  assert.ok(dimensions.has('security fix'));
});

test('parseAuditReport rejects non-string markdown', () => {
  assert.throws(() =>
    parseAuditReport({ markdown: null, sourceReport: 'x.md' }),
  );
});

test('parseAuditReport rejects missing sourceReport', () => {
  assert.throws(() => parseAuditReport({ markdown: '# x', sourceReport: '' }));
});

test('normaliseSeverity maps "Mod" → medium', () => {
  assert.equal(__testing.normaliseSeverity('Mod'), 'medium');
  assert.equal(__testing.normaliseSeverity('Moderate'), 'medium');
});

test('extractFilePaths ignores bare words but captures paths', () => {
  const found = __testing.extractFilePaths(
    'See src/foo/bar.js and also `lib/x.ts`, not just description.md',
  );
  assert.ok(found.includes('src/foo/bar.js'));
  assert.ok(found.includes('lib/x.ts'));
  assert.ok(!found.includes('description.md'));
});

test('parseAuditReport emits the #### findings under severity-less ### grouping headers', () => {
  // Story #5144: a lens that groups its findings by dimension writes
  // `### Perceivable` (no Severity line) with `####` findings under it. Read
  // flat, that report parsed as one empty finding per dimension header — no
  // files, no recommendation, no severity — and `--auto` filed the empties.
  const findings = parseAuditReport(
    loadFixture('audit-accessibility-nested-results.md'),
  );

  assert.equal(findings.length, 3);
  assert.deepEqual(
    findings.map((f) => f.severity),
    ['high', 'low', 'medium'],
  );
  for (const finding of findings) {
    assert.ok(finding.files.length > 0, `${finding.title} anchors a file`);
    assert.ok(
      finding.recommendation.length > 0,
      `${finding.title} carries a recommendation`,
    );
  }
  // The grouping headers themselves are never findings.
  const titles = findings.map((f) => f.title);
  assert.equal(titles.includes('Perceivable'), false);
  assert.equal(titles.includes('Operable'), false);
});

test('parseAuditReport keeps #### sub-sections inside a ### block that IS a finding', () => {
  const findings = parseAuditReport({
    sourceReport: '/tmp/audit-privacy-results.md',
    markdown: [
      '## Detailed Findings',
      '',
      '### A real finding',
      '',
      '- **Severity:** High',
      '- **Current State:** Something in `src/a.js` is wrong.',
      '',
      '#### Supporting detail',
      '',
      'Prose that belongs to the finding above.',
      '',
    ].join('\n'),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, 'A real finding');
});

test('parseSeverityTally reads the mandated Executive Summary line', () => {
  const { markdown } = loadFixture('audit-security-results.md');
  assert.deepEqual(parseSeverityTally(markdown), {
    critical: 0,
    high: 2,
    medium: 1,
    low: 0,
  });
});

test('parseSeverityTally returns null when the report declares no tally', () => {
  assert.equal(
    parseSeverityTally('# Report\n\n## Executive Summary\n\nAll good.\n'),
    null,
  );
  assert.equal(parseSeverityTally(null), null);
});

test('every shipped fixture report declares a tally matching its findings', () => {
  for (const name of fs.readdirSync(FIXTURES)) {
    const { markdown, sourceReport } = loadFixture(name);
    const declared = parseSeverityTally(markdown);
    assert.ok(declared, `${name} declares a Severity tally line`);
    const counted = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const finding of parseAuditReport({ markdown, sourceReport })) {
      assert.ok(finding.severity, `${name}: ${finding.title} has a severity`);
      if (finding.severity in counted) counted[finding.severity] += 1;
    }
    assert.deepEqual(declared, counted, `${name} tally matches its findings`);
  }
});

// --- Unattended-sweep shapes -------------------------------------------------
// Every case below is a report shape a scheduled `--auto` run meets and an
// interactive run rarely does: a lens that emits its clean dimensions as empty
// headers, prose that quotes the tally format a second time, and a field bullet
// written with the colon outside the bold run.

test('parseAuditReport yields no finding for an empty grouping header with no #### children', () => {
  const findings = parseAuditReport({
    sourceReport: '/tmp/audit-accessibility-results.md',
    markdown: [
      '## Executive Summary',
      '',
      'Severity tally: Critical 0 / High 1 / Medium 0 / Low 0',
      '',
      '## Detailed Findings',
      '',
      '### Perceivable',
      '',
      '#### `src/a.jsx` — Icon button has no accessible name',
      '',
      '- **Severity:** High',
      '- **Location:** src/a.jsx:12',
      '',
      '### Robust',
      '',
      '_No findings._',
      '',
      '### Operable',
      '',
      '_No findings._',
      '',
    ].join('\n'),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(
    findings.some((f) => ['Robust', 'Operable'].includes(f.title)),
    false,
  );
});

test('a report of nothing but empty grouping headers cross-checks against a zero tally', () => {
  const markdown = [
    '## Executive Summary',
    '',
    'Severity tally: Critical 0 / High 0 / Medium 0 / Low 0',
    '',
    '## Detailed Findings',
    '',
    '### Robust',
    '',
    '_No findings._',
    '',
  ].join('\n');

  const findings = parseAuditReport({
    sourceReport: '/tmp/audit-accessibility-results.md',
    markdown,
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(parseSeverityTally(markdown), {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  });
});

test('readSeverityTally refuses a report declaring the tally twice', () => {
  const markdown = [
    '## Executive Summary',
    '',
    'Severity tally: Critical 0 / High 2 / Medium 1 / Low 0',
    '',
    '## Remediation notes',
    '',
    'Last cycle the report said Severity tally: Critical 1 / High 9 / Medium 9 / Low 9.',
    '',
  ].join('\n');

  const read = readSeverityTally(markdown);
  assert.equal(read.duplicate, true);
  assert.equal(read.tally, null);
  assert.equal(read.matches.length, 2);
  assert.match(read.matches[1], /High 9/);
  // The convenience wrapper collapses to null rather than adopting either line.
  assert.equal(parseSeverityTally(markdown), null);
});

test('readSeverityTally scopes the single accepted line to the Executive Summary', () => {
  const read = readSeverityTally(
    [
      '## Executive Summary',
      '',
      'Severity tally: Critical 0 / High 2 / Medium 1 / Low 0',
      '',
      '## Detailed Findings',
      '',
      'Nothing here quotes the format.',
    ].join('\n'),
  );
  assert.equal(read.duplicate, false);
  assert.deepEqual(read.tally, { critical: 0, high: 2, medium: 1, low: 0 });
});

test('parseAuditReport accepts a field bullet with the colon outside the bold run', () => {
  const [finding] = parseAuditReport({
    sourceReport: '/tmp/audit-quality-results.md',
    markdown: [
      '## Detailed Findings',
      '',
      '### `src/b.js` — Assertion-free test',
      '',
      '- **Severity**: High',
      '- **Location**: src/b.js:40',
      '- **Recommendation**: Assert on the returned value.',
      '',
    ].join('\n'),
  });

  assert.equal(finding.severity, 'high');
  assert.deepEqual(finding.files, ['src/b.js']);
  assert.equal(finding.recommendation, 'Assert on the returned value.');
});

test('an #### Evidence section before the field bullets does not mis-title the finding', () => {
  const findings = parseAuditReport({
    sourceReport: '/tmp/audit-performance-results.md',
    markdown: [
      '## Detailed Findings',
      '',
      '### `src/c.js` — Unawaited write in the hot path',
      '',
      '#### Evidence',
      '',
      '- **Severity:** High',
      '- **Location:** src/c.js:88',
      '',
    ].join('\n'),
  });

  assert.equal(findings.length, 1);
  assert.equal(
    findings[0].title,
    '`src/c.js` — Unawaited write in the hot path',
  );
  assert.equal(findings[0].severity, 'high');
});

test('isGroupingHeader reads the whole subtree, not the parent body alone', () => {
  const { isGroupingHeader } = __testing;
  const empty = { title: 'Perceivable', bodyLines: ['', '_No findings._'] };
  assert.equal(isGroupingHeader(empty, []), true);
  assert.equal(
    isGroupingHeader(empty, [
      { title: '`a.js` — one', bodyLines: ['- **Severity:** High'] },
    ]),
    true,
  );
  // A single axis-bearing sub-section under an anchorless header is that
  // header's own evidence, not a finding of its own.
  assert.equal(
    isGroupingHeader(empty, [
      { title: 'Evidence', bodyLines: ['- **Severity:** High'] },
    ]),
    false,
  );
});
