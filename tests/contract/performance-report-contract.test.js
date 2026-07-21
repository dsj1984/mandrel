// tests/contract/performance-report-contract.test.js
//
// Contract tier (Epic #3597, Story #3611): the `audit-performance` report
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
} from '../../.agents/scripts/lib/dynamic-workflow/performance-report-contract.js';
import {
  buildDimensionPrompt,
  buildScopeClause,
  buildSynthesisPrompt,
  MEASUREMENT_COMMAND_ALLOWLIST,
  MEASUREMENT_TOOLS,
  READ_ONLY_TOOLS,
} from '../../.claude/workflows/audit-performance.workflow.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const LENS = readFileSync(
  path.join(REPO_ROOT, '.agents', 'workflows', 'audit-performance.md'),
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
    'lens Step 3 must target {{auditOutputDir}}/audit-performance-results.md',
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

test('composed source documents the execution strategy incl. the demoted orchestrated path', () => {
  // Story #4665: the shared dual-path prose moved into the core's Execution
  // strategy, where the orchestrated dynamic-workflow path is demoted to an
  // optimization note over the first-class subagent-dispatch path. The lens
  // still declares subagent dispatch as its execution section.
  assert.ok(
    /^##\s+Execution strategy\s*$/m.test(LENS),
    'performance lens missing its "## Execution strategy" section',
  );
  assert.ok(
    /subagent_type: auditor/.test(SOURCE) &&
      /orchestrated|dynamic-workflow/i.test(SOURCE),
    'composed source does not document subagent dispatch + the demoted orchestrated path',
  );
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

test('assertReportContract: a report missing the Low-Hanging Fruit section is non-conformant', () => {
  const report = [
    `# ${REPORT_TITLE}`,
    '## Executive Summary',
    '## Detailed Findings',
    // Low-Hanging Fruit deliberately omitted
  ].join('\n');
  const result = assertReportContract(report);
  assert.equal(result.conformant, false);
  assert.deepEqual(result.missingSections, ['Low-Hanging Fruit']);
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
    ['### Sample\n- **Dimension:** Latency'],
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

// --- AC-5: the orchestrated path can EXECUTE measurements -------------------

test('measurement agents are granted Bash on top of the read-only trio', () => {
  assert.ok(
    MEASUREMENT_TOOLS.includes('Bash'),
    'measurement agents must be granted Bash to run Step 0 measurements',
  );
  for (const tool of READ_ONLY_TOOLS) {
    assert.ok(
      MEASUREMENT_TOOLS.includes(tool),
      `measurement allowlist dropped read-only tool ${tool}`,
    );
  }
});

test('the command allowlist is non-empty and holds only non-mutating commands', () => {
  assert.ok(
    MEASUREMENT_COMMAND_ALLOWLIST.length > 0,
    'measurement command allowlist is empty — execution was stripped, not restricted',
  );
  // The measurement toolkit the lens Step 0 names must be present.
  for (const cmd of ['hyperfine', 'node --cpu-prof']) {
    assert.ok(
      MEASUREMENT_COMMAND_ALLOWLIST.includes(cmd),
      `measurement allowlist omits the Step 0 command "${cmd}"`,
    );
  }
  // No mutating command may leak into a "non-mutating" allowlist.
  const joined = MEASUREMENT_COMMAND_ALLOWLIST.join('\n');
  for (const forbidden of [
    'rm ',
    'git commit',
    'git push',
    'git checkout',
    'npm install',
    'npm ci',
    'sed -i',
    'mv ',
  ]) {
    assert.ok(
      !joined.includes(forbidden),
      `measurement allowlist must not contain the mutating command "${forbidden.trim()}"`,
    );
  }
});

test('every dimension prompt embeds the allowlist and the Evidence requirement', () => {
  const prompt = buildDimensionPrompt('CPU & algorithmic hot paths', LENS, '');
  for (const cmd of MEASUREMENT_COMMAND_ALLOWLIST) {
    assert.ok(
      prompt.includes(cmd),
      `dimension prompt does not surface allowlisted command "${cmd}"`,
    );
  }
  assert.match(prompt, /Evidence field/i);
  assert.match(prompt, /measured|estimated/i);
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
