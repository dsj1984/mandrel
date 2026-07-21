// tests/contract/architecture-report-contract.test.js
//
// Contract tier (Epic #3597, Story #3612): the `audit-architecture` report
// contract is the boundary both execution paths cross. These tests assert that:
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
  FINDING_FIELDS,
  REPORT_ARTIFACT_BASENAME,
  REPORT_TITLE,
  REQUIRED_SECTIONS,
} from '../../.agents/scripts/lib/dynamic-workflow/architecture-report-contract.js';
import {
  buildScopeClause,
  buildSynthesisPrompt,
  DIMENSION_FINDING_FIELDS,
  DIMENSIONS,
} from '../../.claude/workflows/audit-architecture.workflow.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const LENS = readFileSync(
  path.join(REPO_ROOT, '.agents', 'workflows', 'audit-architecture.md'),
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
    'lens Step 3 must target {{auditOutputDir}}/audit-architecture-results.md',
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
    '## Triage Summary',
    '## Architecture Guardrail Coverage',
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
    ['### Sample\n- **Dimension:** Coupling & Cohesion'],
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

// --- dimension/field parity: the orchestrated path cannot drift (Story #4628)

/**
 * Extract the bold lead-in label of every top-level numbered item under the
 * lens's `## Step 2: Analysis Dimensions` section — the canonical dimension
 * roster the orchestrated `DIMENSIONS` export must mirror. Sub-bullets
 * (`- **High** —`) are `-` items, never numbered, so they are not harvested.
 *
 * @param {string} md
 * @returns {string[]}
 */
function lensAnalysisDimensions(md) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /^## Step 2: Analysis Dimensions/.test(l),
  );
  assert.ok(
    start !== -1,
    'lens is missing its "## Step 2: Analysis Dimensions" section',
  );
  const dims = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break; // next top-level section ends Step 2
    const m = /^\d+\.\s+\*\*(.+?):\*\*/.exec(lines[i]);
    if (m) dims.push(m[1].trim());
  }
  return dims;
}

test('DIMENSIONS mirrors the lens Step 2 roster exactly (no orchestrated drift)', () => {
  assert.deepEqual([...DIMENSIONS], lensAnalysisDimensions(LENS));
});

test('the pinned roster keeps Testable Surface after ceding the clean-code dimensions', () => {
  assert.ok(
    DIMENSIONS.includes('Testable Surface (Humble-Object Boundary)'),
    `DIMENSIONS dropped Testable Surface: ${DIMENSIONS.join(', ')}`,
  );
  // The five ceded dimensions must NOT reappear in the orchestrated roster.
  for (const ceded of [
    'Over-Engineering & Abstractions',
    'Cognitive Load & Nesting',
    'Dead Code & Redundancy',
    'Naming & Self-Documentation',
    'Coupling & Cohesion',
  ]) {
    assert.ok(
      !DIMENSIONS.includes(ceded),
      `ceded dimension "${ceded}" must not appear in the orchestrated roster`,
    );
  }
});

test('the dimension prompt field list includes Impact (was dropped by the frozen list)', () => {
  assert.ok(
    DIMENSION_FINDING_FIELDS.includes('Impact'),
    `DIMENSION_FINDING_FIELDS omits Impact: ${DIMENSION_FINDING_FIELDS.join(', ')}`,
  );
  assert.ok(DIMENSION_FINDING_FIELDS.includes('Location'));
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
