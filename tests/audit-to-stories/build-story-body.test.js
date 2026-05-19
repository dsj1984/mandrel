import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import url from 'node:url';
import { buildStoryBody } from '../../.agents/scripts/lib/audit-to-stories/build-story-body.js';
import {
  parseFingerprintFooter,
  withFingerprints,
} from '../../.agents/scripts/lib/audit-to-stories/fingerprint.js';
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

function loginGroup() {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  return groups.find((g) => g.files.includes('src/routes/auth/login.js'));
}

test('buildStoryBody emits all canonical sections', () => {
  const { title, body } = buildStoryBody({ group: loginGroup() });
  for (const section of [
    '## Summary',
    '## Acceptance Criteria',
    '## Agent Prompts',
    '## Context',
  ]) {
    assert.ok(body.includes(section));
  }
  assert.ok(title.length > 0);
});

test('buildStoryBody applies audit:: labels for every dimension in the merge (Story AC #5)', () => {
  const { labels } = buildStoryBody({ group: loginGroup() });
  assert.ok(labels.includes('type::story'));
  assert.ok(labels.includes('agent::ready'));
  assert.ok(labels.some((l) => l === 'audit::injection'));
  assert.ok(labels.some((l) => l === 'audit::maintainability'));
});

test('buildStoryBody stamps the machine-readable fingerprint footer', () => {
  const group = loginGroup();
  const { body } = buildStoryBody({ group });
  const shas = parseFingerprintFooter(body);
  assert.equal(shas.length, group.findings.length);
  for (const sha of shas) {
    assert.ok(/^[0-9a-f]{40}$/.test(sha));
  }
});

test('buildStoryBody applies risk::high when any finding is critical', () => {
  const synthetic = {
    title: 'Patch root vulnerability',
    dimensions: ['security'],
    files: ['src/x.js'],
    severity: 'critical',
    findings: [
      {
        title: 'RCE in handler',
        severity: 'critical',
        dimension: 'security',
        currentState: 'eval() of user input.',
        recommendation: 'Remove eval and use a safe parser.',
        agentPrompt: 'Remove the eval call.',
        sourceReport: '/tmp/audit-security-results.md',
        fingerprint: { full: 'd'.repeat(40), short: 'dddddddddddd' },
      },
    ],
  };
  const { labels } = buildStoryBody({ group: synthetic });
  assert.ok(labels.includes('risk::high'));
});

test('buildStoryBody throws on missing group.findings', () => {
  assert.throws(() => buildStoryBody({ group: { findings: null } }));
});

test('buildStoryBody Context section links every distinct source report', () => {
  const group = loginGroup();
  const { body } = buildStoryBody({ group });
  const unique = new Set(group.findings.map((f) => f.sourceReport));
  for (const r of unique) {
    assert.ok(body.includes(r));
  }
});
