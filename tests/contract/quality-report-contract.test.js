// tests/contract/quality-report-contract.test.js
//
// Contract tier (Epic #3597, Story #3614): the `audit-quality` report
// contract is the boundary both execution paths cross. These tests assert
// that:
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
  FINDING_CATEGORIES,
  FINDING_FIELDS,
  IMPACT_LEVELS,
  REPORT_ARTIFACT_BASENAME,
  REPORT_TITLE,
  REQUIRED_SECTIONS,
} from '../../.agents/scripts/lib/dynamic-workflow/quality-report-contract.js';
import {
  buildScopeClause,
  buildSynthesisPrompt,
} from '../../.claude/workflows/audit-quality.workflow.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const LENS = readFileSync(
  path.join(REPO_ROOT, '.agents', 'workflows', 'audit-quality.md'),
  'utf8',
);

const CORE = readFileSync(
  path.join(REPO_ROOT, '.agents', 'workflows', 'helpers', 'audit-lens-core.md'),
  'utf8',
);
// The shared finding-block skeleton, severity scale, and the two normalized
// axes now live in the core helper (Story #4665); the lens composes its own
// title + lens-specific sections/fields onto it. The contract is satisfied by
// the composed source.
const SOURCE = `${LENS}
${CORE}`;

// --- the lens markdown declares the contract the sequential path emits -----

test('lens markdown writes the canonical artifact basename', () => {
  assert.ok(
    LENS.includes(`{{auditOutputDir}}/${REPORT_ARTIFACT_BASENAME}`),
    'lens Step 3 must target {{auditOutputDir}}/audit-quality-results.md',
  );
});

test('lens markdown contains the H1 report title', () => {
  assert.ok(new RegExp(`^#\\s+${REPORT_TITLE}\\s*$`, 'm').test(SOURCE));
});

test('lens markdown declares every required ## section', () => {
  for (const heading of REQUIRED_SECTIONS) {
    assert.ok(
      new RegExp(`^##\\s+${heading}\\s*$`, 'm').test(SOURCE),
      `lens missing required section: ${heading}`,
    );
  }
});

test('lens markdown declares every per-finding field label', () => {
  for (const field of FINDING_FIELDS) {
    assert.ok(SOURCE.includes(field), `lens missing finding field: ${field}`);
  }
});

test('lens markdown references the finding categories', () => {
  for (const category of FINDING_CATEGORIES) {
    assert.ok(
      SOURCE.includes(category),
      `lens missing finding category: ${category}`,
    );
  }
});

test('lens markdown references the impact taxonomy', () => {
  for (const level of IMPACT_LEVELS) {
    assert.ok(SOURCE.includes(level), `lens missing impact level: ${level}`);
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
    '## Test Strategy Assessment',
    // Detailed Findings deliberately omitted
  ].join('\n');
  const result = assertReportContract(report);
  assert.equal(result.conformant, false);
  assert.deepEqual(result.missingSections, ['Detailed Findings']);
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
    ['### Sample\n- **Category:** Coverage'],
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
  // The consumer keys off "## Detailed Findings" plus per-finding
  // "Impact" / "Category" / "Agent Prompt" fields.
  assert.ok(parser.includes('Detailed Findings'));
  assert.ok(REQUIRED_SECTIONS.includes('Detailed Findings'));
  assert.ok(FINDING_FIELDS.includes('Impact'));
  assert.ok(FINDING_FIELDS.includes('Category'));
  assert.ok(FINDING_FIELDS.includes('Agent Prompt'));
});
