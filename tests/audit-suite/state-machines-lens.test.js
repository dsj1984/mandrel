/**
 * tests/audit-suite/state-machines-lens.test.js
 *
 * Contract tests for the `audit-state-machines` lens: registration and
 * routing, the two-part qualifying bar, the five dimensions, the mandatory
 * State Inventory and Refactor Sketch sections, the sibling boundaries, and a
 * report in the lens template parsing with its findings attributed to it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveLensTier } from '../../.agents/scripts/lib/audit-suite/index.js';
import { selectAudits } from '../../.agents/scripts/lib/audit-suite/selector.js';
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

const LENS = 'audit-state-machines';
const lens = read(`.agents/workflows/${LENS}.md`);
const rules = JSON.parse(read('.agents/schemas/audit-rules.json'));

const DIMENSIONS = [
  'Boolean Soup',
  'Status Sidecar',
  'Scattered Transitions',
  'Unhandled State',
  'Distributed State',
];

test('audit-rules.json registers the lens as a cumulative gate1/gate3 lens with code-only patterns and no target', () => {
  const entry = rules.audits[LENS];
  assert.ok(entry, `${LENS} is not registered`);
  assert.equal(entry.scope, 'cumulative');
  assert.equal(entry.target, undefined);
  assert.deepEqual(entry.triggers.gates, ['gate1', 'gate3']);
  assert.ok(entry.triggers.keywords.includes('state machine'));
  assert.ok(!entry.triggers.filePatterns.includes('**/*'));
  assert.equal(resolveLensTier(LENS), 'cumulative');
});

test('the report basename labels findings audit::state-machines', () => {
  assert.ok(isCanonicalLens('state-machines'));
  assert.equal(
    lensFromSourceReport('temp/audits/audit-state-machines-results.md'),
    'state-machines',
  );
});

test('the selector routes the lens for a source change and not for a docs-only change', async () => {
  const provider = {
    getTicket: async () => ({ title: 'Tidy the docs', body: 'Copy edits.' }),
  };
  const route = async (changedFiles) =>
    (await selectAudits({ ticketId: 1, gate: 'gate1', provider, changedFiles }))
      .selectedAudits;

  assert.ok((await route(['src/orders/checkout.js'])).includes(LENS));
  assert.ok(!(await route(['docs/guide.md'])).includes(LENS));
});

test('lens: states the two-part qualifying bar and inventories an unreachable candidate without a finding', () => {
  assertDocMentions(lens, /Two or more variables change together/);
  assertDocMentions(lens, /traced path/);
  assertDocMentions(lens, /`reachable: no` and produces \*\*no finding\*\*/);
});

test('lens: names its five dimensions as Dimension values and ### sections', () => {
  assert.ok(lens.includes(`\`${DIMENSIONS.join(' | ')}\``));
  for (const heading of DIMENSIONS) {
    assert.ok(lens.includes(`\n### ${heading}\n`), `lens omits ### ${heading}`);
  }
});

test('lens: the report template puts the State Inventory first and ends with the Refactor Sketch', () => {
  const template = lens.slice(lens.indexOf('# State Machine Audit Report'));
  const inventory = template.indexOf('\n## State Inventory\n');
  const findings = template.indexOf('\n## Detailed Findings\n');
  const sketch = template.indexOf('\n## Refactor Sketch\n');
  assert.ok(inventory > 0 && findings > inventory && sketch > findings);
  for (const field of ['Variables', 'Reachable Path', 'Explicit Form']) {
    assert.ok(template.includes(`- **${field}:**`), `template omits ${field}`);
  }
});

test('lens: the Refactor Sketch names explicit forms and edits no code', () => {
  assertDocMentions(lens, /discriminated union/);
  assertDocMentions(lens, /JSDoc `@typedef` union plus one guard function/);
  assertDocMentions(lens, /transition table/);
  assertDocMentions(lens, /this lens edits no code/);
});

test('lens: every Reachable Path takes a second read of the write order', () => {
  assertDocMentions(lens, /Second read of the write order/);
});

test('lens: defers to its four sibling lenses in code spans', () => {
  const boundaries = lens.slice(
    lens.indexOf('## Boundaries'),
    lens.indexOf('## Scope'),
  );
  for (const sibling of [
    'audit-resilience',
    'audit-data-model',
    'audit-performance',
    'audit-clean-code',
  ]) {
    assert.ok(
      boundaries.includes(`- \`${sibling}\``),
      `no boundary for ${sibling}`,
    );
  }
});

test('a report in the lens template parses with its findings attributed to the lens', () => {
  const markdown = [
    '# State Machine Audit Report',
    '',
    '## Executive Summary',
    '',
    'Self-cross-check: kept 1 / dropped 0.',
    'Severity tally: Critical 0 / High 1 / Medium 0 / Low 0',
    '',
    '## State Inventory',
    '',
    '| Candidate | Variables | Implicit states | Transitions (writers) | Impossible or unhandled combinations | Reachable |',
    '| --- | --- | --- | --- | --- | --- |',
    '| order payment | `src/orders/pay.js:4` | pending, paid | `src/orders/pay.js:9` | paid with no charge id | yes |',
    '',
    '## Detailed Findings',
    '',
    '### `src/orders/pay.js` — Retry re-enters the charge after it succeeded',
    '',
    '- **Dimension:** Scattered Transitions',
    '- **Severity:** High',
    '- **Variables:** `src/orders/pay.js:4`, `src/orders/pay.js:5`',
    '- **Reachable Path:** retry handler → `src/orders/pay.js:9` → charged twice',
    '- **Explicit Form:** a tagged `{ kind: "paid", chargeId }` state',
    '- **Location:** `src/orders/pay.js:9`',
    '- **Current State:** The retry path writes `paid` without a guard.',
    '- **Recommendation & Rationale:** Route every writer through one guard.',
    '- **Acceptance signal:** A test drives the retry and sees one charge.',
    '',
    '## Refactor Sketch',
    '',
    '_No findings._',
  ].join('\n');
  const findings = parseAuditReport({
    markdown,
    sourceReport: `temp/audits/${LENS}-results.md`,
    repoRoot: REPO_ROOT,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].dimension, 'scattered transitions');
});
