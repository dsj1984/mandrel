/**
 * Unit tests for the post-create ledger record (Story #5305).
 *
 * The defect these close: nothing in the package ever wrote `status: "filed"`,
 * so the ledger's suppression branch was unreachable in production and only the
 * GitHub-search dedup stopped a sweep re-filing what it had already filed.
 *
 * The load-bearing guarantees:
 *   - a supplied `groupKey → issueNumber` map produces `filed` entries carrying
 *     the right Issue numbers;
 *   - a second pass over the same findings yields `known`, proposing nothing;
 *   - entries the map does not mention are left untouched;
 *   - a `filed` entry whose Issue is later CLOSED still loses to the
 *     closed-Issue branch (`accepted-risk` / `regressed`);
 *   - the record runs before the provider is loaded, so a provider-less host
 *     still records what it filed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing } from '../../../audit-to-stories.js';
import { reconcileLedger } from '../../findings/audit-ledger.js';
import {
  fingerprintAuditFinding,
  toCanonicalFinding,
} from '../finding-adapter.js';
import { recordFiledIssues } from '../ledger-record.js';

const { wireEdges } = __testing;

/** A raw audit finding of the shape parse-audit-md emits. */
function auditFinding(dimension, title, file) {
  return {
    dimension,
    title,
    normalisedTitle: title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim(),
    files: file ? [file] : [],
  };
}

function group(groupKey, findings) {
  return { groupKey, findings };
}

/** An in-memory ledger store standing in for the two fs helpers. */
function ledgerStore(initial = null) {
  const state = { ledger: initial, writes: 0 };
  return {
    state,
    seams: {
      readLedgerImpl: () =>
        state.ledger ?? { $schema: 'x', generatedAt: '', entries: [] },
      writeLedgerImpl: (_path, next) => {
        state.ledger = next;
        state.writes += 1;
      },
    },
  };
}

const FINDING_A = auditFinding('architecture', 'Owned seam leaks', 'lib/a.js');
const FINDING_B = auditFinding(
  'clean-code',
  'Dead branch survives',
  'lib/b.js',
);

test('an id map records each mapped group as filed with its issue number', () => {
  const store = ledgerStore();
  const result = recordFiledIssues(
    {
      groups: [group('g-a', [FINDING_A]), group('g-b', [FINDING_B])],
      issueByGroupKey: { 'g-a': 2588, 'g-b': 2589 },
    },
    store.seams,
  );

  assert.equal(result.groupsRecorded, 2);
  assert.equal(result.filed, 2);
  assert.equal(store.state.writes, 1);

  const byFp = new Map(
    store.state.ledger.entries.map((e) => [e.fingerprint, e]),
  );
  const a = byFp.get(fingerprintAuditFinding(FINDING_A).full);
  assert.equal(a.status, 'filed');
  assert.equal(a.issue.number, 2588);
  assert.equal(a.issue.state, 'open');
  assert.equal(
    byFp.get(fingerprintAuditFinding(FINDING_B).full).issue.number,
    2589,
  );
});

test('a group the map does not mention contributes nothing and keeps its prior entry', () => {
  const prior = recordFiledIssues(
    {
      groups: [group('g-a', [FINDING_A])],
      issueByGroupKey: { 'g-a': 2588 },
    },
    ledgerStore().seams,
  );
  assert.equal(prior.filed, 1);

  // Seed a ledger holding A, then record a run that maps only B.
  const seeded = ledgerStore();
  recordFiledIssues(
    { groups: [group('g-a', [FINDING_A])], issueByGroupKey: { 'g-a': 2588 } },
    seeded.seams,
  );
  const result = recordFiledIssues(
    {
      groups: [group('g-a', [FINDING_A]), group('g-b', [FINDING_B])],
      issueByGroupKey: { 'g-b': 2589 },
    },
    seeded.seams,
  );

  assert.equal(result.groupsRecorded, 1, 'only the mapped group is recorded');
  const byFp = new Map(
    seeded.state.ledger.entries.map((e) => [e.fingerprint, e]),
  );
  assert.equal(byFp.size, 2, 'the untouched entry survives');
  assert.equal(
    byFp.get(fingerprintAuditFinding(FINDING_A).full).issue.number,
    2588,
    'the unmapped group keeps the Issue the earlier run recorded',
  );
});

test('a map naming no present group records nothing and writes nothing', () => {
  const store = ledgerStore();
  const result = recordFiledIssues(
    {
      groups: [group('g-a', [FINDING_A])],
      issueByGroupKey: { 'other-key': 1 },
    },
    store.seams,
  );
  assert.equal(result.groupsRecorded, 0);
  assert.equal(result.findingsRecorded, 0);
  assert.equal(result.filed, 0);
  assert.equal(
    result.written,
    false,
    'nothing to record means nothing to write',
  );
  assert.equal(store.state.writes, 0);
});

test('a second pass over the same findings is known, not proposed', () => {
  const store = ledgerStore();
  const args = {
    groups: [group('g-a', [FINDING_A])],
    issueByGroupKey: { 'g-a': 2588 },
  };
  recordFiledIssues(args, store.seams);

  // Re-reconcile exactly as the next sweep would: prior ledger, same finding,
  // no fresh issueStates — the recorded entry must carry the verdict alone.
  const { classifications } = reconcileLedger({
    toCanonical: toCanonicalFinding,
    ledger: store.state.ledger,
    findings: [FINDING_A],
  });
  assert.equal(classifications[0].status, 'filed');
  assert.equal(classifications[0].action, 'known');
});

test('a filed entry whose Issue later closed loses to the closed-Issue branch', () => {
  const store = ledgerStore();
  recordFiledIssues(
    { groups: [group('g-a', [FINDING_A])], issueByGroupKey: { 'g-a': 2588 } },
    store.seams,
  );
  const fp = fingerprintAuditFinding(FINDING_A).full;

  const rejected = reconcileLedger({
    toCanonical: toCanonicalFinding,
    ledger: store.state.ledger,
    findings: [FINDING_A],
    issueStates: {
      [fp]: { state: 'closed', stateReason: 'not_planned', number: 2588 },
    },
  });
  assert.equal(rejected.classifications[0].status, 'accepted-risk');
  assert.equal(rejected.classifications[0].action, 'suppress');

  const completed = reconcileLedger({
    toCanonical: toCanonicalFinding,
    ledger: store.state.ledger,
    findings: [FINDING_A],
    issueStates: {
      [fp]: { state: 'closed', stateReason: 'completed', number: 2588 },
    },
  });
  assert.equal(completed.classifications[0].status, 'regressed');
  assert.equal(completed.classifications[0].action, 'regressed');
});

test('write:false computes the record without persisting it', () => {
  const store = ledgerStore();
  const result = recordFiledIssues(
    {
      groups: [group('g-a', [FINDING_A])],
      issueByGroupKey: { 'g-a': 2588 },
      write: false,
    },
    store.seams,
  );
  assert.equal(result.filed, 1);
  assert.equal(result.written, false);
  assert.equal(store.state.writes, 0, '--dry-run writes no ledger');
  assert.equal(store.state.ledger, null);
});

test('--wire-edges records the ledger BEFORE the provider is loaded', async () => {
  const recorded = [];
  const plan = {
    classifications: [{ action: 'create', group: group('g-a', [FINDING_A]) }],
    edges: [],
  };

  await assert.rejects(
    () =>
      wireEdges(
        { plan, issueByGroupKey: { 'g-a': 2588 }, ledgerPath: 'x.json' },
        {
          recordFiledIssuesImpl: (args) => {
            recorded.push(args);
            return { path: 'x.json', written: true, filed: 1 };
          },
          loadProviderImpl: () => {
            throw Object.assign(new Error('no gh'), { reason: 'no-config' });
          },
        },
      ),
    /--wire-edges needs a provider/,
    'the precondition error still surfaces unchanged',
  );

  assert.equal(recorded.length, 1, 'the ledger was recorded despite the throw');
  assert.equal(recorded[0].groups.length, 1);
  assert.equal(recorded[0].issueByGroupKey['g-a'], 2588);
});

test('--wire-edges returns the ledger record beside the wiring summary', async () => {
  const plan = {
    classifications: [{ action: 'create', group: group('g-a', [FINDING_A]) }],
    edges: [],
  };
  const result = await wireEdges(
    { plan, issueByGroupKey: { 'g-a': 2588 } },
    {
      recordFiledIssuesImpl: () => ({
        path: 'baselines/audit-ledger.json',
        written: true,
        filed: 1,
      }),
      loadProviderImpl: () => ({ updateTicket: async () => {} }),
      wireImpl: async () => ({ storiesWired: 1 }),
    },
  );
  assert.equal(result.storiesWired, 1);
  assert.equal(result.ledger.filed, 1);
});
