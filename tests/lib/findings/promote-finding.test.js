/**
 * Unit tests for lib/findings/promote-finding.js.
 *
 * Every GitHub side-effect flows through an injected port; these tests pass
 * in-memory stubs so the whole suite runs with NO network. The `searchIssues`
 * stub models a fingerprint-keyed issue index (the contract `routeFinding`
 * expects); `createStory` / `createEpic` model the `/story-plan` and
 * `/epic-plan --idea` surfaces by handing back a fresh issue record.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFinding } from '../../../.agents/scripts/lib/findings/classify-finding.js';
import {
  __testing,
  clusterLedgerItems,
  isPromotable,
  PROMOTION_TARGETS,
  promoteFindings,
  targetForCluster,
} from '../../../.agents/scripts/lib/findings/promote-finding.js';
import {
  fingerprintFinding,
  fingerprintFooter,
} from '../../../.agents/scripts/lib/findings/route-finding.js';
import { SEVERITIES } from '../../../.agents/scripts/lib/findings/severity.js';

/** A captured-but-untriaged ledger item (rolling backlog). */
function untriagedItem(overrides = {}) {
  return {
    id: 'L1',
    class: 'product-bug',
    severity: 'high',
    evidence: 'Invoice total renders as NaN when line items are empty',
    coverage: 'invoices/list',
    missingTest: 'unit test for empty line-item total',
    ...overrides,
  };
}

/**
 * Build an in-memory issue store keyed by fingerprint footer — the contract
 * `routeFinding` consumes. `searchIssues` scans the whole store (open+closed)
 * and returns issues whose footer carries the queried sha. With an empty store
 * every route resolves to `new`.
 */
function makeIssueStore(issues = []) {
  const all = issues.map((i) => ({
    number: i.number,
    state: i.state,
    url: i.url ?? `https://github.com/o/r/issues/${i.number}`,
    body: `Body #${i.number}\n\n${fingerprintFooter(i.fingerprint)}`,
  }));
  return {
    all,
    searchIssues: async (sha) => {
      assert.match(
        sha,
        /^[0-9a-f]{40}$/,
        'searchIssues receives a 40-char sha',
      );
      return all.filter((i) => i.body.includes(sha));
    },
  };
}

/** A create port that hands back a monotonically-numbered issue record. */
function makeCreatePort(startAt, kindLabel) {
  let next = startAt;
  const calls = [];
  const port = async (cluster) => {
    calls.push(cluster);
    const number = next;
    next += 1;
    return {
      number,
      url: `https://github.com/o/r/issues/${number}`,
      _kind: kindLabel,
    };
  };
  return { port, calls };
}

test('isPromotable: untriaged backlog item is promotable', () => {
  assert.equal(isPromotable(untriagedItem({ disposition: null })), true);
  assert.equal(isPromotable(untriagedItem({ disposition: 'pending' })), true);
  assert.equal(isPromotable(untriagedItem({})), true);
});

test('isPromotable: file disposition without routedTo is promotable', () => {
  assert.equal(isPromotable(untriagedItem({ disposition: 'file' })), true);
});

test('isPromotable: defer / dismiss / already-routed items are skipped', () => {
  assert.equal(isPromotable(untriagedItem({ disposition: 'defer' })), false);
  assert.equal(isPromotable(untriagedItem({ disposition: 'dismiss' })), false);
  assert.equal(
    isPromotable(
      untriagedItem({
        disposition: 'file',
        routedTo: { issue: 9, url: 'u', kind: 'story' },
      }),
    ),
    false,
  );
});

test('isPromotable: non-object is not promotable', () => {
  assert.equal(isPromotable(null), false);
  assert.equal(isPromotable(undefined), false);
  assert.equal(isPromotable('L1'), false);
});

test('clusterLedgerItems: groups by class, keeping distinct classes apart', () => {
  const items = [
    untriagedItem({
      id: 'L1',
      coverage: 'invoices/list',
      class: 'product-bug',
    }),
    untriagedItem({
      id: 'L2',
      coverage: 'invoices/list',
      class: 'product-bug',
    }),
    untriagedItem({ id: 'L3', coverage: 'settings', class: 'tooling-dx' }),
  ];
  const clusters = clusterLedgerItems(items);
  assert.equal(clusters.length, 2);
  const bugCluster = clusters.find((c) => c.class === 'product-bug');
  assert.deepEqual(
    bugCluster.items.map((i) => i.id),
    ['L1', 'L2'],
  );
  // Both product-bug items share one coverage surface → tight (Story-sized).
  assert.equal(bugCluster.coverages.length, 1);
  assert.equal(targetForCluster(bugCluster), PROMOTION_TARGETS.STORY);
});

test('clusterLedgerItems: excludes deferred/dismissed/routed items', () => {
  const items = [
    untriagedItem({ id: 'L1' }),
    untriagedItem({ id: 'L2', disposition: 'defer' }),
    untriagedItem({ id: 'L3', disposition: 'dismiss' }),
    untriagedItem({
      id: 'L4',
      routedTo: { issue: 1, url: 'u', kind: 'story' },
    }),
  ];
  const clusters = clusterLedgerItems(items);
  const allIds = clusters.flatMap((c) => c.items.map((i) => i.id));
  assert.deepEqual(allIds, ['L1']);
});

test('clusterLedgerItems: highest severity wins within a cluster', () => {
  const items = [
    untriagedItem({ id: 'L1', severity: 'low' }),
    untriagedItem({ id: 'L2', severity: 'critical' }),
    untriagedItem({ id: 'L3', severity: 'medium' }),
  ];
  const [cluster] = clusterLedgerItems(items);
  assert.equal(cluster.severity, 'critical');
});

test('clusterLedgerItems: throws on non-array input', () => {
  assert.throws(() => clusterLedgerItems(null), TypeError);
});

test('targetForCluster: tight cluster (≤2 surfaces) routes to a Story', () => {
  assert.equal(targetForCluster({ coverages: ['a'] }), PROMOTION_TARGETS.STORY);
  assert.equal(
    targetForCluster({ coverages: ['a', 'b'] }),
    PROMOTION_TARGETS.STORY,
  );
});

test('targetForCluster: broad cluster (>2 surfaces) routes to an Epic', () => {
  assert.equal(
    targetForCluster({ coverages: ['a', 'b', 'c'] }),
    PROMOTION_TARGETS.EPIC,
  );
});

test('promoteFindings: new tight cluster opens a Story via /story-plan port', async () => {
  const items = [untriagedItem({ id: 'L1' }), untriagedItem({ id: 'L2' })];
  const { searchIssues } = makeIssueStore([]); // empty → every route is `new`
  const story = makeCreatePort(101, 'story');
  const epic = makeCreatePort(201, 'epic');

  const result = await promoteFindings(items, {
    searchIssues,
    createStory: story.port,
    createEpic: epic.port,
  });

  assert.equal(result.promotions.length, 1);
  const [promotion] = result.promotions;
  assert.equal(promotion.target, PROMOTION_TARGETS.STORY);
  assert.equal(promotion.decision, 'new');
  assert.equal(promotion.created, true);
  assert.equal(promotion.issue, 101);
  // Story port was used; epic port untouched.
  assert.equal(story.calls.length, 1);
  assert.equal(epic.calls.length, 0);
});

test('promoteFindings: broad cluster opens an Epic via /epic-plan --idea port', async () => {
  const items = [
    untriagedItem({ id: 'L1', coverage: 'a' }),
    untriagedItem({ id: 'L2', coverage: 'b' }),
    untriagedItem({ id: 'L3', coverage: 'c' }),
  ];
  const { searchIssues } = makeIssueStore([]);
  const story = makeCreatePort(101, 'story');
  const epic = makeCreatePort(201, 'epic');

  const result = await promoteFindings(items, {
    searchIssues,
    createStory: story.port,
    createEpic: epic.port,
  });

  assert.equal(result.promotions.length, 1);
  assert.equal(result.promotions[0].target, PROMOTION_TARGETS.EPIC);
  assert.equal(result.promotions[0].issue, 201);
  assert.equal(epic.calls.length, 1);
  assert.equal(story.calls.length, 0);
});

test('promoteFindings: writes routedTo back onto every contributing item (AC #2)', async () => {
  const items = [untriagedItem({ id: 'L1' }), untriagedItem({ id: 'L2' })];
  const { searchIssues } = makeIssueStore([]);
  const story = makeCreatePort(101, 'story');
  const epic = makeCreatePort(201, 'epic');

  await promoteFindings(items, {
    searchIssues,
    createStory: story.port,
    createEpic: epic.port,
  });

  for (const item of items) {
    assert.ok(item.routedTo, `item ${item.id} has a routedTo link`);
    assert.equal(item.routedTo.issue, 101);
    assert.equal(item.routedTo.kind, 'story');
    assert.match(item.routedTo.url, /issues\/101$/);
  }
});

test('promoteFindings: dedups against an existing open Issue — no new ticket (AC #1)', async () => {
  const items = [untriagedItem({ id: 'L1' })];
  // Compute the fingerprint the single-item cluster will route on.
  const [cluster] = clusterLedgerItems(items);
  const finding = __testing.clusterToFinding(cluster);
  const { full: sha } = __testing.fingerprintFinding(finding);

  const { searchIssues } = makeIssueStore([
    { number: 42, state: 'open', fingerprint: sha },
  ]);
  const story = makeCreatePort(101, 'story');
  const epic = makeCreatePort(201, 'epic');

  const result = await promoteFindings(items, {
    searchIssues,
    createStory: story.port,
    createEpic: epic.port,
  });

  const [promotion] = result.promotions;
  assert.equal(promotion.decision, 'update-existing');
  assert.equal(promotion.created, false);
  assert.equal(promotion.issue, 42);
  assert.equal(promotion.routedTo.kind, 'issue');
  // No new ticket created on either port.
  assert.equal(story.calls.length, 0);
  assert.equal(epic.calls.length, 0);
  // Item still gets the link back to the matched issue.
  assert.equal(items[0].routedTo.issue, 42);
});

test('promoteFindings: routes a closed-fingerprint match as regression-of-closed', async () => {
  const items = [untriagedItem({ id: 'L1' })];
  const [cluster] = clusterLedgerItems(items);
  const { full: sha } = __testing.fingerprintFinding(
    __testing.clusterToFinding(cluster),
  );
  const { searchIssues } = makeIssueStore([
    { number: 7, state: 'closed', fingerprint: sha },
  ]);
  const story = makeCreatePort(101, 'story');

  const result = await promoteFindings(items, {
    searchIssues,
    createStory: story.port,
    createEpic: makeCreatePort(201, 'epic').port,
  });

  assert.equal(result.promotions[0].decision, 'regression-of-closed');
  assert.equal(result.promotions[0].created, false);
  assert.equal(story.calls.length, 0);
});

test('promoteFindings: requires a search port', async () => {
  await assert.rejects(
    () => promoteFindings([untriagedItem()], { createStory: async () => ({}) }),
    /searchCandidates or searchIssues port is required/,
  );
});

test('promoteFindings: requires the matching create port for a new cluster', async () => {
  const items = [untriagedItem({ id: 'L1' })];
  const { searchIssues } = makeIssueStore([]);
  await assert.rejects(
    () => promoteFindings(items, { searchIssues }), // no createStory
    /createStory port is required/,
  );
});

test('promoteFindings: no promotable items → empty promotions', async () => {
  const items = [
    untriagedItem({ id: 'L1', disposition: 'defer' }),
    untriagedItem({ id: 'L2', disposition: 'dismiss' }),
  ];
  const { searchIssues } = makeIssueStore([]);
  const result = await promoteFindings(items, {
    searchIssues,
    createStory: async () => ({ number: 1 }),
    createEpic: async () => ({ number: 2 }),
  });
  assert.equal(result.promotions.length, 0);
});

test('promoteFindings: runs offline through injected ports (AC #3)', async () => {
  // No fetch/http stubs are installed; the absence of any real network call is
  // proven by the suite completing with only in-memory ports wired in.
  const items = [untriagedItem({ id: 'L1' })];
  const { searchIssues } = makeIssueStore([]);
  let networkTouched = false;
  const result = await promoteFindings(items, {
    searchIssues: async (sha) => {
      // a real impl would hit GitHub here; the stub does not.
      return searchIssues(sha);
    },
    createStory: async (cluster) => {
      assert.ok(cluster.title, 'cluster carries a title for /story-plan');
      return { number: 500, url: 'https://github.com/o/r/issues/500' };
    },
    createEpic: async () => {
      networkTouched = true;
      return { number: 600 };
    },
  });
  assert.equal(networkTouched, false);
  assert.equal(result.promotions[0].issue, 500);
});

test('AC #3: classify and promote agree on the severity fed to fingerprintFinding → stable SHA', () => {
  // The same finding, routed through `classify-finding` and through
  // `promote-finding`, MUST produce the identical severity string, so the
  // `fingerprintFinding` identity (which includes `severity`) is path-stable.
  // Cover every canonical level plus unrecognised/absent inputs.
  const inputs = [...SEVERITIES, 'BoGuS', undefined];
  for (const severity of inputs) {
    const label = String(severity);
    const item = untriagedItem({ id: 'L1', class: 'product-bug', severity });

    // classify path
    const classifySeverity = classifyFinding({
      class: item.class,
      severity,
    }).severity;

    // promote path — the cluster severity is what clusterToFinding feeds to
    // fingerprintFinding.
    const [cluster] = clusterLedgerItems([item]);
    const promoteSeverity = __testing.clusterToFinding(cluster).severity;

    assert.equal(
      classifySeverity,
      promoteSeverity,
      `severity agrees across paths for input "${label}"`,
    );

    const base = { title: 't', area: 'a', primaryFile: 'f', labels: ['x'] };
    const shaFromClassify = fingerprintFinding({
      ...base,
      severity: classifySeverity,
    }).full;
    const shaFromPromote = fingerprintFinding({
      ...base,
      severity: promoteSeverity,
    }).full;
    assert.equal(
      shaFromClassify,
      shaFromPromote,
      `fingerprint is stable across paths for input "${label}"`,
    );
  }
});

test('AC #4: a routed issue with no url throws rather than stamping an empty routedTo.url', async () => {
  const items = [untriagedItem({ id: 'L1' })];
  const { searchIssues } = makeIssueStore([]); // empty → route is `new`
  await assert.rejects(
    () =>
      promoteFindings(items, {
        searchIssues,
        createStory: async () => ({ number: 77 }), // no url — violates contract
        createEpic: async () => ({ number: 88 }),
      }),
    /missing a url/,
  );
  // The item must NOT have been stamped with a schema-invalid routedTo.
  assert.equal(items[0].routedTo, undefined);
});

test('AC #4: a matched issue with a blank url throws rather than stamping it', async () => {
  const items = [untriagedItem({ id: 'L1' })];
  const [cluster] = clusterLedgerItems(items);
  const { full: sha } = __testing.fingerprintFinding(
    __testing.clusterToFinding(cluster),
  );
  // An open match whose url is blank must be rejected, not persisted empty.
  const { searchIssues } = makeIssueStore([
    { number: 42, state: 'open', fingerprint: sha, url: '   ' },
  ]);
  await assert.rejects(
    () =>
      promoteFindings(items, {
        searchIssues,
        createStory: makeCreatePort(101, 'story').port,
        createEpic: makeCreatePort(201, 'epic').port,
      }),
    /missing a url/,
  );
});
