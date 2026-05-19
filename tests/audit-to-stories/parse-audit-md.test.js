import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  parseAuditReport,
  parseAuditReports,
  __testing,
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
  const findings = parseAuditReport(loadFixture('audit-dependencies-results.md'));
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
  assert.throws(() => parseAuditReport({ markdown: null, sourceReport: 'x.md' }));
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
