/**
 * wire-dependencies.test.js — Story #5044
 *
 * Standalone audit Stories used to hardcode `depends_on: []` and express their
 * ordering as a prose `## Sequencing` block nothing could act on. What actually
 * kept a cohort off colliding branches was an accident — siblings shared the
 * sweep-wide audit provenance footers, and the delivery footprint guard scraped
 * path-shaped tokens out of them. Narrowing that scrape removes the accident,
 * so these tests pin the real serializer that replaces it: `blocked by #N` body
 * footers plus native `blocked_by` relations, both wired post-create.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { __testing } from '../../.agents/scripts/audit-to-stories.js';
import { wireAuditStoryEdges } from '../../.agents/scripts/lib/audit-to-stories/wire-dependencies.js';
import { parse as parseStoryBody } from '../../.agents/scripts/lib/story-body/story-body.js';

const { loadProvider, wireEdges } = __testing;

/** A fixture provider with dedup ports and no `updateTicket` (Story #4678). */
const SEARCH_ONLY_FIXTURE = path.resolve(
  import.meta.dirname,
  '../../.agents/scripts/lib/audit-to-stories/__tests__/fixtures/failing-subset-provider.js',
);

/** A minimal grouped-findings entry, shaped like `groupFindings` output. */
function group(groupKey, { file = `lib/${groupKey}.js` } = {}) {
  return {
    groupKey,
    title: `Remediate ${groupKey}`,
    files: [file],
    findings: [
      {
        title: `${groupKey} finding`,
        severity: 'medium',
        dimension: 'clean-code',
        recommendation: 'Do the thing.',
        agentPrompt: 'Do the thing.',
        sourceReport: 'temp/audits/audit-clean-code-results.md',
        files: [file],
        normalisedTitle: `${groupKey} finding`,
        fingerprint: { full: 'a'.repeat(40), short: 'aaaaaaaaaaaa' },
      },
    ],
  };
}

/**
 * A provider recording every body PATCH and every native dependency write.
 * `getDependencyWriteContext` / `getTicket` are the two ports
 * `applyBlockedByDependencies` needs; omitting them exercises the
 * footer-only degrade.
 */
function fakeProvider({ native = true } = {}) {
  const bodies = new Map();
  const nativeEdges = [];
  const provider = {
    updateTicket: (issueNumber, mutations) => {
      bodies.set(issueNumber, mutations.body);
      return Promise.resolve();
    },
  };
  if (native) {
    provider.getTicket = (issueNumber) =>
      Promise.resolve({ internalId: 900000 + issueNumber });
    provider.getDependencyWriteContext = () => ({
      owner: 'o',
      repo: 'r',
      gh: {
        api: ({ method, endpoint, body }) => {
          if (method === 'GET') return Promise.resolve([]);
          nativeEdges.push({ endpoint, body });
          return Promise.resolve({});
        },
      },
    });
  }
  return { provider, bodies, nativeEdges };
}

const wire = ({ groups, edges, issueByGroupKey, provider, bodies }) =>
  wireAuditStoryEdges({
    groups,
    edges,
    issueByGroupKey,
    provider,
    updateBody: (issueNumber, body) => {
      bodies.set(issueNumber, body);
      return Promise.resolve();
    },
  });

describe('wireAuditStoryEdges — declared ordering for a standalone audit cohort', () => {
  it('writes a blocked by #N footer AND a native blocked_by relation (AC-6)', async () => {
    const { provider, bodies, nativeEdges } = fakeProvider();
    const groups = [group('a'), group('b')];
    const summary = await wire({
      groups,
      edges: [{ fromGroupKey: 'b', toGroupKey: 'a' }],
      issueByGroupKey: { a: 101, b: 102 },
      provider,
      bodies,
    });

    // Half one: the canonical body footer, which is what /mandrel-deliver's resolver
    // parses and the fallback when the dependencies API says no.
    assert.deepEqual(
      [...bodies.keys()],
      [102],
      'only the dependent is rewritten',
    );
    assert.deepEqual(parseStoryBody(bodies.get(102)).body.depends_on, ['#101']);
    assert.ok(bodies.get(102).includes('blocked by #101'));

    // Half two: the native relation, visible in the GitHub UI and readable
    // without parsing markdown.
    assert.equal(nativeEdges.length, 1);
    assert.match(
      nativeEdges[0].endpoint,
      /\/issues\/102\/dependencies\/blocked_by/,
    );
    assert.deepEqual(nativeEdges[0].body, { issue_id: 900101 });

    assert.deepEqual(summary, {
      storiesWired: 1,
      bodiesUpdated: 1,
      edgesDeclared: 1,
      native: { edgesAdded: 1, edgesSkipped: 0, edgesFailed: 0 },
    });
  });

  it('leaves an edge-free cohort completely alone', async () => {
    // An issue-body PATCH is a mutation and a notification. Rewriting every
    // Story of every sweep to an identical body would be noise.
    const { provider, bodies, nativeEdges } = fakeProvider();
    const summary = await wire({
      groups: [group('a'), group('b')],
      edges: [],
      issueByGroupKey: { a: 101, b: 102 },
      provider,
      bodies,
    });
    assert.equal(bodies.size, 0);
    assert.equal(nativeEdges.length, 0);
    assert.deepEqual(summary, {
      storiesWired: 0,
      bodiesUpdated: 0,
      edgesDeclared: 0,
      native: null,
    });
  });

  it('drops an edge whose target was never opened rather than guessing', async () => {
    const { provider, bodies } = fakeProvider();
    const summary = await wire({
      groups: [group('b')],
      edges: [{ fromGroupKey: 'b', toGroupKey: 'deduped-away' }],
      issueByGroupKey: { b: 102 },
      provider,
      bodies,
    });
    assert.equal(
      bodies.size,
      0,
      'no body claims a blocker that does not exist',
    );
    assert.equal(summary.edgesDeclared, 0);
  });

  it('keeps the footer when native mirroring is unavailable (non-fatal)', async () => {
    // Ordering must survive a provider with no dependencies API: the footer is
    // already written by the time mirroring runs, so a refusal costs
    // visibility, not ordering.
    const { provider, bodies } = fakeProvider({ native: false });
    const summary = await wire({
      groups: [group('a'), group('b')],
      edges: [{ fromGroupKey: 'b', toGroupKey: 'a' }],
      issueByGroupKey: { a: 101, b: 102 },
      provider,
      bodies,
    });
    assert.deepEqual(parseStoryBody(bodies.get(102)).body.depends_on, ['#101']);
    assert.equal(summary.native, null);
    assert.equal(summary.edgesDeclared, 1);
  });

  it('wires a chain, each Story naming only its own blocker', async () => {
    const { provider, bodies } = fakeProvider();
    await wire({
      groups: [group('a'), group('b'), group('c')],
      edges: [
        { fromGroupKey: 'b', toGroupKey: 'a' },
        { fromGroupKey: 'c', toGroupKey: 'b' },
      ],
      issueByGroupKey: { a: 101, b: 102, c: 103 },
      provider,
      bodies,
    });
    assert.deepEqual(parseStoryBody(bodies.get(102)).body.depends_on, ['#101']);
    assert.deepEqual(parseStoryBody(bodies.get(103)).body.depends_on, ['#102']);
    assert.equal(bodies.has(101), false, 'the root has no blocker');
  });
});

/**
 * A provider shaped like the live `GitHubProvider`: every port is a prototype
 * method reaching through `this`, so a port carried across the adapter
 * unbound throws on first call rather than quietly writing nothing. That is
 * exactly what `loadProvider`'s narrowing hid until Story #5143.
 */
class StubLiveProvider {
  constructor() {
    this.patched = [];
    this.nativeEdges = [];
  }

  async searchIssues() {
    return [];
  }

  async updateTicket(issueNumber, mutations) {
    this.patched.push({ issueNumber, body: mutations.body });
  }

  async getTicket(issueNumber) {
    return { internalId: 900000 + issueNumber };
  }

  getDependencyWriteContext() {
    return {
      owner: 'o',
      repo: 'r',
      gh: {
        api: ({ method, endpoint, body }) => {
          if (method === 'GET') return Promise.resolve([]);
          this.nativeEdges.push({ endpoint, body });
          return Promise.resolve({});
        },
      },
    };
  }
}

/** Drive the real adapter off `stub` through `loadProvider`'s seams. */
const liveAdapter = (stub) => () =>
  loadProvider({
    createProviderImpl: () => stub,
    resolveConfigImpl: () => ({ github: { owner: 'o', repo: 'r' } }),
  });

const PLAN = {
  edges: [{ fromGroupKey: 'b', toGroupKey: 'a' }],
  classifications: [
    { action: 'create', group: group('a') },
    { action: 'create', group: group('b') },
  ],
};

describe('wireEdges — the live provider reaches the wire step (Story #5143)', () => {
  // Story #5305 — the pass also records the ledger. Injected in every case
  // here: the real implementation would write the repo's committed
  // `baselines/audit-ledger.json` from a unit test, which the read-only
  // invariant over `baselines/` (rightly) fails on.
  const recordFiledIssuesImpl = () => ({
    path: 'baselines/audit-ledger.json',
    written: true,
    filed: 0,
  });

  it('carries updateTicket/getTicket/getDependencyWriteContext through the dedup adapter (AC-1)', async () => {
    // Pre-change, `loadProvider` returned an adapter narrowed to the two dedup
    // search ports, so this threw "--wire-edges needs a provider exposing
    // updateTicket" against a correctly configured, correctly authed repo.
    const stub = new StubLiveProvider();
    const summary = await wireEdges(
      { plan: PLAN, issueByGroupKey: { a: 101, b: 102 } },
      { loadProviderImpl: liveAdapter(stub), recordFiledIssuesImpl },
    );

    assert.deepEqual(
      stub.patched.map((p) => p.issueNumber),
      [102],
      'updateTicket runs once per dependent Story, on the provider itself',
    );
    assert.ok(stub.patched[0].body.includes('blocked by #101'));
    assert.deepEqual(parseStoryBody(stub.patched[0].body).body.depends_on, [
      '#101',
    ]);
    assert.equal(summary.bodiesUpdated, 1);
    // The native half proves getTicket + getDependencyWriteContext survived
    // the crossing bound — an unbound method would throw on `this`.
    assert.deepEqual(summary.native, {
      edgesAdded: 1,
      edgesSkipped: 0,
      edgesFailed: 0,
    });
    assert.deepEqual(stub.nativeEdges[0].body, { issue_id: 900101 });
  });

  it('names the missing configuration rather than guessing at it (AC-3)', async () => {
    await assert.rejects(
      () =>
        wireEdges(
          { plan: PLAN, issueByGroupKey: { a: 101, b: 102 } },
          {
            recordFiledIssuesImpl,
            loadProviderImpl: () =>
              loadProvider({ resolveConfigImpl: () => ({ github: {} }) }),
          },
        ),
      (err) => {
        assert.match(
          err.message,
          /github\.owner and github\.repo are not both set/,
        );
        assert.doesNotMatch(err.message, /wire the edges by hand/);
        return true;
      },
    );
  });

  it('names a failed provider construction as auth, not configuration (AC-3)', async () => {
    await assert.rejects(
      () =>
        wireEdges(
          { plan: PLAN, issueByGroupKey: { a: 101, b: 102 } },
          {
            recordFiledIssuesImpl,
            loadProviderImpl: () =>
              loadProvider({
                resolveConfigImpl: () => ({
                  github: { owner: 'o', repo: 'r' },
                }),
                createProviderImpl: () => {
                  throw new Error('gh auth token missing');
                },
              }),
          },
        ),
      (err) => {
        assert.match(err.message, /check GH_TOKEN \/ gh auth/);
        assert.match(err.message, /gh auth token missing/);
        assert.doesNotMatch(err.message, /wire the edges by hand/);
        return true;
      },
    );
  });

  it('names the fixture seam when a fixture provider has no updateTicket (AC-3)', async () => {
    const previous = process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE;
    process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE = SEARCH_ONLY_FIXTURE;
    try {
      await assert.rejects(
        () =>
          wireEdges(
            { plan: PLAN, issueByGroupKey: { a: 101, b: 102 } },
            { recordFiledIssuesImpl },
          ),
        (err) => {
          assert.match(
            err.message,
            /AUDIT_TO_STORIES_PROVIDER_FIXTURE names a fixture provider with no updateTicket port/,
          );
          assert.doesNotMatch(err.message, /wire the edges by hand/);
          return true;
        },
      );
    } finally {
      if (previous === undefined)
        delete process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE;
      else process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE = previous;
    }
  });
});
