/**
 * Contract tests for the `searchIssues` port consumed by routeFinding.
 *
 * These exercise the boundary contract between routeFinding and the issue
 * store: the port is handed a 40-char sha and MUST return issue records of
 * shape `{ number, state, body }` drawn from BOTH open and closed issues.
 * The fake below is a contract-grade in-memory store that models a real
 * GitHub issue index keyed by the fingerprint footer — it is NOT a per-test
 * stub that hard-codes a single return value.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fingerprintFinding,
  fingerprintFooter,
  routeFinding,
} from '../../../.agents/scripts/lib/findings/route-finding.js';

/**
 * Build a contract-grade issue store. Issues are indexed by the fingerprint
 * sha embedded in their footer; `searchIssues` scans the whole store (open
 * and closed) and returns every issue whose footer carries the queried sha.
 */
function makeIssueStore(issues) {
  const all = issues.map((i) => ({
    number: i.number,
    state: i.state,
    body: `Issue body for #${i.number}\n\n${fingerprintFooter(i.fingerprint)}`,
  }));
  return {
    issues: all,
    searchIssues: async (sha) => {
      assert.match(sha, /^[0-9a-f]{40}$/, 'port receives a 40-char sha1');
      return all.filter((i) => i.body.includes(sha));
    },
  };
}

const finding = {
  title: 'N+1 query in invoice list',
  area: 'performance',
  primaryFile: 'src/invoices/list.js',
  severity: 'medium',
  labels: ['perf'],
};

test('contract: searchIssues scans both open and closed and yields new on empty store', async () => {
  const store = makeIssueStore([]);
  const result = await routeFinding(finding, store);
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
});

test('contract: open issue carrying the fingerprint routes to update-existing', async () => {
  const { full: sha } = fingerprintFinding(finding);
  const store = makeIssueStore([
    { number: 100, state: 'open', fingerprint: sha },
    { number: 101, state: 'open', fingerprint: 'a'.repeat(40) },
  ]);
  const result = await routeFinding(finding, store);
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 100);
});

test('contract: closed issue carrying the fingerprint routes to regression-of-closed', async () => {
  const { full: sha } = fingerprintFinding(finding);
  const store = makeIssueStore([
    { number: 200, state: 'closed', fingerprint: sha },
  ]);
  const result = await routeFinding(finding, store);
  assert.equal(result.decision, 'regression-of-closed');
  assert.equal(result.matchedIssue.number, 200);
  assert.equal(result.matchedIssue.state, 'closed');
});

test('contract: matchedIssue carries the wire shape { number, state, body }', async () => {
  const { full: sha } = fingerprintFinding(finding);
  const store = makeIssueStore([
    { number: 300, state: 'open', fingerprint: sha },
  ]);
  const result = await routeFinding(finding, store);
  assert.equal(typeof result.matchedIssue.number, 'number');
  assert.equal(typeof result.matchedIssue.state, 'string');
  assert.equal(typeof result.matchedIssue.body, 'string');
});

test('contract: a non-matching closed fingerprint does not trigger regression', async () => {
  const store = makeIssueStore([
    { number: 400, state: 'closed', fingerprint: 'b'.repeat(40) },
  ]);
  const result = await routeFinding(finding, store);
  assert.equal(result.decision, 'new');
});

test('contract: mixed open+closed store prefers the open match', async () => {
  const { full: sha } = fingerprintFinding(finding);
  const store = makeIssueStore([
    { number: 500, state: 'closed', fingerprint: sha },
    { number: 501, state: 'open', fingerprint: sha },
  ]);
  const result = await routeFinding(finding, store);
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 501);
});
