/**
 * bootstrap/branch-protection — Epic #1235 Story 5
 *
 * Covers:
 *   - Fresh-rule path: writes enforce_admins:true + zero-approval count
 *     without prompting.
 *   - In-target-state path: additive append of missing contexts, no HITL.
 *   - Divergent existing rule: HITL gate intercepts the proposed payload
 *     and aborts on decline (no write); applies on approval.
 *   - Opt-out + no-checks paths remain skipped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyBranchProtection } from '../../.agents/scripts/lib/bootstrap/branch-protection.js';

const PR_GATE = {
  checks: [
    { name: 'lint', cmd: ['npm', 'run', 'lint'] },
    { name: 'test', cmd: ['npm', 'test'] },
  ],
  enforceBranchProtection: true,
};

function makeProvider({ existing = null, throws = null } = {}) {
  const calls = { getBranchProtection: [], setBranchProtection: [] };
  return {
    calls,
    async getBranchProtection(branch) {
      calls.getBranchProtection.push(branch);
      return existing ? { enabled: true, raw: existing } : { enabled: false };
    },
    async setBranchProtection(branch, opts) {
      calls.setBranchProtection.push({ branch, opts });
      if (throws) throw throws;
      const existingContexts = existing?.required_status_checks?.contexts ?? [];
      const merged = [...existingContexts];
      const added = [];
      for (const c of opts.contexts) {
        if (!merged.includes(c)) {
          merged.push(c);
          added.push(c);
        }
      }
      return { created: !existing, added, existing: existingContexts };
    },
  };
}

describe('bootstrap/applyBranchProtection', () => {
  it('fresh rule: writes enforce_admins:true + 0-approval-count without HITL', async () => {
    const provider = makeProvider({ existing: null });
    const hitl = async () => {
      throw new Error('should not be called');
    };
    const result = await applyBranchProtection({
      provider,
      settings: { quality: { prGate: PR_GATE } },
      hitlConfirm: hitl,
    });
    assert.equal(result.status, 'created');
    assert.equal(provider.calls.setBranchProtection.length, 1);
    const opts = provider.calls.setBranchProtection[0].opts;
    assert.deepEqual(opts.contexts, ['lint', 'test']);
    assert.equal(opts.enforceAdmins, true);
    assert.equal(opts.requiredApprovingReviewCount, 0);
  });

  it('existing-in-target-state: additive append of new contexts, no HITL', async () => {
    const provider = makeProvider({
      existing: {
        required_status_checks: { strict: true, contexts: ['lint'] },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: {
          required_approving_review_count: 0,
        },
        restrictions: null,
      },
    });
    let hitlCalls = 0;
    const result = await applyBranchProtection({
      provider,
      settings: { quality: { prGate: PR_GATE } },
      hitlConfirm: async () => {
        hitlCalls++;
        return true;
      },
    });
    assert.equal(result.status, 'merged');
    assert.deepEqual(result.added, ['test']);
    assert.equal(hitlCalls, 0);
  });

  it('divergent existing rule: HITL declines → no write, status=skipped', async () => {
    const provider = makeProvider({
      existing: {
        required_status_checks: { strict: true, contexts: ['lint'] },
        enforce_admins: { enabled: false }, // diverges from target
        required_pull_request_reviews: {
          required_approving_review_count: 2, // diverges from target
        },
        restrictions: null,
      },
    });
    let proposedSeen = null;
    const result = await applyBranchProtection({
      provider,
      settings: { quality: { prGate: PR_GATE } },
      hitlConfirm: async ({ proposed }) => {
        proposedSeen = proposed;
        return false;
      },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'hitl-declined');
    assert.equal(provider.calls.setBranchProtection.length, 0);
    assert.equal(proposedSeen.enforce_admins, true);
    assert.equal(proposedSeen.required_approving_review_count, 0);
  });

  it('divergent existing rule: HITL approves → PATCH lands with overrides', async () => {
    const provider = makeProvider({
      existing: {
        required_status_checks: { strict: true, contexts: ['lint'] },
        enforce_admins: { enabled: false },
        required_pull_request_reviews: {
          required_approving_review_count: 2,
        },
        restrictions: null,
      },
    });
    const result = await applyBranchProtection({
      provider,
      settings: { quality: { prGate: PR_GATE } },
      hitlConfirm: async () => true,
    });
    assert.equal(result.status, 'merged');
    const opts = provider.calls.setBranchProtection[0].opts;
    assert.equal(opts.enforceAdmins, true);
    assert.equal(opts.requiredApprovingReviewCount, 0);
  });

  it('non-TTY (no hitlConfirm supplied) defaults to abort on divergent rule', async () => {
    const provider = makeProvider({
      existing: {
        required_status_checks: { strict: true, contexts: ['lint'] },
        enforce_admins: { enabled: false },
        required_pull_request_reviews: null,
        restrictions: null,
      },
    });
    const result = await applyBranchProtection({
      provider,
      settings: { quality: { prGate: PR_GATE } },
      // hitlConfirm omitted → defaults to false
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'hitl-declined');
    assert.equal(provider.calls.setBranchProtection.length, 0);
  });

  it('opt-out: enforceBranchProtection=false skips entirely', async () => {
    const provider = makeProvider({ existing: null });
    const result = await applyBranchProtection({
      provider,
      settings: {
        quality: {
          prGate: { ...PR_GATE, enforceBranchProtection: false },
        },
      },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'opt-out');
    assert.equal(provider.calls.setBranchProtection.length, 0);
  });

  it('no-checks: empty/absent prGate.checks skips', async () => {
    const provider = makeProvider({ existing: null });
    const result = await applyBranchProtection({
      provider,
      settings: { quality: { prGate: { checks: [] } } },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-checks');
  });

  it('write failure: returns failed without throwing', async () => {
    const provider = makeProvider({
      existing: null,
      throws: new Error('403 Forbidden'),
    });
    const result = await applyBranchProtection({
      provider,
      settings: { quality: { prGate: PR_GATE } },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /403 Forbidden/);
  });
});
