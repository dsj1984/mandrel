/**
 * Unit tests for the cross-run audit findings ledger (Story #4626).
 *
 * These prove the two load-bearing memory guarantees:
 *   - AC-1: a finding already recorded `filed` is recognized as KNOWN on the
 *     next scan, never re-proposed as new.
 *   - AC-2: a finding whose tracking Issue was closed as `not_planned` is
 *     SUPPRESSED (accepted-risk) and produces no Story proposal.
 *
 * The test imports only the production entrypoint (`reconcileLedger`) plus the
 * shared identity helpers, then seeds prior-ledger states directly — so the
 * module keeps a minimal, production-consumed export surface.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fingerprintAuditFinding,
  semanticKeyForAuditFinding,
} from '../finding-adapter.js';
import { reconcileLedger } from '../ledger.js';

const NOW = '2026-07-19T00:00:00.000Z';

/** Build a raw audit finding of the shape parse-audit-md emits. */
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

/** Local identity helper (mirrors the module's internal one). */
function idOf(finding) {
  return {
    fingerprint: fingerprintAuditFinding(finding).full,
    semanticKey: semanticKeyForAuditFinding(finding),
  };
}

/** Seed a prior ledger carrying one entry at a given status/issue. */
function ledgerWithEntry(finding, { status, issue = null }) {
  const id = idOf(finding);
  return {
    $schema: 'https://mandrel.dev/baselines/audit-ledger.schema.json',
    generatedAt: NOW,
    entries: [
      {
        fingerprint: id.fingerprint,
        semanticKey: id.semanticKey,
        title: finding.title,
        dimension: finding.dimension,
        primaryFile: finding.files[0] ?? '',
        status,
        issue,
        firstSeen: NOW,
        lastSeen: NOW,
      },
    ],
  };
}

const FINDING = auditFinding(
  'security',
  'SQLi in login handler',
  'src/auth/login.js',
);

test('a brand-new finding classifies as new/propose and lands in the ledger', () => {
  const { ledger, classifications } = reconcileLedger({
    findings: [FINDING],
    now: NOW,
  });
  assert.equal(classifications.length, 1);
  assert.equal(classifications[0].status, 'new');
  assert.equal(classifications[0].action, 'propose');
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].status, 'new');
  assert.equal(ledger.entries[0].firstSeen, NOW);
});

test('AC-1: a re-detected finding already filed classifies as known, not new', () => {
  const filedLedger = ledgerWithEntry(FINDING, {
    status: 'filed',
    issue: { number: 42, state: 'open', stateReason: null },
  });

  const { classifications } = reconcileLedger({
    ledger: filedLedger,
    findings: [FINDING],
    now: '2026-07-20T00:00:00.000Z',
  });
  assert.equal(classifications[0].status, 'filed');
  assert.equal(classifications[0].action, 'known');
  assert.notEqual(classifications[0].action, 'propose');
});

test('AC-2: a finding whose Issue was closed as not_planned is suppressed', () => {
  const filedLedger = ledgerWithEntry(FINDING, {
    status: 'filed',
    issue: { number: 7, state: 'open', stateReason: null },
  });
  const id = idOf(FINDING);

  const { ledger, classifications } = reconcileLedger({
    ledger: filedLedger,
    findings: [FINDING],
    issueStates: {
      [id.fingerprint]: {
        number: 7,
        state: 'closed',
        stateReason: 'not_planned',
      },
    },
    now: '2026-07-21T00:00:00.000Z',
  });

  assert.equal(classifications[0].status, 'accepted-risk');
  assert.equal(classifications[0].action, 'suppress');
  // No Story proposal — the only proposing action is 'propose'.
  assert.notEqual(classifications[0].action, 'propose');
  // The suppression persists in the ledger memory.
  assert.equal(ledger.entries[0].status, 'accepted-risk');
});

test('accepted-risk stays suppressed on a later scan even without fresh Issue state', () => {
  const priorLedger = ledgerWithEntry(FINDING, {
    status: 'accepted-risk',
    issue: { number: 7, state: 'closed', stateReason: 'not_planned' },
  });
  const { classifications } = reconcileLedger({
    ledger: priorLedger,
    findings: [FINDING],
    now: '2026-07-22T00:00:00.000Z',
  });
  assert.equal(classifications[0].action, 'suppress');
});

test('a completed-then-redetected finding classifies as regressed', () => {
  const filedLedger = ledgerWithEntry(FINDING, {
    status: 'filed',
    issue: { number: 9, state: 'open', stateReason: null },
  });
  const id = idOf(FINDING);
  const { classifications } = reconcileLedger({
    ledger: filedLedger,
    findings: [FINDING],
    issueStates: {
      [id.fingerprint]: {
        number: 9,
        state: 'closed',
        stateReason: 'completed',
      },
    },
    now: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(classifications[0].status, 'regressed');
  assert.equal(classifications[0].action, 'regressed');
});

test('a reworded title at the same location matches the existing entry by semanticKey', () => {
  const filedLedger = ledgerWithEntry(FINDING, {
    status: 'filed',
    issue: { number: 11, state: 'open', stateReason: null },
  });

  // Same dimension + file, different title → different fingerprint, same key.
  const reworded = auditFinding(
    'security',
    'Unparameterised query on the sign-in path',
    'src/auth/login.js',
  );
  assert.notEqual(idOf(reworded).fingerprint, idOf(FINDING).fingerprint);
  assert.equal(idOf(reworded).semanticKey, idOf(FINDING).semanticKey);

  const { classifications } = reconcileLedger({
    ledger: filedLedger,
    findings: [reworded],
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(classifications[0].action, 'known');
});

test('reconcileLedger throws on a non-array findings argument', () => {
  assert.throws(() => reconcileLedger({ findings: null }));
});

test('an untouched prior entry survives a scan that does not re-detect it', () => {
  const other = auditFinding('perf', 'N+1 in list', 'src/list.js');
  const seeded = reconcileLedger({
    findings: [FINDING, other],
    now: NOW,
  }).ledger;
  // Re-scan only FINDING; `other` must remain in the ledger memory.
  const { ledger } = reconcileLedger({
    ledger: seeded,
    findings: [FINDING],
    now: '2026-07-25T00:00:00.000Z',
  });
  const keys = ledger.entries.map((e) => e.semanticKey).sort();
  assert.deepEqual(
    keys,
    [idOf(other).semanticKey, idOf(FINDING).semanticKey].sort(),
  );
});
