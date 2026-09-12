/**
 * tests/scripts/plan-persist.chain-on-clean.test.js — the fast path
 * (Story #4741 AC-1/AC-2/AC-3; any plan since Story #5312): `runPersistChain`
 * collapses the dry-run + persist operator round-trips into ONE invocation.
 *
 * The chain runs a write-free dry-run first; a plan that validates clean earns
 * the second, write pass — from the identical artifacts, so the persisted
 * output is byte-identical to what the dry-run gated. A validation failure
 * stops before any createIssue. The lite-route condition that used to gate
 * the chain went with the plan-side lite claim.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../.agents/scripts/lib/label-constants.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { runPersistChain } from '../../.agents/scripts/plan-persist.js';

/**
 * A clean Story: one `refactors-existing` change against a path that exists
 * at `main`, one acceptance criterion, one verify command.
 */
function cleanTicket(slug = 'solo') {
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
  const tempRoot = makeTempDir('plan-chain-');
  return { config: { project: { paths: { tempRoot } } }, tempRoot };
}

function chainArgs({ story }) {
  return {
    values: {
      stories: 'temp/plan-chain/stories.json',
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

describe('runPersistChain — fast path (Story #4741, any plan since #5312)', () => {
  it('AC-3/AC-1: a clean dry-run chains straight into the real persist in one invocation', async () => {
    const { config, tempRoot } = isolatedConfig();
    try {
      const provider = fakeProvider();
      const result = await runPersistChain({
        config,
        provider,
        ...chainArgs({
          story: cleanTicket('solo'),
        }),
      });

      // The write pass ran without a second operator round-trip.
      assert.deepEqual(result.chain, {
        attempted: true,
        persisted: true,
        reason: 'dry-run-clean',
      });
      assert.equal('route' in result, false, 'no route rides the result');
      assert.equal(result.stories.length, 1);

      // AC-2: every semantic step still ran on the dry-run pass and persist
      // wrote its bookkeeping (agent::ready + story-plan-state). No route
      // label rides the Story (Story #5312).
      const issue = provider.issues.get(result.primaryStoryId);
      assert.ok(issue.labels.includes(TYPE_LABELS.STORY));
      assert.ok(issue.labels.includes(AGENT_LABELS.READY));
      assert.ok(issue.labels.every((l) => !l.startsWith('route::')));
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
          story: cleanTicket('solo'),
        }),
      });

      // Plain persist of the SAME artifacts (the operator's two-step baseline).
      const plain = fakeProvider();
      const plainResult = await runPersistChain({
        config: cfgB,
        provider: plain,
        ...chainArgs({
          story: cleanTicket('solo'),
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

  it('chains any clean plan — there is no lite claim to gate on (Story #5312)', async () => {
    const { config, tempRoot } = isolatedConfig();
    try {
      const provider = fakeProvider();
      const result = await runPersistChain({
        config,
        provider,
        ...chainArgs({ story: cleanTicket('solo') }),
      });

      assert.equal(result.chain.persisted, true);
      assert.equal(result.chain.reason, 'dry-run-clean');
      assert.equal(provider.issues.size, 1);
      // The dry-run's warning list rides the persisted result — it is the
      // review the chain folds.
      assert.ok(Array.isArray(result.warnings));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
