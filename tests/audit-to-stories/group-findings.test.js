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

function topicFinding(title, currentState, dimension = 'privacy') {
  return {
    dimension,
    severity: 'low',
    title,
    normalisedTitle: title.toLowerCase(),
    files: [],
    currentState,
    recommendation: '',
  };
}

test('groupFindings folds file-less findings sharing ≥3 signature tokens into one topic group', () => {
  const findings = [
    topicFinding('Retention policy missing', 'personal records stored forever'),
    topicFinding(
      'Retention schedule absent',
      'personal records stored forever',
    ),
  ];
  const { groups } = groupFindings(findings);
  assert.equal(groups.length, 1);
  assert.equal(
    groups[0].groupKey,
    'topic:privacy:retention policy missing',
    'the first finding names the topic key',
  );
  assert.equal(
    groups[0].title,
    'Retention policy missing & Retention schedule absent',
  );
});

test('groupFindings titles a 3+ file-less merge by its first finding plus a count', () => {
  const state = 'personal records stored forever';
  const { groups } = groupFindings([
    topicFinding('Retention policy missing', state),
    topicFinding('Retention schedule absent', state, 'compliance'),
    topicFinding('Deletion workflow absent', state),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Retention policy missing (+2 related)');
  assert.deepEqual(groups[0].dimensions, ['compliance', 'privacy']);
});

test('groupFindings keeps file-less findings with <3 shared tokens in separate topics', () => {
  const { groups } = groupFindings([
    topicFinding('Retention policy missing', 'records stored forever'),
    topicFinding('Consent banner absent', 'cookies placed silently'),
  ]);
  assert.equal(groups.length, 2);
});

test('groupFindings reports null severity when no merged finding states one', () => {
  const finding = { ...topicFinding('Unclear owner', 'nobody owns it') };
  delete finding.severity;
  const { groups } = groupFindings([finding]);
  assert.equal(groups[0].severity, null);
});

test('groupFindings rejects a non-array input', () => {
  assert.throws(() => groupFindings(null), /must be an array/);
});

test('groupFindings merges same-directory singletons sharing ≥3 signature tokens', () => {
  const state = 'unbounded retries hammer upstream service';
  const fileFinding = (file, title) => ({
    ...topicFinding(title, state, 'performance'),
    files: [file],
  });
  const { groups } = groupFindings([
    fileFinding('src/net/client.js', 'Retry storm risk'),
    fileFinding('src/net/pool.js', 'Retry storm in pool'),
    fileFinding('src/net/cache.js', 'Retry storm in cache'),
    fileFinding('src/other/x.js', 'Retry storm elsewhere'),
    fileFinding('src/net/quiet.js', 'Naming drift'),
  ]);
  const netGroup = groups.find((g) => g.groupKey === 'file:src/net/client.js');
  assert.ok(netGroup, 'expected the first same-dir file to anchor the merge');
  assert.deepEqual(netGroup.files, [
    'src/net/client.js',
    'src/net/pool.js',
    'src/net/cache.js',
    'src/net/quiet.js',
  ]);
  assert.equal(
    netGroup.title,
    'Remediate performance findings in src/net/client.js',
  );
  assert.ok(groups.some((g) => g.groupKey === 'file:src/other/x.js'));
  assert.equal(groups.length, 2);
});
