import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyGroupsAgainstGitHub } from '../../.agents/scripts/lib/audit-to-stories/dedupe-against-github.js';
import { renderFingerprintFooter } from '../../.agents/scripts/lib/audit-to-stories/fingerprint.js';

function fakeFinding(sha) {
  return { fingerprint: { full: sha } };
}
function fakeGroup(shas) {
  return { groupKey: `g-${shas[0]}`, findings: shas.map(fakeFinding) };
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

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

test('classifyGroupsAgainstGitHub marks a brand-new group "create"', async () => {
  const groups = [fakeGroup([SHA_A])];
  const provider = inMemoryProvider([]);
  const { classifications, summary } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
  });
  assert.equal(classifications[0].action, 'create');
  assert.equal(summary.create, 1);
});

test('classifyGroupsAgainstGitHub marks an open-issue match "skip-open" (Story AC #4)', async () => {
  const groups = [fakeGroup([SHA_A])];
  const provider = inMemoryProvider([
    {
      number: 42,
      state: 'OPEN',
      body: `prelude\n${renderFingerprintFooter([{ fingerprint: { full: SHA_A } }])}\n`,
    },
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
  const groups = [fakeGroup([SHA_A])];
  const provider = inMemoryProvider([
    {
      number: 100,
      state: 'CLOSED',
      body: renderFingerprintFooter([{ fingerprint: { full: SHA_A } }]),
    },
  ]);
  const { classifications, summary } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
  });
  assert.equal(classifications[0].action, 'skip-reoccurring');
  assert.equal(summary.skipReoccurring, 1);
});

test('classifyGroupsAgainstGitHub ignores false-positive search hits that lack the footer', async () => {
  const groups = [fakeGroup([SHA_A])];
  const provider = inMemoryProvider([
    {
      number: 7,
      state: 'OPEN',
      body: `Mentions ${SHA_A} in prose but no fingerprint footer.`,
    },
  ]);
  const { classifications } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
  });
  // The fake search returns the issue because the sha is in the body,
  // but the footer-confirmation step drops it → still create.
  assert.equal(classifications[0].action, 'create');
});

test('classifyGroupsAgainstGitHub handles a group whose findings span multiple matched issues', async () => {
  const groups = [fakeGroup([SHA_A, SHA_B])];
  const provider = inMemoryProvider([
    {
      number: 9,
      state: 'OPEN',
      body: renderFingerprintFooter([{ fingerprint: { full: SHA_A } }]),
    },
    {
      number: 10,
      state: 'CLOSED',
      body: renderFingerprintFooter([{ fingerprint: { full: SHA_B } }]),
    },
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
  const groups = [fakeGroup([SHA_A]), fakeGroup([SHA_B]), fakeGroup([SHA_C])];
  const provider = inMemoryProvider([
    {
      number: 1,
      state: 'OPEN',
      body: renderFingerprintFooter([{ fingerprint: { full: SHA_A } }]),
    },
    {
      number: 2,
      state: 'CLOSED',
      body: renderFingerprintFooter([{ fingerprint: { full: SHA_B } }]),
    },
  ]);
  const { summary } = await classifyGroupsAgainstGitHub({ groups, provider });
  assert.deepEqual(summary, { create: 1, skipOpen: 1, skipReoccurring: 1 });
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
