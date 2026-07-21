import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyGroupsAgainstGitHub } from '../../.agents/scripts/lib/audit-to-stories/dedupe-against-github.js';
import {
  fingerprintAuditFinding,
  renderFingerprintFooter,
  withFingerprints,
} from '../../.agents/scripts/lib/audit-to-stories/finding-adapter.js';

// Build real audit findings (dimension/normalisedTitle/files) so the
// classifier's routeFinding call recomputes exactly the sha the group
// carries — the production invariant. The dedupe module owns no fingerprint
// logic; it routes every finding through the shared helper.
function auditFinding(dimension, normalisedTitle, file) {
  return { dimension, normalisedTitle, files: file ? [file] : [] };
}
function fakeGroup(findings) {
  const stamped = withFingerprints(findings);
  return { groupKey: `g-${stamped[0]?.fingerprint?.short}`, findings: stamped };
}
function shaOf(finding) {
  return fingerprintAuditFinding(finding).full;
}

function inMemoryProvider(issues) {
  return {
    async findIssuesByFingerprint(sha) {
      return issues.filter(
        (i) => typeof i.body === 'string' && i.body.includes(sha),
      );
    },
  };
}

const FINDING_A = auditFinding('injection', 'sqli in login', 'src/a.js');
const FINDING_B = auditFinding('xss', 'reflected xss in search', 'src/b.js');
const FINDING_C = auditFinding('secrets', 'hardcoded token', 'src/c.js');

function footerFor(finding) {
  return renderFingerprintFooter(withFingerprints([finding]));
}

test('classifyGroupsAgainstGitHub marks a brand-new group "create"', async () => {
  const groups = [fakeGroup([FINDING_A])];
  const provider = inMemoryProvider([]);
  const { classifications, summary } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
  });
  assert.equal(classifications[0].action, 'create');
  assert.equal(summary.create, 1);
});

test('classifyGroupsAgainstGitHub marks an open-issue match "skip-open"', async () => {
  const groups = [fakeGroup([FINDING_A])];
  const provider = inMemoryProvider([
    { number: 42, state: 'OPEN', body: `prelude\n${footerFor(FINDING_A)}\n` },
  ]);
  const { classifications, summary } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
  });
  assert.equal(classifications[0].action, 'skip-open');
  assert.equal(classifications[0].matchedIssues[0].number, 42);
  assert.equal(summary.skipOpen, 1);
});

test('classifyGroupsAgainstGitHub marks a closed-only match "skip-reoccurring"', async () => {
  const groups = [fakeGroup([FINDING_A])];
  const provider = inMemoryProvider([
    { number: 100, state: 'CLOSED', body: footerFor(FINDING_A) },
  ]);
  const { classifications, summary } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
  });
  assert.equal(classifications[0].action, 'skip-reoccurring');
  assert.equal(summary.skipReoccurring, 1);
});

test('classifyGroupsAgainstGitHub ignores false-positive search hits that lack the footer', async () => {
  const groups = [fakeGroup([FINDING_A])];
  const provider = inMemoryProvider([
    {
      number: 7,
      state: 'OPEN',
      body: `Mentions ${shaOf(FINDING_A)} in prose but no fingerprint footer.`,
    },
  ]);
  const { classifications } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
  });
  // The fake search returns the issue because the sha is in the body,
  // but the shared helper's footer-confirmation step drops it → still create.
  assert.equal(classifications[0].action, 'create');
});

test('classifyGroupsAgainstGitHub handles a group whose findings span multiple matched issues', async () => {
  const groups = [fakeGroup([FINDING_A, FINDING_B])];
  const provider = inMemoryProvider([
    { number: 9, state: 'OPEN', body: footerFor(FINDING_A) },
    { number: 10, state: 'CLOSED', body: footerFor(FINDING_B) },
  ]);
  const { classifications } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
  });
  // Any OPEN match beats CLOSED — action is skip-open.
  assert.equal(classifications[0].action, 'skip-open');
  assert.equal(classifications[0].matchedIssues.length, 2);
});

test('classifyGroupsAgainstGitHub summary tallies multiple groups', async () => {
  const groups = [
    fakeGroup([FINDING_A]),
    fakeGroup([FINDING_B]),
    fakeGroup([FINDING_C]),
  ];
  const provider = inMemoryProvider([
    { number: 1, state: 'OPEN', body: footerFor(FINDING_A) },
    { number: 2, state: 'CLOSED', body: footerFor(FINDING_B) },
  ]);
  const { summary } = await classifyGroupsAgainstGitHub({ groups, provider });
  // `dedupDegraded` is always reported alongside the counters (Story #4678):
  // zero degradations when every lookup completes.
  assert.deepEqual(summary, {
    create: 1,
    skipOpen: 1,
    skipReoccurring: 1,
    dedupDegraded: { count: 0, groups: [] },
  });
});

test('classifyGroupsAgainstGitHub throws on missing provider', async () => {
  await assert.rejects(
    classifyGroupsAgainstGitHub({ groups: [], provider: null }),
  );
});

test('classifyGroupsAgainstGitHub throws on non-array groups', async () => {
  await assert.rejects(
    classifyGroupsAgainstGitHub({
      groups: null,
      provider: { findIssuesByFingerprint: async () => [] },
    }),
  );
});
