import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import url from 'node:url';
import { withFingerprints } from '../../.agents/scripts/lib/audit-to-stories/finding-adapter.js';
import { groupFindings } from '../../.agents/scripts/lib/audit-to-stories/group-findings.js';
import { parseAuditReports } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';
import { buildPlanSeedMarkdown } from '../../.agents/scripts/lib/audit-to-stories/seed-from-findings.js';

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

test('buildPlanSeedMarkdown emits all canonical one-pager sections', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const md = buildPlanSeedMarkdown({
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

test('the single-plan seed states findings flat, deciding no partition (Story #5332 AC-7)', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const md = buildPlanSeedMarkdown({
    groups,
    findings,
    sourceReports: loadAll().map((r) => r.sourceReport),
  });

  // No `## Grouping` directive: container grouping is Gate #3's call at
  // persist, where N is known.
  assert.ok(!md.includes('## Grouping'), 'seed must carry no ## Grouping');

  const scope = md.slice(
    md.indexOf('## MVP Scope'),
    md.indexOf('## Key Files'),
  );
  const visible = scope
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('<!--'));

  // No ordinal Story numbering anywhere in the visible list.
  for (const line of visible) {
    assert.doesNotMatch(
      line,
      /^\s*\d+\.\s/,
      `MVP Scope must carry no numbered Story bullet: ${line}`,
    );
  }

  // One visible bullet per finding — the findings themselves, not groups.
  const bullets = visible.filter((line) => line.startsWith('- **'));
  assert.equal(bullets.length, findings.length);
  for (const f of findings) {
    assert.ok(
      md.includes(`- **${f.title}**`),
      `seed must state the finding "${f.title}"`,
    );
  }
});

test('buildPlanSeedMarkdown references concrete files in Key Files', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const md = buildPlanSeedMarkdown({
    groups,
    findings,
    sourceReports: loadAll().map((r) => r.sourceReport),
  });
  assert.ok(md.includes('src/routes/auth/login.js'));
  assert.ok(md.includes('src/middleware/error-handler.js'));
});

test('buildPlanSeedMarkdown problem statement counts findings and severities', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const md = buildPlanSeedMarkdown({
    groups,
    findings,
    sourceReports: loadAll().map((r) => r.sourceReport),
  });
  assert.ok(/7 findings/.test(md));
  assert.ok(/High/i.test(md));
});

test('buildPlanSeedMarkdown lists every source report in Key Assumptions', () => {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const reports = loadAll().map((r) => r.sourceReport);
  const md = buildPlanSeedMarkdown({
    groups,
    findings,
    sourceReports: reports,
  });
  for (const r of reports) {
    assert.ok(md.includes(r));
  }
});

test('buildPlanSeedMarkdown throws on bad input', () => {
  assert.throws(() =>
    buildPlanSeedMarkdown({ groups: null, findings: [], sourceReports: [] }),
  );
});

test('buildPlanSeedMarkdown handles zero findings gracefully', () => {
  const md = buildPlanSeedMarkdown({
    groups: [],
    findings: [],
    sourceReports: [],
  });
  assert.ok(md.includes('## Problem Statement'));
  assert.ok(md.includes('_(no concrete file paths surfaced)_'));
});

// ---------------------------------------------------------------------------
// Story #5569 — each finding carries its own fix; the direction is a tally
// ---------------------------------------------------------------------------

function seedFromFixtures() {
  const findings = withFingerprints(parseAuditReports(loadAll()));
  const { groups } = groupFindings(findings);
  const md = buildPlanSeedMarkdown({
    groups,
    findings,
    sourceReports: loadAll().map((r) => r.sourceReport),
  });
  return { findings, md };
}

test('MVP Scope nests each finding’s Recommendation and Acceptance signal under it, worst first', () => {
  const { findings, md } = seedFromFixtures();
  const scope = md.slice(
    md.indexOf('## MVP Scope'),
    md.indexOf('## Key Files'),
  );
  for (const f of findings) {
    const at = scope.indexOf(`- **${f.title}**`);
    const next = scope.indexOf('\n- **', at + 1);
    const block = scope.slice(at, next === -1 ? undefined : next);
    assert.ok(block.includes(`  - **Recommendation:** ${f.recommendation}`));
    assert.ok(
      block.includes(`  - **Acceptance signal:** ${f.acceptanceSignal}`),
    );
    assert.ok(!block.includes('**Location:**'), 'an absent field is omitted');
  }
  const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  const order = findings
    .map((f) => ({ f, at: scope.indexOf(`- **${f.title}**`) }))
    .sort((a, b) => a.at - b.at)
    .map(({ f }) => rank[f.severity]);
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1] >= order[i], `out of severity order: ${order}`);
  }
});

test('Recommended Direction is a per-dimension tally with no recommendation text', () => {
  const { findings, md } = seedFromFixtures();
  const direction = md.slice(
    md.indexOf('## Recommended Direction'),
    md.indexOf('## Key Assumptions'),
  );
  for (const f of findings) {
    assert.ok(!direction.includes(f.recommendation));
  }
  assert.match(
    direction,
    /— \d+ findings? \(\d+ (Critical|High|Medium|Low|Info)/,
  );
});
