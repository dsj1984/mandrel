/**
 * tests/audit-suite/resilience-lens.test.js — Story #5892.
 *
 * Contract tests for the `audit-resilience` lens: a global lens that builds a
 * dependency inventory and follows each failure through its barrier to a
 * human. Registration, the body contract (dimensions, mandatory sections, the
 * second-read evidence bar, the assumption-drift pass), the audit-sre hand-off
 * and the report shape are locked here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveLensTier } from '../../.agents/scripts/lib/audit-suite/index.js';
import {
  isCanonicalLens,
  lensFromSourceReport,
} from '../../.agents/scripts/lib/audit-to-stories/audit-lenses.js';
import { parseAuditReport } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';
import { assertDocMentions } from '../helpers/doc-assert.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const lens = read('.agents/workflows/audit-resilience.md');
const sre = read('.agents/workflows/audit-sre.md');
const rules = JSON.parse(read('.agents/schemas/audit-rules.json'));
const rulesSchema = JSON.parse(read('.agents/schemas/audit-rules.schema.json'));

test('audit-rules.json registers audit-resilience as a global gate1/gate3 lens behind the integrations target', () => {
  const entry = rules.audits['audit-resilience'];
  assert.ok(entry, 'audit-resilience is not registered');
  assert.equal(entry.scope, 'global');
  assert.equal(entry.target, 'integrations');
  assert.deepEqual(entry.triggers.gates, ['gate1', 'gate3']);
  assert.ok(entry.triggers.keywords.includes('resilience'));
  assert.ok(entry.triggers.filePatterns.includes('**/webhooks/**'));
});

test('the audit-rules schema accepts the integrations target and names its probe', () => {
  const target = rulesSchema.definitions.auditEntry.properties.target;
  assert.ok(target.enum.includes('integrations'));
  assertDocMentions(
    target.description,
    /hasExternalDependencies\(\) for `integrations`/,
  );
});

test('resolveLensTier resolves audit-resilience to global through the SDK barrel', () => {
  assert.equal(resolveLensTier('audit-resilience'), 'global');
});

test('the report basename labels findings audit::resilience', () => {
  assert.ok(isCanonicalLens('resilience'));
  assert.equal(
    lensFromSourceReport('temp/audits/audit-resilience-results.md'),
    'resilience',
  );
});

test('lens: names its seven dimensions', () => {
  assertDocMentions(
    lens,
    /`Inventory \| Barrier \| Integrity \| Signal Path \| Landing \| Background Lane \| Assumption Drift`/,
  );
  for (const heading of [
    'Barrier',
    'Integrity',
    'Signal Path',
    'Landing',
    'Background Lane',
    'Assumption Drift',
  ]) {
    assert.ok(lens.includes(`\n### ${heading}\n`), `lens omits ### ${heading}`);
  }
});

test('lens: the report template carries the four mandatory sections, inventory first', () => {
  for (const heading of [
    '## Dependency Inventory',
    '## Signal Path',
    '## Corrections',
    '## Verified strengths',
  ]) {
    assert.ok(lens.includes(`\n${heading}\n`), `template omits ${heading}`);
  }
  const template = lens.slice(lens.indexOf('# Resilience Audit Report'));
  assert.ok(
    template.indexOf('## Dependency Inventory') <
      template.indexOf('## Detailed Findings'),
    'the Dependency Inventory must precede the findings',
  );
});

test('lens: every Critical and High takes a second control-flow read, recorded under Corrections', () => {
  assertDocMentions(
    lens,
    /Second read for every Critical and High\..*actual control-flow order/,
  );
  assertDocMentions(lens, /recorded under\s+`## Corrections` with the reason/);
});

test('lens: assumption drift carries a runnable cadence detection command', () => {
  assertDocMentions(
    lens,
    /rg -n -i -B2 -A2 "hourly\|every \(minute\|hour\|day\)\|\\bcron\\b\|cadence/,
  );
});

test('audit-sre hands its timeout, empty-catch and retry checks to audit-resilience', () => {
  assert.ok(!sre.includes('AbortController'));
  assert.ok(!/catch\\s\*/.test(sre), 'audit-sre still greps empty catches');
  assert.ok(!/retr\(y\|ies\)/.test(sre), 'audit-sre still greps retries');
  assertDocMentions(sre, /`audit-resilience`/);
  assert.ok(
    !rules.audits['audit-sre'].triggers.keywords.includes('resilience'),
  );
});

test('a report in the lens template parses with its findings attributed to the lens', () => {
  const sourceReport = 'temp/audits/audit-resilience-results.md';
  const markdown = [
    '# Resilience Audit Report',
    '',
    '## Executive Summary',
    '',
    'Self-cross-check: kept 1 / dropped 1.',
    'Severity tally: Critical 0 / High 1 / Medium 0 / Low 0',
    '',
    '## Detailed Findings',
    '',
    '### `src/outbox/drain.js` — Retry budget spans five minutes, not hours',
    '',
    '- **Dimension:** Assumption Drift',
    '- **Severity:** High',
    '- **Dependency:** email provider',
    '- **Location:** `src/outbox/drain.js:12`',
    '- **Current State:** The budget was tuned to an hourly drain.',
    '- **Recommendation & Rationale:** Re-derive it from the current lane.',
    '- **Acceptance signal:** A test pins the budget to the lane cadence.',
    '',
    '## Corrections',
    '',
    '_No findings._',
  ].join('\n');
  const findings = parseAuditReport({
    markdown,
    sourceReport,
    repoRoot: REPO_ROOT,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].dimension, 'assumption drift');
});
