import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { __testing } from '../../.agents/scripts/audit-to-stories.js';
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

// ---------------------------------------------------------------------------
// Story #5079 — the semantic port widens the fingerprint lookup, never
// replaces it. Production always injects `searchCandidates`, so before the
// union the exact `findIssuesByFingerprint` lookup never ran on the live path
// and already-filed groups re-classified `create`.
// ---------------------------------------------------------------------------

test('classifyGroupsAgainstGitHub skips an open match the semantic port does not return (Story #5079)', async () => {
  const groups = [fakeGroup([FINDING_A])];
  const provider = inMemoryProvider([
    { number: 5077, state: 'open', body: `prelude\n${footerFor(FINDING_A)}\n` },
  ]);
  const { classifications, summary } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
    // The measured shape: the bag-of-words query retrieves nothing.
    searchCandidates: async () => [],
  });
  assert.equal(classifications[0].action, 'skip-open');
  assert.deepEqual(classifications[0].matchedIssues, [
    { number: 5077, state: 'open' },
  ]);
  assert.equal(summary.skipOpen, 1);
  assert.equal(summary.create, 0);
  assert.equal(summary.dedupDegraded.count, 0);
});

test('classifyGroupsAgainstGitHub degrades when the fingerprint lookup fails under a healthy semantic pass (Story #5079)', async () => {
  const groups = [fakeGroup([FINDING_A])];
  const provider = {
    async findIssuesByFingerprint() {
      throw new Error('rate limit still exhausted after cooldown');
    },
  };
  const degraded = [];
  const { classifications, summary } = await classifyGroupsAgainstGitHub({
    groups,
    provider,
    searchCandidates: async () => [],
    onDegraded: (entry) => degraded.push(entry),
  });
  // A half-gathered pool must never be reported as a confident `create`.
  assert.equal(classifications[0].action, 'create');
  assert.equal(summary.dedupDegraded.count, 1);
  assert.equal(
    summary.dedupDegraded.groups[0].reason,
    'rate limit still exhausted after cooldown',
  );
  assert.equal(degraded.length, 1);
});

// ---------------------------------------------------------------------------
// Story #5143 — the adapter `loadProvider` builds now also carries the live
// provider's write ports, so `--wire-edges` can reach them. The dedup module
// still consumes only the two search ports, and the fixture seam is still the
// whole adapter rather than a provider to widen.
// ---------------------------------------------------------------------------

const { loadProvider, loadProviderOrNull } = __testing;

/** A fixture provider with a dedup port and no write ports (Story #4678). */
const SEARCH_ONLY_FIXTURE = path.resolve(
  import.meta.dirname,
  '../../.agents/scripts/lib/audit-to-stories/__tests__/fixtures/failing-subset-provider.js',
);

/** Run `fn` with the fixture-provider seam pointed at `fixturePath`. */
async function withFixtureProvider(fixturePath, fn) {
  const previous = process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE;
  process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE = fixturePath;
  try {
    return await fn();
  } finally {
    if (previous === undefined)
      delete process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE;
    else process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE = previous;
  }
}

test('the dedup path consumes only the adapter search ports, widened or not (AC-2, Story #5143)', async () => {
  const searched = [];
  const adapter = await loadProvider({
    resolveConfigImpl: () => ({ github: { owner: 'o', repo: 'r' } }),
    createProviderImpl: () => ({
      async searchIssues({ query }) {
        searched.push(query);
        return [{ number: 42, state: 'OPEN', body: footerFor(FINDING_A) }];
      },
      // The write ports the wire step needs — invisible to the dedup module.
      updateTicket: async () => {},
      getTicket: async () => ({}),
      getDependencyWriteContext: () => ({}),
    }),
  });
  assert.deepEqual(
    Object.keys(adapter).sort(),
    [
      'findIssuesByFingerprint',
      'getDependencyWriteContext',
      'getTicket',
      'listAuditIssues',
      'searchCandidates',
      'updateTicket',
    ],
    'the adapter carries both halves',
  );

  // Hand the classifier ONLY the two search ports: the dedup contract must not
  // have grown a dependency on anything the widening added.
  const { classifications } = await classifyGroupsAgainstGitHub({
    groups: [fakeGroup([FINDING_A])],
    provider: { findIssuesByFingerprint: adapter.findIssuesByFingerprint },
    searchCandidates: adapter.searchCandidates,
  });
  assert.equal(classifications[0].action, 'skip-open');
  assert.equal(classifications[0].matchedIssues[0].number, 42);
  assert.ok(
    searched.includes(shaOf(FINDING_A)),
    'the fingerprint port still queries the provider by sha',
  );
});

test('the fixture-provider path is still returned verbatim (AC-2, Story #5143)', async () => {
  // A bare absolute path is not a valid ESM specifier on Windows, where it
  // parses as protocol `d:` — the production `loadFixtureProvider` converts
  // with `pathToFileURL` for the same reason.
  const fixture = await import(pathToFileURL(SEARCH_ONLY_FIXTURE).href);
  const loaded = await withFixtureProvider(SEARCH_ONLY_FIXTURE, () =>
    loadProvider({
      resolveConfigImpl: () => {
        throw new Error('the fixture short-circuits before any config read');
      },
    }),
  );
  assert.equal(loaded, fixture.default, 'the fixture object itself, unwrapped');
  assert.equal(typeof loaded.updateTicket, 'undefined');
});

test('loadProviderOrNull keeps the dedup path soft-failing on a typed refusal (Story #5143)', async () => {
  // The scan degrades to a create-only plan and warns; it never aborts.
  assert.equal(
    await loadProviderOrNull({ resolveConfigImpl: () => ({ github: {} }) }),
    null,
  );
});

test('loadProvider refuses a provider with no searchIssues port, by reason (Story #5143)', async () => {
  // The adapter cannot be built without the dedup read port, and the refusal
  // must stay typed: `wireEdges` maps `reason` onto the precondition it names,
  // so an untyped throw here would surface as the generic hint again.
  await assert.rejects(
    loadProvider({
      resolveConfigImpl: () => ({ github: { owner: 'o', repo: 'r' } }),
      createProviderImpl: () => ({ updateTicket: async () => {} }),
    }),
    (err) => {
      assert.equal(err.name, 'ProviderUnavailableError');
      assert.equal(err.reason, 'no-search-port');
      assert.match(err.message, /searchIssues/);
      return true;
    },
  );
});

test('loadProvider reports a throwing config resolve as no-config (Story #5143)', async () => {
  // A malformed .agentrc.json fails the resolve rather than returning a config
  // with no owner/repo. Both spellings of "there is no usable config" have to
  // reach the operator as the same named precondition.
  await assert.rejects(
    loadProvider({
      resolveConfigImpl: () => {
        throw new Error('unexpected token in .agentrc.json');
      },
    }),
    (err) => {
      assert.equal(err.name, 'ProviderUnavailableError');
      assert.equal(err.reason, 'no-config');
      assert.match(err.message, /resolving the project config failed/);
      return true;
    },
  );
});

// --- Story #5281: the dedup corpus is fetched once, not once per finding -----

const SOURCE_REPORT = 'temp/audits/audit-security-results.md';

/** A finding shaped so `auditLabelsForFindings` resolves it to a real lens. */
function labelledFinding(index) {
  return {
    ...auditFinding('injection', `finding number ${index}`, `src/f${index}.js`),
    sourceReport: SOURCE_REPORT,
  };
}

test('AC-11: one list request per page, and a search only for findings with no exact hit', async () => {
  const findings = Array.from({ length: 100 }, (_, i) => labelledFinding(i));
  const groups = findings.map((f) => fakeGroup([f]));

  // 50 open audit Issues, 30 of which already carry a finding's fingerprint.
  const issues = findings.slice(0, 30).map((finding, i) => ({
    number: 1000 + i,
    state: 'open',
    body: footerFor(finding),
  }));
  for (let i = 30; i < 50; i += 1) {
    issues.push({ number: 1000 + i, state: 'open', body: 'no footer here' });
  }

  const listCalls = [];
  const searchCalls = [];
  const fingerprintCalls = [];

  const { classifications, summary } = await classifyGroupsAgainstGitHub({
    groups,
    provider: {
      async findIssuesByFingerprint(sha) {
        fingerprintCalls.push(sha);
        return [];
      },
    },
    searchCandidates: async (finding) => {
      searchCalls.push(finding);
      return [];
    },
    // One page of 100 covers 50 issues, so the port is called once.
    listAuditIssues: async (labels) => {
      listCalls.push(labels);
      return issues;
    },
  });

  assert.equal(listCalls.length, 1, 'the corpus is fetched once per run');
  assert.deepEqual(listCalls[0], ['audit::security']);
  assert.deepEqual(
    fingerprintCalls,
    [],
    'the exact lookup is answered locally, never over the network',
  );
  assert.equal(
    searchCalls.length,
    70,
    'a search is spent only on the findings with no exact fingerprint hit',
  );

  // And the classification itself is unchanged: the 30 known findings dedupe.
  assert.equal(summary.skipOpen, 30);
  assert.equal(summary.create, 70);
  assert.equal(classifications[0].action, 'skip-open');
  assert.equal(classifications[0].matchedIssues[0].number, 1000);
});

test('AC-11: a closed local fingerprint match still routes as a regression', async () => {
  const finding = labelledFinding(1);
  const { classifications } = await classifyGroupsAgainstGitHub({
    groups: [fakeGroup([finding])],
    provider: { findIssuesByFingerprint: async () => [] },
    listAuditIssues: async () => [
      { number: 7, state: 'closed', body: footerFor(finding) },
    ],
  });
  assert.equal(classifications[0].action, 'skip-reoccurring');
  assert.equal(classifications[0].matchedIssues[0].number, 7);
});

test('AC-11: a failed or absent list port falls back to the per-finding search', async () => {
  const finding = labelledFinding(2);
  const fingerprintCalls = [];
  const provider = {
    async findIssuesByFingerprint(sha) {
      fingerprintCalls.push(sha);
      return [{ number: 9, state: 'open', body: footerFor(finding) }];
    },
  };

  for (const listAuditIssues of [
    undefined,
    async () => {
      throw new Error('list endpoint exploded');
    },
  ]) {
    fingerprintCalls.length = 0;
    const { classifications } = await classifyGroupsAgainstGitHub({
      groups: [fakeGroup([finding])],
      provider,
      listAuditIssues,
    });
    // Dedup still runs — a degraded pre-fetch costs the saving, not the gate.
    assert.equal(classifications[0].action, 'skip-open');
    assert.equal(fingerprintCalls.length, 1);
  }
});

test('AC-11: the adapter lists once per label, dedupes by number, and normalises state', async () => {
  const listed = [];
  const adapter = await loadProvider({
    resolveConfigImpl: () => ({ github: { owner: 'o', repo: 'r' } }),
    createProviderImpl: () => ({
      async searchIssues() {
        return [];
      },
      async listIssuesByLabel({ state, labels }) {
        listed.push({ state, labels });
        // The same issue is returned under both labels — a cross-audit Story.
        return [
          { number: 11, state: 'OPEN', body: `by ${labels}`, title: 't' },
          {
            number: 12,
            state: 'CLOSED',
            state_reason: 'not_planned',
            body: '',
          },
        ];
      },
    }),
  });

  const issues = await adapter.listAuditIssues([
    'audit::security',
    'audit::quality',
  ]);
  assert.deepEqual(listed, [
    { state: 'all', labels: 'audit::security' },
    { state: 'all', labels: 'audit::quality' },
  ]);
  assert.deepEqual(
    issues.map((i) => [i.number, i.state]),
    [
      [11, 'open'],
      [12, 'closed'],
    ],
  );
  // First-seen wins, so the record is the one from the first label queried.
  assert.equal(issues[0].body, 'by audit::security');
});

test('AC-11: a provider with no list port yields null rather than a silent skip', async () => {
  const adapter = await loadProvider({
    resolveConfigImpl: () => ({ github: { owner: 'o', repo: 'r' } }),
    createProviderImpl: () => ({
      async searchIssues() {
        return [];
      },
    }),
  });
  assert.equal(await adapter.listAuditIssues(['audit::security']), null);
});
