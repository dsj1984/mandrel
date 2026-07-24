/**
 * tests/scripts/plan-persist.chain-on-clean.test.js — the plan-diet fast path
 * (Story #4741 AC-1/AC-2/AC-3): `runPersistChain` collapses the dry-run +
 * persist operator round-trips into ONE invocation.
 *
 * The chain runs a write-free dry-run first; only a plan that validates clean
 * AND resolves to the `lite` route earns the second, write pass — from the
 * identical artifacts, so the persisted output is byte-identical to what the
 * dry-run gated. A validation failure stops before any createIssue; a
 * full-route plan keeps its review round-trip (the chain declines).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../.agents/scripts/lib/label-constants.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';
import { runPersistChain } from '../../.agents/scripts/plan-persist.js';

/**
 * A lite-shaped Story: one `refactors-existing` change against a path that
 * exists at `main` (so the file-assumption gate passes), one acceptance
 * criterion, a non-sensitive footprint — every signal the shape backstop needs
 * to uphold a lite claim.
 */
function liteTicket(slug = 'solo') {
  const acceptance = [`${slug} done`];
  const verify = ['npm test (validate)'];
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    acceptance,
    verify,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [
        {
          path: 'tests/scripts/plan-persist.flat-stories.test.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance,
      verify,
      reason_to_exist: `Ship ${slug}`,
    }),
  };
}

/** A Story with no acceptance/verify contract — fails the dry-run validator. */
function invalidTicket() {
  return {
    slug: 'bad',
    type: 'story',
    title: 'Bad',
    acceptance: [],
    verify: [],
    body: serialize({
      goal: 'Goal of bad.',
      changes: [
        {
          path: 'tests/scripts/plan-persist.flat-stories.test.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance: [],
      verify: [],
      reason_to_exist: 'Ship bad',
    }),
  };
}

function fakeProvider() {
  const issues = new Map();
  const comments = [];
  let nextId = 6000;
  return {
    issues,
    comments,
    async createIssue({ title, body, labels }) {
      const id = nextId++;
      issues.set(id, { id, title, body, labels: [...labels] });
      return { id, url: `https://example.test/${id}` };
    },
    async getTicket(id) {
      const issue = issues.get(id);
      if (!issue) throw new Error(`ticket #${id} not found`);
      return { ...issue, state: issue.state ?? 'open' };
    },
    async listIssuesByLabel() {
      return [];
    },
    async updateTicket(id, mutations) {
      const issue = issues.get(id);
      if (!issue) throw new Error(`ticket #${id} not found`);
      const { labels: labelMutations, ...rest } = mutations;
      Object.assign(issue, rest);
      if (labelMutations) {
        const next = new Set(issue.labels ?? []);
        for (const l of labelMutations.remove ?? []) next.delete(l);
        for (const l of labelMutations.add ?? []) next.add(l);
        issue.labels = [...next];
      }
    },
    async getTicketComments() {
      return [];
    },
    async postComment(issueNumber, payload) {
      const body = typeof payload === 'string' ? payload : payload.body;
      comments.push({ id: comments.length + 1, issueNumber, body });
      return { id: comments.length };
    },
  };
}

/** Per-test isolated tempRoot so plan-metrics never touch the shared ledger. */
function isolatedConfig() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'plan-chain-'));
  return { config: { project: { paths: { tempRoot } } }, tempRoot };
}

function chainArgs({ story, routeDowngradeReason }) {
  return {
    values: {
      stories: 'temp/plan-chain/stories.json',
      'route-downgrade-reason': routeDowngradeReason,
      'chain-on-clean': true,
    },
    artifacts: {
      stories: [story],
      techSpecContent: null,
      planAcceptance: null,
      planContextEnvelope: null,
    },
    metricsSince: new Date().toISOString(),
  };
}

describe('runPersistChain — plan-diet fast path (Story #4741)', () => {
  it('AC-3/AC-1: a clean lite dry-run chains straight into the real persist in one invocation', async () => {
    const { config, tempRoot } = isolatedConfig();
    try {
      const provider = fakeProvider();
      const result = await runPersistChain({
        config,
        provider,
        ...chainArgs({
          story: liteTicket('solo'),
          routeDowngradeReason: 'single trivial artifact',
        }),
      });

      // The write pass ran without a second operator round-trip.
      assert.deepEqual(result.chain, {
        attempted: true,
        persisted: true,
        reason: 'lite-dry-run-clean',
      });
      assert.equal(result.route.route, 'lite');
      assert.equal(result.stories.length, 1);

      // AC-2: every semantic step still ran on the dry-run pass — the shape
      // backstop upheld the lite claim (route::lite hint) and persist wrote
      // its bookkeeping (agent::ready + story-plan-state).
      const issue = provider.issues.get(result.primaryStoryId);
      assert.ok(issue.labels.includes(TYPE_LABELS.STORY));
      assert.ok(issue.labels.includes(AGENT_LABELS.READY));
      assert.ok(issue.labels.includes('route::lite'));
      const checkpoint = provider.comments
        .map((c) => c.body)
        .find((b) => b.includes('story-plan-state'));
      assert.ok(checkpoint, 'the persist checkpoint was written');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('AC-1: the chained persist output is byte-identical to a plain (non-chained) persist', async () => {
    const { config: cfgA, tempRoot: rootA } = isolatedConfig();
    const { config: cfgB, tempRoot: rootB } = isolatedConfig();
    try {
      // Chained lite persist.
      const chained = fakeProvider();
      const chainedResult = await runPersistChain({
        config: cfgA,
        provider: chained,
        ...chainArgs({
          story: liteTicket('solo'),
          routeDowngradeReason: 'single trivial artifact',
        }),
      });

      // Plain persist of the SAME artifacts (the operator's two-step baseline).
      const plain = fakeProvider();
      const plainResult = await runPersistChain({
        config: cfgB,
        provider: plain,
        ...chainArgs({
          story: liteTicket('solo'),
          routeDowngradeReason: 'single trivial artifact',
        }),
      });

      const chainedBody = chained.issues.get(chainedResult.primaryStoryId).body;
      const plainBody = plain.issues.get(plainResult.primaryStoryId).body;
      assert.equal(
        chainedBody,
        plainBody,
        'the diet must not alter the persisted Story body',
      );
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('AC-3: a dry-run validation failure stops before any createIssue', async () => {
    const { config, tempRoot } = isolatedConfig();
    try {
      const provider = fakeProvider();
      await assert.rejects(
        () =>
          runPersistChain({
            config,
            provider,
            ...chainArgs({
              story: invalidTicket(),
              routeDowngradeReason: 'single trivial artifact',
            }),
          }),
        /acceptance \+ verify contract/,
      );
      // The real persist pass never ran — nothing was created.
      assert.equal(provider.issues.size, 0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('a full-route plan keeps its review round-trip — the chain declines, writing nothing', async () => {
    const { config, tempRoot } = isolatedConfig();
    try {
      const provider = fakeProvider();
      // No route-downgrade reason → the plan resolves to the full route, so
      // the auto-persist is declined even though the dry-run is clean.
      const result = await runPersistChain({
        config,
        provider,
        ...chainArgs({
          story: liteTicket('solo'),
          routeDowngradeReason: undefined,
        }),
      });

      assert.deepEqual(result.chain, {
        attempted: true,
        persisted: false,
        reason: 'route-not-lite',
      });
      assert.equal(provider.issues.size, 0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
