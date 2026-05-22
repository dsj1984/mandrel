// tests/contract/delivery/preflight-estimate.test.js
/**
 * Contract test — Story #2899 Task #2924 (Epic #2880, F13).
 *
 * `epic-deliver-preflight.js` MUST:
 *
 *   - Produce a JSON envelope carrying the five canonical metric keys
 *     (`storyCount`, `installCostSeconds`, `waveCount`,
 *     `githubApiRequests`, `claudeQuotaTokens`) plus a `breaches` array
 *     when called with `--dry-run`.
 *   - Upsert a structured comment with marker `delivery-preflight` on
 *     the Epic when called with `--post` (no `--dry-run`), and a second
 *     `--post` invocation MUST update the same comment in place (one
 *     comment after two runs).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeEstimate,
  detectBreaches,
  renderPreflightBody,
  runPreflight,
} from '../../../.agents/scripts/epic-deliver-preflight.js';

// Build a fake provider that satisfies the snapshot + build-wave-dag
// phases without touching the network. The snapshot phase asserts the
// acceptance-spec start gate, so the Epic carries the `acceptance::n-a`
// waiver label to keep the gate trivially satisfied.
function buildFakeProvider({ epicId, stories }) {
  const comments = new Map(); // id -> { id, body }
  let nextCommentId = 1;
  const provider = {
    async getTicket(id) {
      if (id !== epicId) return null;
      return {
        id: epicId,
        number: epicId,
        labels: ['type::epic', 'acceptance::n-a'],
        body: '',
        title: `Epic #${epicId}`,
      };
    },
    async getSubTickets(_id) {
      return stories;
    },
    async listComments(_ticketId) {
      return Array.from(comments.values());
    },
    async getTicketComments(_ticketId) {
      return Array.from(comments.values());
    },
    async postComment(_ticketId, payload) {
      const id = nextCommentId++;
      // GitHub provider wraps as `{ type, body }`; preserve both fields
      // on the stored row so the structured-comment marker is visible
      // on read-back (findStructuredComment greps the body).
      comments.set(id, { id, body: payload.body, type: payload.type });
      return { id };
    },
    async deleteComment(id) {
      comments.delete(id);
    },
    // Snapshot inspector for the test
    _comments: comments,
  };
  return provider;
}

const FAKE_CONFIG = {
  delivery: {
    preflight: {
      maxStories: null,
      maxWaves: null,
      maxInstallCostSeconds: null,
      maxGithubApiRequests: null,
      maxClaudeQuotaTokens: null,
    },
  },
  // The preflight only reads delivery via getPreflight + the provider via
  // injection, so an empty orchestration block is sufficient.
  orchestration: { provider: 'github' },
};

describe('contract/delivery/preflight-estimate', () => {
  describe('computeEstimate', () => {
    it('returns the five canonical metric keys', () => {
      const e = computeEstimate({ storyCount: 4, waveCount: 2 });
      assert.deepEqual(Object.keys(e).sort(), [
        'claudeQuotaTokens',
        'githubApiRequests',
        'installCostSeconds',
        'storyCount',
        'waveCount',
      ]);
    });

    it('scales install cost linearly with story count', () => {
      const a = computeEstimate({ storyCount: 2, waveCount: 1 });
      const b = computeEstimate({ storyCount: 4, waveCount: 1 });
      assert.equal(b.installCostSeconds, a.installCostSeconds * 2);
    });

    it('rejects negative storyCount', () => {
      assert.throws(() => computeEstimate({ storyCount: -1, waveCount: 0 }));
    });
  });

  describe('detectBreaches', () => {
    it('skips null thresholds', () => {
      const e = computeEstimate({ storyCount: 10, waveCount: 3 });
      const breaches = detectBreaches(e, {
        maxStories: null,
        maxWaves: null,
        maxInstallCostSeconds: null,
        maxGithubApiRequests: null,
        maxClaudeQuotaTokens: null,
      });
      assert.deepEqual(breaches, []);
    });

    it('flags maxStories when exceeded', () => {
      const e = computeEstimate({ storyCount: 10, waveCount: 3 });
      const breaches = detectBreaches(e, {
        maxStories: 5,
        maxWaves: null,
        maxInstallCostSeconds: null,
        maxGithubApiRequests: null,
        maxClaudeQuotaTokens: null,
      });
      assert.equal(breaches.length, 1);
      assert.equal(breaches[0].key, 'storyCount');
      assert.equal(breaches[0].observed, 10);
      assert.equal(breaches[0].max, 5);
    });
  });

  describe('renderPreflightBody', () => {
    it('embeds the breach list when present', () => {
      const e = computeEstimate({ storyCount: 10, waveCount: 3 });
      const t = {
        maxStories: 5,
        maxWaves: null,
        maxInstallCostSeconds: null,
        maxGithubApiRequests: null,
        maxClaudeQuotaTokens: null,
      };
      const breaches = detectBreaches(e, t);
      const body = renderPreflightBody({
        epicId: 99,
        estimate: e,
        breaches,
        thresholds: t,
      });
      assert.match(body, /Delivery preflight — Epic #99/);
      assert.match(body, /storyCount/);
      assert.match(body, /Threshold breaches/);
    });
  });

  describe('runPreflight (programmatic)', () => {
    it('returns the canonical metric keys for --dry-run', async () => {
      const stories = [101, 102, 103, 104].map((id) => ({
        id,
        number: id,
        labels: ['type::story'],
        body: '',
        title: `Story #${id}`,
      }));
      const provider = buildFakeProvider({ epicId: 99, stories });
      const envelope = await runPreflight({
        epicId: 99,
        dryRun: true,
        injectedProvider: provider,
        injectedConfig: FAKE_CONFIG,
      });
      // AC1 — envelope carries the five canonical keys.
      assert.equal(envelope.storyCount, 4);
      assert.equal(envelope.waveCount, 1);
      assert.equal(typeof envelope.installCostSeconds, 'number');
      assert.equal(typeof envelope.githubApiRequests, 'number');
      assert.equal(typeof envelope.claudeQuotaTokens, 'number');
      assert.deepEqual(envelope.breaches, []);
      assert.equal(envelope.commentUpserted, false);
      // Dry-run MUST NOT write a comment.
      assert.equal(provider._comments.size, 0);
    });

    it('upserts a delivery-preflight comment on --post', async () => {
      const stories = [201, 202].map((id) => ({
        id,
        number: id,
        labels: ['type::story'],
        body: '',
        title: `Story #${id}`,
      }));
      const provider = buildFakeProvider({ epicId: 77, stories });

      // First --post invocation creates one comment.
      const first = await runPreflight({
        epicId: 77,
        dryRun: false,
        post: true,
        injectedProvider: provider,
        injectedConfig: FAKE_CONFIG,
      });
      assert.equal(first.commentUpserted, true);
      assert.equal(provider._comments.size, 1);
      const firstComment = Array.from(provider._comments.values())[0];
      assert.match(firstComment.body, /delivery-preflight/);
      assert.match(firstComment.body, /Delivery preflight — Epic #77/);

      // Second --post invocation must REPLACE the prior comment, not
      // append a second one (upsert contract).
      await runPreflight({
        epicId: 77,
        dryRun: false,
        post: true,
        injectedProvider: provider,
        injectedConfig: FAKE_CONFIG,
      });
      assert.equal(provider._comments.size, 1);
    });

    it('does not upsert when neither --dry-run nor --post is set', async () => {
      const stories = [301].map((id) => ({
        id,
        number: id,
        labels: ['type::story'],
        body: '',
        title: `Story #${id}`,
      }));
      const provider = buildFakeProvider({ epicId: 55, stories });
      const envelope = await runPreflight({
        epicId: 55,
        injectedProvider: provider,
        injectedConfig: FAKE_CONFIG,
      });
      assert.equal(envelope.commentUpserted, false);
      assert.equal(provider._comments.size, 0);
    });
  });
});
