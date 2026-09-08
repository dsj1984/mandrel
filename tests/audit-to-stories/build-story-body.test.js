import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import url from 'node:url';
import { buildStoryBody } from '../../.agents/scripts/lib/audit-to-stories/build-story-body.js';
import { withFingerprints } from '../../.agents/scripts/lib/audit-to-stories/finding-adapter.js';
import { groupFindings } from '../../.agents/scripts/lib/audit-to-stories/group-findings.js';
import { parseAuditReports } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';
import { parseFingerprintFooter } from '../../.agents/scripts/lib/findings/route-finding.js';
import { parse as parseStoryBody } from '../../.agents/scripts/lib/story-body/story-body.js';

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
    '## Goal',
    '## Acceptance',
    '## Agent Prompts',
    '## Context',
  ]) {
    assert.ok(body.includes(section), `expected section "${section}" in body`);
  }
  assert.ok(title.length > 0);
});

test('buildStoryBody applies one canonical audit::<lens> label per distinct source report (Story #4195)', () => {
  const { labels } = buildStoryBody({ group: loginGroup() });
  assert.ok(labels.includes('type::story'));
  // No `agent::` state, deliberately: `agent::ready` is what
  // `/mandrel-deliver` reads as "available for pickup", and these bodies are
  // audit prose awaiting the enrichment `/mandrel-plan` owns (Story #5229).
  assert.deepEqual(
    labels.filter((l) => l.startsWith('agent::')),
    [],
  );
  // The login group merges findings from audit-security-results.md and
  // audit-clean-code-results.md, so the canonical lens labels are
  // audit::security + audit::clean-code — derived from the sourceReport
  // basename, NOT the fine-grained dimension text (injection /
  // maintainability / security-misconfiguration), which would mint
  // non-existent labels.
  assert.ok(labels.includes('audit::security'));
  assert.ok(labels.includes('audit::clean-code'));
  // None of the junk dimension-derived labels may appear.
  assert.ok(!labels.includes('audit::injection'));
  assert.ok(!labels.includes('audit::maintainability'));
  assert.ok(!labels.includes('audit::security-misconfiguration'));
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

test('buildStoryBody (real fixtures) clears the inline-contract bar and round-trips', () => {
  // Story #4270: a generated audit Story body must parse into a clean,
  // structured StoryBody with a populated changes[] footprint, non-empty
  // observable acceptance[], and a non-empty tier-tagged verify[] — and the
  // trailing Agent Prompts / Context blocks must NOT bleed into those arrays.
  const group = loginGroup();
  const { body } = parseStoryBody(buildStoryBody({ group }).body);

  // Goal is the group intent only — no leftover ordinal / [SEVERITY] prefix.
  assert.ok(!/^\d+\.\s/.test(body.goal), 'goal must not lead with an ordinal');
  assert.ok(!/\[[A-Z]+\]/.test(body.goal), 'goal must not carry [SEVERITY]');

  // changes[] is canonical { path, assumption } entries drawn from files[].
  assert.ok(body.changes.length > 0, 'changes[] must be populated');
  for (const c of body.changes) {
    assert.equal(typeof c.path, 'string');
    assert.equal(c.assumption, 'refactors-existing');
  }

  // acceptance[] is observable and is NOT swamped by extended sections.
  assert.equal(body.acceptance.length, group.findings.length);
  for (const a of body.acceptance) {
    assert.match(a, /is remediated/);
    assert.ok(!a.includes('## Agent Prompts'));
  }

  // verify[] survives intact — extended markdown did not bleed in.
  assert.deepEqual(body.verify, ['npm run lint (validate)', 'npm test (unit)']);
});

// ---------------------------------------------------------------------------
// Story #5044 — standalone audit cohorts carry declared ordering
// ---------------------------------------------------------------------------

test('buildStoryBody renders each source-report link exactly once (AC-6)', () => {
  // The link used to render as `- [`path`](path)` — the same
  // temp/audits/audit-<lens>-results.md in the label AND the URL, byte-
  // identical across every Story of a same-lens sweep, so the delivery
  // footprint guard scraped it twice as edit intent and serialized the cohort.
  const group = loginGroup();
  const { body } = buildStoryBody({ group });
  for (const report of new Set(group.findings.map((f) => f.sourceReport))) {
    const occurrences = body.split(report).length - 1;
    assert.equal(
      occurrences,
      1,
      `expected ${report} to appear once, saw ${occurrences}`,
    );
    // Still a link, still labelled — the file name is the label, the path is
    // the target.
    assert.ok(body.includes(`[${path.basename(report)}](${report})`));
  }
});

test('buildStoryBody carries the group edges as machine-readable keys (AC-6)', () => {
  const group = loginGroup();
  const edges = [{ fromGroupKey: group.groupKey, toGroupKey: 'other-group' }];
  const built = buildStoryBody({ group, edges });

  assert.equal(built.groupKey, group.groupKey);
  assert.deepEqual(built.dependsOn, ['other-group']);
  // Without issue numbers there is nothing to declare yet, and the prose
  // `## Sequencing` block that used to stand in for it is gone: it declared
  // nothing any scheduler could read.
  assert.ok(!built.body.includes('## Sequencing'));
  assert.deepEqual(parseStoryBody(built.body).body.depends_on, []);
});

test('buildStoryBody resolves group edges to a blocked by #N footer (AC-6)', () => {
  const group = loginGroup();
  const edges = [{ fromGroupKey: group.groupKey, toGroupKey: 'other-group' }];
  const built = buildStoryBody({
    group,
    edges,
    issueByGroupKey: { [group.groupKey]: 4200, 'other-group': 4199 },
  });

  assert.ok(built.body.includes('blocked by #4199'));
  // The footer is the canonical serializer's own, so /mandrel-deliver's resolver reads
  // this Story's ordering from exactly where it reads every other Story's.
  const parsed = parseStoryBody(built.body).body;
  assert.deepEqual(parsed.depends_on, ['#4199']);
  // ...and the rest of the inline contract still round-trips around it.
  assert.equal(parsed.acceptance.length, group.findings.length);
  assert.deepEqual(parsed.verify, [
    'npm run lint (validate)',
    'npm test (unit)',
  ]);
});

test('buildStoryBody drops an edge whose target was never opened (AC-6)', () => {
  // A group deduped against an existing Issue or suppressed by the ledger has
  // no number. `blocked by #undefined` would gate the Story on nothing forever,
  // which is strictly worse than the un-ordered cohort this replaces.
  const group = loginGroup();
  const built = buildStoryBody({
    group,
    edges: [{ fromGroupKey: group.groupKey, toGroupKey: 'never-created' }],
    issueByGroupKey: { [group.groupKey]: 4200 },
  });
  assert.ok(!built.body.includes('blocked by'));
  assert.deepEqual(parseStoryBody(built.body).body.depends_on, []);
});
