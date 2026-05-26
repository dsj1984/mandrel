// tests/contract/reconcile-sub-issues.test.js
//
// Story #3049 — contract test for the operator-facing repair CLI
// `reconcile-sub-issues.js`. Exercises:
//   - happy path: provider reports a gap, runReconcileSubIssuesCli returns
//     the reconciled envelope (linked = expected).
//   - failure path: provider reports leftover failures → CLI throws.
//   - argv validation: missing/zero/non-numeric --epic throws.
//
// The provider is a hand-rolled in-process stub injected via deps; no live
// `gh` calls and no network I/O.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runReconcileSubIssuesCli } from '../../.agents/scripts/reconcile-sub-issues.js';

function makeProvider(envelope) {
  let calledWith = null;
  return {
    calls: () => calledWith,
    reconcileSubIssueLinks: async (epicId) => {
      calledWith = epicId;
      return envelope;
    },
  };
}

const STUB_CONFIG = { github: { owner: 'acme', repo: 'widgets' } };

describe('runReconcileSubIssuesCli — argv validation', () => {
  it('throws when --epic is omitted', async () => {
    await assert.rejects(
      () =>
        runReconcileSubIssuesCli([], {
          config: STUB_CONFIG,
          provider: makeProvider({}),
        }),
      /--epic <id> is required/,
    );
  });

  it('throws when --epic is zero', async () => {
    await assert.rejects(
      () =>
        runReconcileSubIssuesCli(['--epic', '0'], {
          config: STUB_CONFIG,
          provider: makeProvider({}),
        }),
      /--epic <id> is required/,
    );
  });

  it('throws when --epic is non-numeric', async () => {
    await assert.rejects(
      () =>
        runReconcileSubIssuesCli(['--epic', 'banana'], {
          config: STUB_CONFIG,
          provider: makeProvider({}),
        }),
      /--epic <id> is required/,
    );
  });
});

describe('runReconcileSubIssuesCli — provider contract', () => {
  it('throws when the provider lacks reconcileSubIssueLinks', async () => {
    await assert.rejects(
      () =>
        runReconcileSubIssuesCli(['--epic', '42'], {
          config: STUB_CONFIG,
          provider: {},
        }),
      /does not implement reconcileSubIssueLinks/,
    );
  });
});

describe('runReconcileSubIssuesCli — happy path', () => {
  it('returns the envelope when every link is already in place', async () => {
    const provider = makeProvider({
      totalExpected: 3,
      alreadyLinked: 3,
      reconciled: 0,
      failed: 0,
      failures: [],
    });
    const result = await runReconcileSubIssuesCli(['--epic', '42'], {
      config: STUB_CONFIG,
      provider,
    });
    assert.equal(provider.calls(), 42);
    assert.equal(result.failed, 0);
    assert.equal(result.alreadyLinked, 3);
    assert.equal(result.reconciled, 0);
  });

  it('returns the envelope when the provider reconciles a gap', async () => {
    const provider = makeProvider({
      totalExpected: 4,
      alreadyLinked: 3,
      reconciled: 1,
      failed: 0,
      failures: [],
    });
    const result = await runReconcileSubIssuesCli(['--epic', '99'], {
      config: STUB_CONFIG,
      provider,
    });
    assert.equal(provider.calls(), 99);
    assert.equal(result.failed, 0);
    assert.equal(result.reconciled, 1);
  });
});

describe('runReconcileSubIssuesCli — failure path', () => {
  it('throws with a per-child summary when failures remain', async () => {
    const provider = makeProvider({
      totalExpected: 2,
      alreadyLinked: 1,
      reconciled: 0,
      failed: 1,
      failures: [
        { parentId: 100, childId: 101, reason: 'addSubIssue rejected (404)' },
      ],
    });
    await assert.rejects(
      () =>
        runReconcileSubIssuesCli(['--epic', '100'], {
          config: STUB_CONFIG,
          provider,
        }),
      /1\/2 link\(s\) could not be established/,
    );
  });
});
