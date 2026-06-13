/**
 * GitHubProvider facade — branch-protection surface.
 *
 * Tests GitHubProvider's getBranchProtection / setBranchProtection /
 * branchExists methods with a mocked gh-exec facade — no live API calls.
 * Split from the former root monolith `tests/providers-github.test.js`
 * (Story #4084).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestProvider, makeGh } from './_helpers.js';

// ---------------------------------------------------------------------------
// getBranchProtection / setBranchProtection — Task #1371
// ---------------------------------------------------------------------------
describe('GitHubProvider — getBranchProtection()', () => {
  it('returns {enabled:true, raw} when the branch is protected', async () => {
    const raw = {
      required_status_checks: { strict: true, contexts: ['lint'] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 0 },
      restrictions: null,
    };
    const gh = makeGh({
      'GET /branches/main/protection': { status: 200, json: raw },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getBranchProtection('main');
    assert.deepEqual(result, { enabled: true, raw });
  });

  it('returns {enabled:false} on a 404 from gh-exec', async () => {
    const gh = makeGh({
      'GET /branches/main/protection': {
        status: 404,
        json: { message: 'Not Found' },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getBranchProtection('main');
    assert.deepEqual(result, { enabled: false });
  });

  it('URL-encodes branch names with slashes', async () => {
    const gh = makeGh({
      'GET /branches/release%2F2025-q4/protection': {
        status: 200,
        json: { ok: true },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getBranchProtection('release/2025-q4');
    assert.equal(result.enabled, true);

    const endpoint = gh.__exec.calls[0].args[3];
    assert.ok(endpoint.includes('release%2F2025-q4'));
  });

  it('propagates non-404 errors', async () => {
    const gh = makeGh({
      'GET /branches/main/protection': {
        status: 500,
        json: { message: 'server error' },
      },
    });
    const provider = createTestProvider({ gh });
    await assert.rejects(provider.getBranchProtection('main'), /code 500/);
  });
});

describe('GitHubProvider — setBranchProtection()', () => {
  it('creates a fresh rule when no protection exists', async () => {
    let putBody = null;
    const gh = makeGh({
      'GET /branches/main/protection': {
        status: 404,
        json: { message: 'Not Found' },
      },
      'PUT /branches/main/protection': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.setBranchProtection('main', {
      contexts: ['lint', 'test'],
      enforceAdmins: true,
      requiredApprovingReviewCount: 0,
    });

    assert.equal(result.created, true);
    assert.deepEqual(result.added, ['lint', 'test']);
    assert.deepEqual(result.existing, []);

    const putCall = gh.__exec.calls.find((c) => c.args[2] === 'PUT');
    assert.ok(putCall, 'expected PUT call to fire');
    putBody = JSON.parse(putCall.input);
    assert.deepEqual(putBody.required_status_checks, {
      strict: true,
      contexts: ['lint', 'test'],
    });
    assert.equal(putBody.enforce_admins, true);
    assert.equal(
      putBody.required_pull_request_reviews.required_approving_review_count,
      0,
    );
    assert.equal(putBody.restrictions, null);
  });

  it('additively merges contexts when a rule already exists', async () => {
    const existing = {
      required_status_checks: { strict: true, contexts: ['lint'] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 0 },
      restrictions: null,
    };
    const gh = makeGh({
      'GET /branches/main/protection': { status: 200, json: existing },
      'PUT /branches/main/protection': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.setBranchProtection('main', {
      contexts: ['lint', 'test'],
    });

    assert.equal(result.created, false);
    assert.deepEqual(result.added, ['test']);
    assert.deepEqual(result.existing, ['lint']);

    const putCall = gh.__exec.calls.find((c) => c.args[2] === 'PUT');
    const body = JSON.parse(putCall.input);
    assert.deepEqual(body.required_status_checks.contexts, ['lint', 'test']);
    // No override → preserves the existing enforce_admins value (true).
    assert.equal(body.enforce_admins, true);
  });

  it('preserves operator review flags when overriding approval count', async () => {
    const existing = {
      required_status_checks: { strict: true, contexts: ['lint'] },
      enforce_admins: { enabled: false },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
      },
      restrictions: null,
    };
    const gh = makeGh({
      'GET /branches/main/protection': { status: 200, json: existing },
      'PUT /branches/main/protection': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    await provider.setBranchProtection('main', {
      contexts: ['lint'],
      enforceAdmins: true,
      requiredApprovingReviewCount: 0,
    });

    const putCall = gh.__exec.calls.find((c) => c.args[2] === 'PUT');
    const body = JSON.parse(putCall.input);
    assert.equal(body.enforce_admins, true);
    assert.equal(
      body.required_pull_request_reviews.required_approving_review_count,
      0,
    );
    // dismiss_stale_reviews survives the override.
    assert.equal(
      body.required_pull_request_reviews.dismiss_stale_reviews,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// branchExists — Story #2018 (Bug 3)
//
// `lib/bootstrap/branch-protection.js` consults `provider.branchExists()`
// before attempting a protection write so empty-repo bootstraps get a clean
// "no-base-branch" skip instead of a confusing PUT 404. The probe is a
// thin GET wrapper that returns true/false on 404 and propagates anything
// else so auth/scope failures don't masquerade as a missing branch.
// ---------------------------------------------------------------------------
describe('GitHubProvider — branchExists()', () => {
  it('returns true when GET /repos/.../branches/{branch} resolves', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo/branches/main': {
        status: 200,
        json: { name: 'main' },
      },
    });
    const provider = createTestProvider({ gh });
    assert.equal(await provider.branchExists('main'), true);
  });

  it('returns false on 404 (branch not pushed yet)', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo/branches/main': {
        status: 404,
        json: { message: 'Branch not found' },
      },
    });
    const provider = createTestProvider({ gh });
    assert.equal(await provider.branchExists('main'), false);
  });

  it('propagates non-404 errors so auth/scope failures stay loud', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo/branches/main': {
        status: 401,
        json: { message: 'Bad credentials' },
      },
    });
    const provider = createTestProvider({ gh });
    await assert.rejects(provider.branchExists('main'), /code 401/);
  });
});
