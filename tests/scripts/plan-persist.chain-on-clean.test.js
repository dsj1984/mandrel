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
 *
 * Story #5361 closes the two holes the collapse left: the caller reads the
 * second pass's envelope, so the first pass's `repairs[]` / `warnings[]` have
 * to survive onto it; and `--chain-on-clean`, the no-op alias the default
 * made redundant, is refused outright rather than accepted and ignored.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../.agents/scripts/lib/label-constants.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  runPersistChain,
  shouldChainPersist,
} from '../../.agents/scripts/plan-persist.js';

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

/** A Story with no acceptance contract — fails the dry-run validator. */
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

function fakeProvider({ sourceTicketId = null } = {}) {
  const issues = new Map();
  if (sourceTicketId !== null) {
    issues.set(sourceTicketId, {
      id: sourceTicketId,
      title: `source #${sourceTicketId}`,
      body: 'The analysis this plan replaces.',
      labels: [],
      state: 'open',
    });
  }
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
    },
    artifacts: {
      stories: [story],
      techSpecContent: null,
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
        /lack an inline acceptance contract/,
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

describe('AC-5: the chain does not swallow its own evidence (Story #5361)', () => {
  /** A Story whose `## Changes` bullet the write-free pass has to repair. */
  function repairableTicket() {
    const acceptance = ['solo done'];
    const verify = ['npm test (validate)'];
    return {
      slug: 'solo',
      type: 'story',
      title: 'Story solo',
      acceptance,
      verify,
      body: [
        '## Goal',
        'Goal of solo.',
        '',
        '## Changes',
        '- `tests/scripts/plan-persist.flat-stories.test.js`',
        '',
        '## Acceptance',
        '- [ ] solo done',
        '',
        '## Verify',
        '- npm test (validate)',
      ].join('\n'),
    };
  }

  it('carries the write-free pass repairs[] and warnings[] onto the envelope the caller reads', async () => {
    const { config, tempRoot } = isolatedConfig();
    try {
      const provider = fakeProvider();
      const result = await runPersistChain({
        config,
        provider,
        ...chainArgs({ story: repairableTicket() }),
      });

      // The repair is applied by mutating the ticket in place, so the second
      // pass has nothing left to find — the evidence has to be preserved, not
      // re-derived.
      assert.equal(result.repairs.length, 1);
      assert.equal(
        result.repairs[0].path,
        'tests/scripts/plan-persist.flat-stories.test.js',
      );
      assert.ok(
        result.warnings.some((w) => /repaired to/.test(w)),
        'the rendered repair line rides the envelope warnings[]',
      );
      // And it is reported once, not twice.
      assert.equal(
        result.warnings.filter((w) => /repaired to/.test(w)).length,
        1,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('AC-4: one primary Story, whatever the authoring order (Story #5361)', () => {
  /** Authoring order is consumer-first; dependency order is blocker-first. */
  function outOfOrderStories() {
    const mk = (slug, extra = {}) => ({
      ...cleanTicket(slug),
      ...extra,
    });
    return [mk('consumer', { depends_on: ['blocker'] }), mk('blocker')];
  }

  it('names the same Story in the supersede comment, the checkpoint and the summary', async () => {
    const { config, tempRoot } = isolatedConfig();
    const sourceTicketId = 4242;
    try {
      const provider = fakeProvider({ sourceTicketId });
      const [consumer, blocker] = outOfOrderStories();
      const result = await runPersistChain({
        config,
        provider,
        values: {
          stories: 'temp/plan-chain/stories.json',
          'source-tickets': String(sourceTicketId),
        },
        artifacts: {
          stories: [consumer, blocker],
          techSpecContent: null,
          planContextEnvelope: null,
        },
        metricsSince: new Date().toISOString(),
      });

      const blockerId = result.stories.find((s) => s.slug === 'blocker').id;
      const consumerId = result.stories.find((s) => s.slug === 'consumer').id;
      assert.notEqual(blockerId, consumerId);

      // The checkpoint and the envelope: the dependency-order first Story.
      assert.equal(result.primaryStoryId, blockerId);
      const checkpoint = provider.comments
        .map((c) => c.body)
        .find((b) => b.includes('story-plan-state'));
      assert.match(checkpoint, new RegExp(`"primaryStoryId":\\s*${blockerId}`));

      // The supersede comment on the unclaimed source id must name it too.
      const supersedeComment = provider.comments.find(
        (c) => c.issueNumber === sourceTicketId,
      );
      assert.ok(supersedeComment, 'the source ticket was commented on');
      assert.match(
        supersedeComment.body,
        new RegExp(`Superseded by #${blockerId}`),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('shouldChainPersist — persist is one command (Story #5342)', () => {
  it('chains with no flags at all', () => {
    assert.equal(shouldChainPersist({}), true);
  });

  it('does not chain under an explicit --dry-run', () => {
    assert.equal(shouldChainPersist({ 'dry-run': true }), false);
  });
});

describe('AC-6: --chain-on-clean is gone, not tolerated (Story #5361)', () => {
  const CLI = path.join(
    fileURLToPath(new URL('../../', import.meta.url)),
    '.agents/scripts/plan-persist.js',
  );

  it('is rejected as an unknown flag by the CLI', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [CLI, '--stories', 'temp/none.json', '--chain-on-clean'],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      (err) => {
        assert.match(
          `${err.stderr ?? ''}${err.stdout ?? ''}`,
          /--chain-on-clean/,
        );
        assert.notEqual(err.status, 0);
        return true;
      },
    );
  });

  it('is named by no source or workflow file', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        [
          'grep',
          '-l',
          'chain-on-clean',
          '--',
          '.agents',
          'tests',
          ':!tests/scripts/plan-persist.chain-on-clean.test.js',
        ],
        { cwd: root, encoding: 'utf8' },
      ).trim();
    } catch (err) {
      // `git grep` exits 1 for "no matches", which is the passing case.
      if (err.status !== 1) throw err;
    }
    assert.equal(hits, '', `no code path may accept the alias: ${hits}`);
  });
});
