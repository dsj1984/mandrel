import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getBranchProtection } from '../../../.agents/scripts/providers/github/branches.js';

function buildCtx({ rest } = {}) {
  return {
    owner: 'acme',
    repo: 'svc',
    http: { rest: rest ?? (async () => ({})) },
  };
}

describe('getBranchProtection', () => {
  it('returns {enabled: true, raw} when the branch is protected', async () => {
    const raw = { required_pull_request_reviews: {} };
    const ctx = buildCtx({ rest: async () => raw });
    const result = await getBranchProtection(ctx, 'main');
    assert.deepEqual(result, { enabled: true, raw });
  });

  it('returns {enabled: false} on a 404 (no protection rule)', async () => {
    const ctx = buildCtx({
      rest: async () => {
        throw new Error('GitHub REST request failed (404): not found');
      },
    });
    const result = await getBranchProtection(ctx, 'main');
    assert.deepEqual(result, { enabled: false });
  });

  it('propagates non-404 errors so transport faults stay loud', async () => {
    const ctx = buildCtx({
      rest: async () => {
        throw new Error('GitHub REST request failed (500): server error');
      },
    });
    await assert.rejects(
      () => getBranchProtection(ctx, 'main'),
      /failed \(500\)/,
    );
  });

  it('URL-encodes branch names with slashes', async () => {
    const calls = [];
    const ctx = buildCtx({
      rest: async (endpoint) => {
        calls.push(endpoint);
        return { ok: true };
      },
    });
    await getBranchProtection(ctx, 'release/2025-q4');
    assert.equal(
      calls[0],
      '/repos/acme/svc/branches/release%2F2025-q4/protection',
    );
  });

  it('treats an err with no message as non-404 (rethrow)', async () => {
    const ctx = buildCtx({
      rest: async () => {
        // Plain throw of an object without message.
        const e = new Error();
        e.message = undefined;
        throw e;
      },
    });
    await assert.rejects(() => getBranchProtection(ctx, 'main'));
  });
});
