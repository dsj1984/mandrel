/**
 * Provider-less dedup: `classifyGroupsAgainstGitHub` answers from a corpus the
 * caller already holds (Story #5301).
 *
 * The architecture was already right — with an index in play `portsFor` returns
 * a local `searchIssues` on both branches, so `provider.findIssuesByFingerprint`
 * is never invoked. Two things stood between that and a run on a host with no
 * `gh` CLI: a hard-throw guard demanding the port that is never called, and the
 * `useProvider` gate in `buildPlan` that short-circuited the whole classify call
 * before the module ever saw it. These tests pin both, plus the honesty
 * invariants that keep a provider-less run from reading as "checked, found
 * nothing" when it checked nothing at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing as auditCli } from '../../../audit-to-stories.js';
import { classifyGroupsAgainstGitHub } from '../dedupe-against-github.js';
import {
  renderFingerprintFooter,
  renderSemanticKeyFooter,
  withFingerprints,
} from '../finding-adapter.js';

const { buildPlan, dedupIndexWarning, dedupIndexDegradedWarning } = auditCli;

function auditFinding(dimension, normalisedTitle, file) {
  return {
    dimension,
    normalisedTitle,
    files: file ? [file] : [],
    // The `audit::*` labels the pre-fetch lists over are derived from the
    // source report, not the dimension — an unlabelled finding resolves to no
    // lens and short-circuits the pre-fetch before the port is ever called.
    sourceReport: 'temp/audits/audit-security-results.md',
  };
}
function fakeGroup(findings) {
  const stamped = withFingerprints(findings);
  return { groupKey: `g-${stamped[0]?.fingerprint?.short}`, findings: stamped };
}
function footerFor(finding) {
  return renderFingerprintFooter(withFingerprints([finding]));
}

const FINDING = auditFinding('injection', 'sqli in login', 'src/a.js');

/** A provider whose every read port throws — proof it was never consulted. */
function explodingProvider() {
  return {
    findIssuesByFingerprint() {
      throw new Error('provider.findIssuesByFingerprint must not be called');
    },
    listIssuesByLabel() {
      throw new Error('provider.listIssuesByLabel must not be called');
    },
  };
}

describe('an injected issue corpus dedups without a provider', () => {
  it('classifies skip-open off the corpus with no provider at all', async () => {
    const { classifications, summary } = await classifyGroupsAgainstGitHub({
      groups: [fakeGroup([FINDING])],
      issues: [
        { number: 4182, state: 'open', body: `body\n${footerFor(FINDING)}\n` },
      ],
    });

    assert.equal(classifications[0].action, 'skip-open');
    assert.equal(classifications[0].matchedIssues[0].number, 4182);
    assert.equal(summary.skipOpen, 1);
    assert.deepEqual(summary.dedupIndex, { source: 'injected', size: 1 });
  });

  it('classifies skip-reoccurring when the corpus holds only a closed match', async () => {
    const { classifications, summary } = await classifyGroupsAgainstGitHub({
      groups: [fakeGroup([FINDING])],
      issues: [{ number: 4076, state: 'closed', body: footerFor(FINDING) }],
    });

    assert.equal(classifications[0].action, 'skip-reoccurring');
    assert.equal(summary.skipReoccurring, 1);
  });

  it('never consults the provider when a corpus is supplied, and agrees with the provider-less run', async () => {
    const groups = () => [fakeGroup([FINDING])];
    const issues = [
      { number: 4182, state: 'open', body: `body\n${footerFor(FINDING)}\n` },
    ];

    const withProvider = await classifyGroupsAgainstGitHub({
      groups: groups(),
      provider: explodingProvider(),
      listAuditIssues: () => {
        throw new Error('listAuditIssues must not be called');
      },
      issues,
    });
    const without = await classifyGroupsAgainstGitHub({
      groups: groups(),
      issues,
    });

    assert.equal(withProvider.classifications[0].action, 'skip-open');
    assert.equal(withProvider.summary.dedupDegraded.count, 0);
    assert.deepEqual(
      withProvider.classifications.map((c) => c.action),
      without.classifications.map((c) => c.action),
    );
  });

  it('still requires the provider port on the un-indexed path, where it is genuinely used', async () => {
    await assert.rejects(
      () => classifyGroupsAgainstGitHub({ groups: [fakeGroup([FINDING])] }),
      /findIssuesByFingerprint is required when no `issues` corpus is supplied/,
    );
  });

  it('confirms a reworded finding by semantic key with no semantic search port wired', async () => {
    // Same dimension and file, different wording: the fingerprint drifts, the
    // location-based semantic key does not. The index already holds that map,
    // so confirmation must not depend on a network-backed semantic port.
    const filed = auditFinding('injection', 'sqli in login', 'src/a.js');
    const reworded = auditFinding(
      'injection',
      'unparameterised query in the login handler',
      'src/a.js',
    );
    assert.notEqual(
      withFingerprints([filed])[0].fingerprint.full,
      withFingerprints([reworded])[0].fingerprint.full,
    );

    const { classifications } = await classifyGroupsAgainstGitHub({
      groups: [fakeGroup([reworded])],
      issues: [
        {
          number: 4190,
          state: 'open',
          body: `${footerFor(filed)}\n${renderSemanticKeyFooter(withFingerprints([filed]))}`,
        },
      ],
    });

    assert.equal(classifications[0].action, 'skip-open');
    assert.equal(classifications[0].matchedIssues[0].number, 4190);
  });
});

describe('an empty corpus is a first sweep, not an absent index', () => {
  it('runs dedup, reports the injected source at size 0, and classifies create', async () => {
    const { classifications, summary } = await classifyGroupsAgainstGitHub({
      groups: [fakeGroup([FINDING])],
      issues: [],
    });

    assert.equal(classifications[0].action, 'create');
    assert.equal(summary.create, 1);
    assert.deepEqual(summary.dedupIndex, { source: 'injected', size: 0 });
    // The distinguishing fact: no group degraded. An absent index would have
    // sent every group down the per-finding search path instead.
    assert.equal(summary.dedupDegraded.count, 0);
  });

  it('warns in text distinct from the skipped and degraded warnings', () => {
    const empty = dedupIndexWarning({ source: 'injected', size: 0 });
    assert.match(empty, /0 issues supplied via --issues-file/);
    assert.match(empty, /fetch that\s+returned nothing|broken/i);
    assert.doesNotMatch(empty, /dedup skipped/i);
    assert.doesNotMatch(empty, /dedup degraded/i);

    const populated = dedupIndexWarning({ source: 'injected', size: 12 });
    assert.match(populated, /12 issue\(s\)/);
  });
});

describe('a failed index pre-fetch is surfaced, not swallowed', () => {
  it('records the reason on the dedup-degraded report and fires the sink', async () => {
    const degraded = [];
    const { summary } = await classifyGroupsAgainstGitHub({
      groups: [fakeGroup([FINDING])],
      provider: {
        findIssuesByFingerprint: async () => [],
      },
      listAuditIssues: async () => {
        throw new Error('gh-exec: gh CLI is not installed or not on PATH');
      },
      onDegraded: (entry) => degraded.push(entry),
    });

    assert.match(
      summary.dedupDegraded.indexPrefetch,
      /issue-index pre-fetch failed/,
    );
    assert.match(
      summary.dedupDegraded.indexPrefetch,
      /gh CLI is not installed/,
    );
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0].group, null);
    // The pre-fetch is not a group, so it must not inflate the group count the
    // operator reads as "groups classified without a check".
    assert.equal(summary.dedupDegraded.count, 0);
    assert.deepEqual(summary.dedupIndex, { source: 'none', size: 0 });
  });

  it('names the fallback and its consequence in the warning', () => {
    const msg = dedupIndexDegradedWarning(
      'issue-index pre-fetch failed: spawn gh ENOENT',
    );
    assert.match(msg, /dedup index unavailable/i);
    assert.match(msg, /spawn gh ENOENT/);
    assert.match(msg, /per-finding\s+search/i);
  });
});

describe('buildPlan runs dedup off a corpus even under --no-provider', () => {
  const reportPath = 'temp/audits/audit-fake-results.md';

  /** Drive buildPlan with stub seams; returns `{ plan, warnings }`. */
  async function runBuildPlan({ useProvider, issues, classifySpy }) {
    const warnings = [];
    const plan = await buildPlan(
      { useProvider, issuesFile: issues ? 'issues.json' : undefined },
      {
        collectReportPathsImpl: async () => [reportPath],
        readReportsImpl: () => [{ sourceReport: reportPath, markdown: '' }],
        loadProviderImpl: async () => null,
        loadIssuesFileImpl: () => issues,
        classifyGroupsImpl: classifySpy,
        logger: { warn: (m) => warnings.push(m) },
      },
    );
    return { plan, warnings };
  }

  it('classifies through the dedupe module and suppresses the --no-provider warning', async () => {
    let received = null;
    const { plan, warnings } = await runBuildPlan({
      useProvider: false,
      issues: [{ number: 7, state: 'open', body: 'x' }],
      classifySpy: async (args) => {
        received = args;
        return {
          classifications: [],
          summary: {
            create: 0,
            skipOpen: 0,
            skipReoccurring: 0,
            dedupDegraded: { count: 0, groups: [] },
            dedupIndex: { source: 'injected', size: 1 },
          },
        };
      },
    });

    assert.ok(received, 'the dedupe module was invoked under --no-provider');
    assert.equal(received.provider, null);
    assert.deepEqual(received.issues, [
      { number: 7, state: 'open', body: 'x' },
    ]);
    assert.equal(plan.summary.dedupApplied, true);
    assert.ok(
      !warnings.some((w) => /dedup skipped \(--no-provider\)/i.test(w)),
      'a run that deduped must not claim dedup was skipped',
    );
    assert.ok(warnings.some((w) => /dedup index: 1 issue/.test(w)));
  });

  it('surfaces a failed index pre-fetch on stderr, naming the underlying failure', async () => {
    const { warnings } = await runBuildPlan({
      useProvider: false,
      issues: [],
      classifySpy: async () => ({
        classifications: [],
        summary: {
          create: 0,
          skipOpen: 0,
          skipReoccurring: 0,
          dedupDegraded: {
            count: 0,
            groups: [],
            indexPrefetch:
              'issue-index pre-fetch failed: dedup lookup failed: spawn gh ENOENT',
          },
          dedupIndex: { source: 'none', size: 0 },
        },
      }),
    });

    const degraded = warnings.find((w) => /dedup index unavailable/i.test(w));
    assert.ok(degraded, 'the pre-fetch failure reached the operator');
    assert.match(degraded, /spawn gh ENOENT/);
  });

  it('still warns dedup was skipped when --no-provider carries no corpus', async () => {
    let called = false;
    const { plan, warnings } = await runBuildPlan({
      useProvider: false,
      issues: null,
      classifySpy: async () => {
        called = true;
        return { classifications: [], summary: {} };
      },
    });

    assert.equal(called, false);
    assert.equal(plan.summary.dedupApplied, false);
    assert.ok(warnings.some((w) => /dedup skipped \(--no-provider\)/i.test(w)));
  });
});
