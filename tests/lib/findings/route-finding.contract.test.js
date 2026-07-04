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

/**
 * Map an audit-to-stories-shaped `### Finding` block onto the canonical
 * identity the shared helper fingerprints over. Audit findings name their
 * area `dimension`; otherwise they already carry the identity fields, so
 * this is a near-passthrough projection onto
 * {title, area, primaryFile, severity, labels}.
 */
function fromAuditFinding(f) {
  return {
    title: f.title,
    area: f.dimension,
    primaryFile: f.primaryFile,
    severity: f.severity,
    labels: f.labels,
  };
}

/**
 * Map a QA-harness `F#` finding (the console/network-derived shape produced by
 * `console-allowlist.js`) onto the same canonical identity. The QA harness
 * names its fields differently
 * (`classification`/`surface`/`symptom`/`disposition`), so the adapter
 * projects them onto {title, area, primaryFile, severity, labels} before
 * routing — proving a structurally different producer resolves through the
 * *same* routeFinding entrypoint.
 */
function fromQaFinding(f) {
  return {
    title: f.symptom,
    area: f.classification,
    primaryFile: f.surface,
    severity: f.disposition === 'blocker' ? 'high' : 'low',
    labels: [`qa:${f.classification}`],
  };
}

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

// --- Shared entrypoint: audit-to-stories AND qa-explore route through routeFinding ---
//
// These tests prove the F1 hard-cutover invariant for Story #3720: an
// audit-to-stories-shaped finding and a qa-explore-shaped finding both
// resolve through the SAME routeFinding entrypoint after each producer's
// native shape is projected onto the canonical identity. There is no
// second dedup path — the only thing that differs between producers is the
// adapter that names their fields.

const auditFinding = {
  title: 'Unbounded recursion in dispatch planner',
  dimension: 'maintainability',
  primaryFile: '.agents/scripts/lib/dispatch/plan.js',
  severity: 'high',
  labels: ['audit:clean-code'],
};

const qaFinding = {
  id: 'F7',
  classification: 'console-error',
  surface: '/checkout',
  symptom: 'Uncaught TypeError reading "total" of undefined on checkout',
  likelyRootCause: null,
  disposition: 'blocker',
  acceptance: null,
  evidence: {
    console: [{ level: 'error', text: 'TypeError: ...' }],
    network: [],
  },
};

test('contract: an audit-to-stories-shaped finding routes to new through routeFinding', async () => {
  const store = makeIssueStore([]);
  const result = await routeFinding(fromAuditFinding(auditFinding), store);
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
  assert.match(result.fingerprint, /^[0-9a-f]{40}$/);
});

test('contract: a qa-explore-shaped finding routes to new through the same routeFinding', async () => {
  const store = makeIssueStore([]);
  const result = await routeFinding(fromQaFinding(qaFinding), store);
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
  assert.match(result.fingerprint, /^[0-9a-f]{40}$/);
});

test('contract: an audit-shaped finding dedupes against its own prior Issue (update-existing)', async () => {
  const { full: sha } = fingerprintFinding(fromAuditFinding(auditFinding));
  const store = makeIssueStore([
    { number: 610, state: 'open', fingerprint: sha },
  ]);
  const result = await routeFinding(fromAuditFinding(auditFinding), store);
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 610);
});

test('contract: a qa-shaped finding dedupes against its own prior Issue through the shared helper', async () => {
  const { full: sha } = fingerprintFinding(fromQaFinding(qaFinding));
  const store = makeIssueStore([
    { number: 620, state: 'open', fingerprint: sha },
  ]);
  const result = await routeFinding(fromQaFinding(qaFinding), store);
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 620);
});

test('contract: audit-shaped and qa-shaped findings yield distinct fingerprints from one helper', async () => {
  // Same entrypoint, same fingerprint function — distinct identities because
  // the two producers describe genuinely different problems. This is the
  // load-bearing proof that one shared helper serves both shapes.
  const auditFp = fingerprintFinding(fromAuditFinding(auditFinding)).full;
  const qaFp = fingerprintFinding(fromQaFinding(qaFinding)).full;
  assert.notEqual(auditFp, qaFp);
  assert.match(auditFp, /^[0-9a-f]{40}$/);
  assert.match(qaFp, /^[0-9a-f]{40}$/);
});

test('contract: both producers share the closed-Issue regression route', async () => {
  const auditSha = fingerprintFinding(fromAuditFinding(auditFinding)).full;
  const qaSha = fingerprintFinding(fromQaFinding(qaFinding)).full;
  const store = makeIssueStore([
    { number: 700, state: 'closed', fingerprint: auditSha },
    { number: 701, state: 'closed', fingerprint: qaSha },
  ]);
  const auditResult = await routeFinding(fromAuditFinding(auditFinding), store);
  const qaResult = await routeFinding(fromQaFinding(qaFinding), store);
  assert.equal(auditResult.decision, 'regression-of-closed');
  assert.equal(auditResult.matchedIssue.number, 700);
  assert.equal(qaResult.decision, 'regression-of-closed');
  assert.equal(qaResult.matchedIssue.number, 701);
});
