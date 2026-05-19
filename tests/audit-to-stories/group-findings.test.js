import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import url from 'node:url';
import { groupFindings } from '../../.agents/scripts/lib/audit-to-stories/group-findings.js';
import { parseAuditReports } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, 'fixtures');

function loadAll() {
  return [
    'audit-security-results.md',
    'audit-clean-code-results.md',
    'audit-dependencies-results.md',
  ].map((name) => ({
    sourceReport: path.join(FIXTURES, name),
    markdown: fs.readFileSync(path.join(FIXTURES, name), 'utf8'),
  }));
}

test('groupFindings merges cross-audit findings on the same file (Story AC #5)', () => {
  const findings = parseAuditReports(loadAll());
  const { groups } = groupFindings(findings);

  // login.js is hit by both audit-security and audit-clean-code.
  const loginGroup = groups.find((g) =>
    g.files.includes('src/routes/auth/login.js'),
  );
  assert.ok(loginGroup, 'expected a group keyed on the login.js file');
  assert.ok(loginGroup.findings.length >= 3, 'expected ≥3 findings merged');
  assert.ok(loginGroup.dimensions.includes('injection'));
  assert.ok(loginGroup.dimensions.includes('security misconfiguration'));
  assert.ok(loginGroup.dimensions.includes('maintainability'));
});

test('groupFindings picks the highest severity across the merge', () => {
  const findings = parseAuditReports(loadAll());
  const { groups } = groupFindings(findings);
  const loginGroup = groups.find((g) =>
    g.files.includes('src/routes/auth/login.js'),
  );
  assert.equal(loginGroup.severity, 'high');
});

test('groupFindings keeps findings on different files as separate groups', () => {
  const findings = parseAuditReports(loadAll());
  const { groups } = groupFindings(findings);
  const loginGroup = groups.find((g) =>
    g.files.includes('src/routes/auth/login.js'),
  );
  const errorGroup = groups.find((g) =>
    g.files.includes('src/middleware/error-handler.js'),
  );
  assert.ok(loginGroup && errorGroup);
  assert.notEqual(loginGroup.groupKey, errorGroup.groupKey);
});

test('groupFindings synthesises a title naming the shared file when merging', () => {
  const findings = parseAuditReports(loadAll());
  const { groups } = groupFindings(findings);
  const loginGroup = groups.find((g) =>
    g.files.includes('src/routes/auth/login.js'),
  );
  assert.ok(loginGroup.title.includes('src/routes/auth/login.js'));
});

test('groupFindings keeps a single-finding group atomic', () => {
  const findings = parseAuditReports(loadAll());
  const { groups } = groupFindings(findings);
  const lodashGroup = groups.find((g) =>
    g.findings.some((f) => f.title.includes('lodash')),
  );
  assert.ok(lodashGroup);
  assert.equal(lodashGroup.findings.length, 1);
  assert.equal(lodashGroup.title, 'Upgrade `lodash` to 4.17.21');
});

test('groupFindings returns an empty result for an empty input', () => {
  assert.deepEqual(groupFindings([]), { groups: [], edges: [] });
});

test('groupFindings throws on non-array input', () => {
  assert.throws(() => groupFindings(null));
});

test("groupFindings detects a dependency edge when Recommendation names another group's file", () => {
  const findings = [
    {
      dimension: 'security',
      severity: 'high',
      title: 'Validation gap in /api/orders',
      normalisedTitle: 'validation gap api orders',
      files: ['src/routes/orders.js'],
      currentState: 'orders.js accepts arbitrary JSON.',
      recommendation:
        'Use the helper exported from src/lib/validate.js to gate all bodies.',
    },
    {
      dimension: 'clean-code',
      severity: 'medium',
      title: 'Validation helper not exported',
      normalisedTitle: 'validation helper not exported',
      files: ['src/lib/validate.js'],
      currentState: 'validate.js defines a helper but does not export it.',
      recommendation: 'Add a named export.',
    },
  ];
  const { groups, edges } = groupFindings(findings);
  assert.equal(groups.length, 2);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].via, 'src/lib/validate.js');
});

test('groupFindings handles findings with no concrete file paths via topic key', () => {
  const findings = [
    {
      dimension: 'privacy',
      severity: 'medium',
      title: 'PII shape unclear',
      normalisedTitle: 'pii shape unclear',
      files: [],
      currentState: 'No documentation of personal data flow.',
      recommendation: 'Author a data-flow diagram.',
    },
  ];
  const { groups } = groupFindings(findings);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].groupKey.startsWith('topic:'));
});
