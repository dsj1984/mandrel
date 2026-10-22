/**
 * tests/audit-suite/policies-lens.test.js — Story #5848.
 *
 * Contract tests for the `audit-policies` lens: the one lens that reads a
 * project's published customer-facing policies and checks them against the
 * implementation in both directions, without ever editing the policy text.
 *
 * Four halves are locked here:
 *
 *   - **Registration.** A cumulative gate1/gate3 lens behind the `policies`
 *     target, resolvable through the SDK barrel, labelled `audit::policies`.
 *   - **Config.** The closed `project.policies` block validates populated,
 *     rejects an unknown key, and is optional.
 *   - **Body contract.** The six dimensions, the four added fields, the
 *     severity anchors, the never-edit invariant and the not-legal-advice
 *     line, asserted wrap-independently since the prose is the prompt.
 *   - **Report shape.** A fixture report in the lens's template parses with
 *     no report failures and attributes its findings to the lens.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { __testing } from '../../.agents/scripts/audit-to-stories.js';
import { resolveLensTier } from '../../.agents/scripts/lib/audit-suite/index.js';
import {
  isCanonicalLens,
  lensFromSourceReport,
} from '../../.agents/scripts/lib/audit-to-stories/audit-lenses.js';
import { parseAuditReport } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';
import { assertDocMentions } from '../helpers/doc-assert.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const lens = read('.agents/workflows/audit-policies.md');
const documentation = read('.agents/workflows/audit-documentation.md');
const rules = JSON.parse(read('.agents/schemas/audit-rules.json'));
const rulesSchema = JSON.parse(read('.agents/schemas/audit-rules.schema.json'));

const PROJECT = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('audit-rules.json registers audit-policies as a cumulative lens behind the policies target', () => {
  const entry = rules.audits['audit-policies'];
  assert.ok(entry, 'audit-policies is not registered');
  assert.equal(entry.scope, 'cumulative');
  assert.equal(entry.target, 'policies');
  assert.deepEqual(entry.triggers.gates, ['gate1', 'gate3']);
  for (const keyword of ['privacy policy', 'refund policy', 'consent form']) {
    assert.ok(
      entry.triggers.keywords.includes(keyword),
      `keywords omit '${keyword}'`,
    );
  }
  assert.ok(entry.triggers.filePatterns.includes('**/legal/**'));
});

test('the audit-rules schema accepts the policies target and names its probe', () => {
  const target = rulesSchema.definitions.auditEntry.properties.target;
  assert.ok(target.enum.includes('policies'));
  assertDocMentions(target.description, /hasPolicyCorpus\(\) for `policies`/);
});

test('resolveLensTier resolves audit-policies to cumulative through the SDK barrel', () => {
  assert.equal(resolveLensTier('audit-policies'), 'cumulative');
});

test('the report basename labels findings audit::policies', () => {
  assert.ok(isCanonicalLens('policies'));
  assert.equal(
    lensFromSourceReport('temp/audits/audit-results/audit-policies-results.md'),
    'policies',
  );
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('the runtime validator accepts a populated project.policies block', () => {
  const validate = getAgentrcValidator();
  const ok = validate({
    project: {
      ...PROJECT,
      policies: {
        corpusGlobs: ['site/legal/**/*.md'],
        impactMap: 'docs/policy-impact.json',
        backingDocs: ['docs/runbooks/**'],
        acceptedFindings: 'docs/policy-accepted.json',
      },
    },
  });
  assert.equal(
    ok,
    true,
    `project.policies must validate; errors: ${JSON.stringify(validate.errors)}`,
  );
});

test('the runtime validator rejects an unknown key inside project.policies', () => {
  const validate = getAgentrcValidator();
  const ok = validate({
    project: { ...PROJECT, policies: { corpusGlobs: [], rewriteText: true } },
  });
  assert.equal(ok, false, 'project.policies must be a closed block');
});

test('the runtime validator accepts a config with project.policies absent', () => {
  const validate = getAgentrcValidator();
  assert.equal(validate({ project: PROJECT }), true);
});

// ---------------------------------------------------------------------------
// Body contract
// ---------------------------------------------------------------------------

test('lens: names its six dimensions as bold-lead bullets', () => {
  for (const dimension of [
    'Contradiction',
    'Unbacked Promise',
    'Undisclosed Practice',
    'Stale Reference',
    'Internal Inconsistency',
    'Unverifiable',
  ]) {
    assert.ok(
      lens.includes(`- **${dimension}** —`),
      `lens omits the ${dimension} bold-lead bullet`,
    );
  }
});

test('lens: skeleton adds the four lens fields with Direction defaulting to undecided', () => {
  for (const field of ['Policy', 'Implementation', 'Backing', 'Direction']) {
    assert.ok(
      lens.includes(`- **${field}:**`),
      `skeleton omits the ${field} field`,
    );
  }
  assertDocMentions(lens, /\[text \| code \| undecided — default undecided\]/);
  assertDocMentions(lens, /## Claims Coverage/);
  assertDocMentions(
    lens,
    /Direction split: text <n> \/ code <n> \/ undecided <n>/,
  );
});

test('lens: states the four severity anchors', () => {
  assertDocMentions(
    lens,
    /`High` — a published commitment about money, children's or health data, deletion and retention, consent, or third-party sharing/,
  );
  assertDocMentions(lens, /`Medium` — any other Contradiction/);
  assertDocMentions(
    lens,
    /`Low` — Stale References and Internal Inconsistencies/,
  );
  assertDocMentions(lens, /`Info` — Unverifiable claims/);
});

test('lens: states the never-edit-policy-text invariant', () => {
  assertDocMentions(lens, /this lens never edits policy text/i);
  assertDocMentions(
    lens,
    /names the decision to be made .* and never drafts replacement wording/,
  );
  assertDocMentions(
    lens,
    /first acceptance criterion is a recorded operator decision/,
  );
});

test('lens: carries the fixed not-legal-advice line', () => {
  assertDocMentions(
    lens,
    /checks consistency between published text and implementation, not legal adequacy, and is not legal advice/,
  );
});

test('lens: defines fenced and unfenced scope', () => {
  assertDocMentions(
    lens,
    /every policy whose `impactMap` globs match a changed file; every changed policy file; and every policy sentence that names a symbol, route, provider, setting or value the change set touches/,
  );
  assertDocMentions(lens, /sweep the whole corpus/);
  assertDocMentions(lens, /## Periodic full-scope sweep/);
});

test('lens: defines acceptedFindings suppression and expiry', () => {
  assertDocMentions(
    lens,
    /whose `reviewBy` date has not passed, do not report it/,
  );
  assertDocMentions(
    lens,
    /`reviewBy` has passed is reported as a Low `Stale Reference`/,
  );
});

test('lens and documentation lens state the corpus boundary both ways', () => {
  assertDocMentions(lens, /stays \[`\/audit-privacy`\]/);
  assertDocMentions(lens, /not \[`\/audit-exceptions`\]/);
  assertDocMentions(
    documentation,
    /The published policy corpus is excluded\..*never enter this lens's target set/,
  );
});

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

test('a fixture report in the lens template parses with no report failures', () => {
  const sourceReport =
    'tests/fixtures/audit-policies/audit-policies-results.md';
  const markdown = read(sourceReport);
  const findings = parseAuditReport({
    markdown,
    sourceReport,
    repoRoot: REPO_ROOT,
  });
  assert.equal(findings.length, 3);
  for (const finding of findings) {
    for (const field of ['policy', 'implementation', 'backing', 'direction']) {
      assert.ok(
        finding.rawFields[field],
        `${finding.title} lost its ${field} field`,
      );
    }
  }
  assert.deepEqual(
    findings.map((f) => f.dimension),
    ['unbacked promise', 'undisclosed practice', 'internal inconsistency'],
  );
  assert.equal(lensFromSourceReport(sourceReport), 'policies');

  const { failures } = __testing.crossCheckReports({
    reports: [{ sourceReport, markdown }],
    findings,
  });
  assert.deepEqual(failures, []);
});
