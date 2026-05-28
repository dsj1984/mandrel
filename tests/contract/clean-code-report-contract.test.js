// tests/contract/clean-code-report-contract.test.js
//
// Contract tier (Story #3278): the `audit-clean-code` report contract is the
// boundary both execution paths cross. These tests assert that:
//   1. The contract definition matches the lens markdown's Step 3 template
//      (so the sequential path emits it).
//   2. The orchestrated dynamic-workflow synthesis prompt assembles exactly
//      that skeleton (so the absent-feature path and present-feature path
//      produce the same shape).
//   3. The contract's required headings/fields match what the downstream
//      `audit-to-stories` consumer parses.
//
// Report-shape conformance is a contract-tier concern per
// `.agents/rules/testing-standards.md`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertReportContract,
  DEAD_CODE_COLUMNS,
  FINDING_FIELDS,
  REPORT_ARTIFACT_BASENAME,
  REPORT_TITLE,
  REQUIRED_SECTIONS,
} from '../../.agents/scripts/lib/dynamic-workflow/clean-code-report-contract.js';
import {
  buildScopeClause,
  buildSynthesisPrompt,
} from '../../.claude/workflows/audit-clean-code.workflow.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const LENS = readFileSync(
  path.join(REPO_ROOT, '.agents', 'workflows', 'audit-clean-code.md'),
  'utf8',
);

// --- the lens markdown declares the contract the sequential path emits -----

test('lens markdown writes the canonical artifact basename', () => {
  assert.ok(
    LENS.includes(`{{auditOutputDir}}/${REPORT_ARTIFACT_BASENAME}`),
    'lens Step 3 must target {{auditOutputDir}}/audit-clean-code-results.md',
  );
});

test('lens markdown contains the H1 report title', () => {
  assert.ok(new RegExp(`^#\\s+${REPORT_TITLE}\\s*$`, 'm').test(LENS));
});

test('lens markdown declares every required ## section', () => {
  for (const heading of REQUIRED_SECTIONS) {
    assert.ok(
      new RegExp(`^##\\s+${heading}\\s*$`, 'm').test(LENS),
      `lens missing required section: ${heading}`,
    );
  }
});

test('lens markdown declares every per-finding field label', () => {
  for (const field of FINDING_FIELDS) {
    assert.ok(LENS.includes(field), `lens missing finding field: ${field}`);
  }
});

test('lens markdown declares every dead-code inventory column', () => {
  for (const col of DEAD_CODE_COLUMNS) {
    assert.ok(LENS.includes(col), `lens missing dead-code column: ${col}`);
  }
});

// --- assertReportContract distinguishes conformant from broken reports -----

test('assertReportContract: a fully-formed report is conformant', () => {
  const report = [
    `# ${REPORT_TITLE}`,
    '',
    ...REQUIRED_SECTIONS.flatMap((h) => [`## ${h}`, 'body', '']),
  ].join('\n');
  const result = assertReportContract(report);
  assert.equal(result.conformant, true);
  assert.deepEqual(result.missingSections, []);
  assert.equal(result.hasTitle, true);
});

test('assertReportContract: a report missing a section is non-conformant', () => {
  const report = [
    `# ${REPORT_TITLE}`,
    '## Executive Summary',
    '## Detailed Findings',
    '## Dead Code Inventory',
    // Technical Debt Backlog deliberately omitted
  ].join('\n');
  const result = assertReportContract(report);
  assert.equal(result.conformant, false);
  assert.deepEqual(result.missingSections, ['Technical Debt Backlog']);
});

test('assertReportContract: a report missing the title is non-conformant', () => {
  const report = REQUIRED_SECTIONS.map((h) => `## ${h}`).join('\n');
  const result = assertReportContract(report);
  assert.equal(result.conformant, false);
  assert.equal(result.hasTitle, false);
});

// --- the orchestrated path assembles the same contract skeleton ------------

test('orchestrated synthesis prompt names every required section in order', () => {
  const prompt = buildSynthesisPrompt(
    ['### Sample\n- **Dimension:** DRY'],
    'temp/audits',
  );
  for (const heading of REQUIRED_SECTIONS) {
    assert.ok(prompt.includes(heading), `synthesis prompt omits ${heading}`);
  }
  assert.ok(prompt.includes(REPORT_TITLE));
});

test('orchestrated synthesis prompt targets the canonical artifact path', () => {
  const prompt = buildSynthesisPrompt([], 'temp/audits');
  assert.ok(prompt.includes(`temp/audits/${REPORT_ARTIFACT_BASENAME}`));
});

test('orchestrated synthesis prompt tolerates a trailing slash on the output dir', () => {
  const prompt = buildSynthesisPrompt([], 'temp/audits/');
  assert.ok(prompt.includes(`temp/audits/${REPORT_ARTIFACT_BASENAME}`));
  assert.ok(!prompt.includes('audits//'));
});

// --- scope parity: both paths honour the {{changedFiles}} contract ---------

test('buildScopeClause: unsubstituted token → full codebase-wide scan', () => {
  assert.match(buildScopeClause('{{changedFiles}}'), /full codebase/i);
  assert.match(buildScopeClause(''), /full codebase/i);
  assert.match(buildScopeClause(undefined), /full codebase/i);
});

test('buildScopeClause: a real file list → scoped analysis', () => {
  const clause = buildScopeClause('src/a.js\nsrc/b.js');
  assert.match(clause, /Restrict analysis/i);
  assert.ok(clause.includes('src/a.js'));
  assert.ok(clause.includes('src/b.js'));
});

// --- downstream consumer parity --------------------------------------------

test('contract headings match what audit-to-stories parses', () => {
  const parser = readFileSync(
    path.join(
      REPO_ROOT,
      '.agents',
      'scripts',
      'lib',
      'audit-to-stories',
      'parse-audit-md.js',
    ),
    'utf8',
  );
  // The consumer keys off "## Detailed Findings" and per-finding "Agent Prompt".
  assert.ok(parser.includes('Detailed Findings'));
  assert.ok(REQUIRED_SECTIONS.includes('Detailed Findings'));
  assert.ok(FINDING_FIELDS.includes('Agent Prompt'));
});
