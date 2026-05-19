import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import url from 'node:url';
import { withFingerprints } from '../../.agents/scripts/lib/audit-to-stories/fingerprint.js';
import { groupFindings } from '../../.agents/scripts/lib/audit-to-stories/group-findings.js';
import { parseAuditReports } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';
import { buildEpicSeedMarkdown } from '../../.agents/scripts/lib/audit-to-stories/seed-epic-from-findings.js';

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

test('buildEpicSeedMarkdown emits all canonical one-pager sections', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const md = buildEpicSeedMarkdown({
    groups,
    findings,
    sourceReports: loadAll().map((r) => r.sourceReport),
  });
  for (const section of [
    '# Idea Seed: Audit Remediation',
    '## Problem Statement',
    '## Recommended Direction',
    '## Key Assumptions',
    '## MVP Scope',
    '## Key Files',
    '## Not Doing',
  ]) {
    assert.ok(md.includes(section), `expected section "${section}" in seed`);
  }
});

test('buildEpicSeedMarkdown references concrete files in Key Files', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const md = buildEpicSeedMarkdown({
    groups,
    findings,
    sourceReports: loadAll().map((r) => r.sourceReport),
  });
  assert.ok(md.includes('src/routes/auth/login.js'));
  assert.ok(md.includes('src/middleware/error-handler.js'));
});

test('buildEpicSeedMarkdown problem statement counts findings and severities', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const md = buildEpicSeedMarkdown({
    groups,
    findings,
    sourceReports: loadAll().map((r) => r.sourceReport),
  });
  assert.ok(/7 findings/.test(md));
  assert.ok(/High/i.test(md));
});

test('buildEpicSeedMarkdown lists every source report in Key Assumptions', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const reports = loadAll().map((r) => r.sourceReport);
  const md = buildEpicSeedMarkdown({
    groups,
    findings,
    sourceReports: reports,
  });
  for (const r of reports) {
    assert.ok(md.includes(r));
  }
});

test('buildEpicSeedMarkdown throws on bad input', () => {
  assert.throws(() =>
    buildEpicSeedMarkdown({ groups: null, findings: [], sourceReports: [] }),
  );
});

test('buildEpicSeedMarkdown handles zero findings gracefully', () => {
  const md = buildEpicSeedMarkdown({
    groups: [],
    findings: [],
    sourceReports: [],
  });
  assert.ok(md.includes('## Problem Statement'));
  assert.ok(md.includes('_(no concrete file paths surfaced)_'));
});
