/**
 * 50-id fanout cap — verifies the rewired ProgressReporter path never has
 * more than 8 provider.getTicket calls in flight simultaneously.
 *
 * Uses a pending-release fetchImpl so we can observe peak concurrency
 * without racing the Node event loop.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGh } from '../../.agents/scripts/lib/gh-exec.js';
import { ProgressReporter } from '../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js';
import { GitHubProvider } from '../../.agents/scripts/providers/github.js';

process.env.GITHUB_TOKEN = 'mock-token';

function silentLogger() {
  return { info() {}, warn() {} };
}

describe('ProgressReporter fanout concurrency cap', () => {
  it('caps in-flight provider reads at 8 for a 50-story wave', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => 100 + i);

    let inFlight = 0;
    let peak = 0;
    const releases = [];

    // Each gh-exec call increments the in-flight counter and returns a
    // promise that settles only when we explicitly release it. The test
    // releases responses one at a time so that concurrency can build up to
    // at most `concurrency` workers before any single one completes.
    const exec = () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        releases.push(() => {
          inFlight--;
          resolve({
            stdout: JSON.stringify({
              number: 0,
              id: 0,
              node_id: 'n',
              title: 'x',
              body: '',
              labels: [{ name: 'agent::executing' }],
              state: 'open',
            }),
            stderr: '',
            code: 0,
          });
        });
      });
    };
    const gh = createGh(exec);

    const provider = new GitHubProvider(
      { owner: 'o', repo: 'r' },
      { gh, token: 'mock' },
    );

    // Neuter the Epic-comment upsert so fire() doesn't try to post.
    provider.getTicketComments = async () => [];
    provider.postComment = async () => ({ commentId: 1 });

    const reporter = new ProgressReporter({
      provider,
      epicId: 1,
      intervalSec: 60,
      logger: silentLogger(),
      detectors: [],
    });
    reporter.setPlan({
      waves: [ids.map((id) => ({ id, title: `S${id}` }))],
      startedAt: new Date().toISOString(),
    });

    const firePromise = reporter.fire();

    // Drive the event loop until we've seen at least concurrency inbound
    // requests, then drain the release queue one by one. Each release
    // completes one request and frees up a slot for the next dispatch.
    async function drain() {
      for (let guard = 0; guard < 10_000; guard++) {
        if (releases.length === 0) {
          await new Promise((r) => setImmediate(r));
          continue;
        }
        const next = releases.shift();
        next();
        // Give the worker a tick to queue its next fetch before we release
        // another — this is what lets peak concurrency reflect the cap.
        await new Promise((r) => setImmediate(r));
        if (inFlight === 0 && releases.length === 0) break;
      }
    }

    await drain();
    await firePromise;

    assert.equal(
      peak,
      8,
      `50 ids / concurrency=8: expected peak in-flight to saturate at 8, got ${peak}`,
    );
  });

  it(
    'retry-path: transient postComment failure is swallowed and snapshot still returns',
    async () => {
      // Deterministic mocked adapter — getTicket returns a static
      // executing-ticket on every call, and postComment fails on the
      // first attempt then succeeds. The reporter's transport-boundary
      // contract is to log + swallow the comment-upsert failure, not
      // halt the wave, so `fire()` must still resolve with the snapshot
      // rendered from the fetched rows. Story #1847.
      const provider = {
        async getTicket(id) {
          return {
            number: id,
            id,
            title: `Story ${id}`,
            state: 'open',
            labels: ['agent::executing'],
          };
        },
        async getTicketComments() {
          return [];
        },
        async listComments() {
          return [];
        },
      };

      const postCalls = [];
      provider.postComment = async (ticketId, { body }) => {
        postCalls.push({ ticketId, body });
        if (postCalls.length === 1) {
          throw new Error('transient gh rate-limit (mock)');
        }
        return { commentId: postCalls.length };
      };

      const warnings = [];
      const reporter = new ProgressReporter({
        provider,
        epicId: 7,
        intervalSec: 60,
        logger: { info() {}, warn: (msg) => warnings.push(msg) },
        detectors: [],
      });
      reporter.setPlan({
        waves: [
          [
            { id: 101, title: 'A' },
            { id: 102, title: 'B' },
          ],
        ],
        startedAt: new Date().toISOString(),
      });

      const first = await reporter.fire();
      assert.ok(first, 'first fire() returned null');
      assert.equal(first.rows.length, 2, 'first fire returned both rows');
      assert.equal(postCalls.length, 1, 'first fire attempted one upsert');
      assert.ok(
        warnings.some((w) => w.includes('comment upsert failed')),
        'expected transient upsert failure to be logged',
      );

      // Second fire should succeed end-to-end now that the deterministic
      // adapter has flipped to the success branch.
      const second = await reporter.fire();
      assert.ok(second);
      assert.equal(postCalls.length, 2);
    },
  );
});
