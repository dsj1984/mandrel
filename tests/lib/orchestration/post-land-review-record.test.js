import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setLevel } from '../../../.agents/scripts/lib/Logger.js';
import { RUNTIME_FRICTION_CATEGORIES } from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import { buildReviewDeposit } from '../../../.agents/scripts/lib/orchestration/review-deposit.js';
import { recordLandReview } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/land-review-record.js';
import { runPostLandTail } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/post-land.js';
import {
  buildTerminalEnvelope,
  exitCodeForTerminal,
} from '../../../.agents/scripts/lib/orchestration/story-deliver-terminal.js';
import { confirmAndLand } from '../../../.agents/scripts/lib/single-story/confirm-and-land.js';

setLevel('silent');

const STORY = 5975;
const PR = 77;
const HEAD = 'a'.repeat(40);
const PR_URL = `https://github.com/o/r/pull/${PR}`;

/** In-memory provider: comments per ticket, read and written in order. */
function fakeProvider() {
  const comments = new Map();
  let nextId = 1;
  return {
    comments,
    async getTicketComments(id) {
      return [...(comments.get(id) ?? [])];
    },
    async postComment(id, { body }) {
      const row = { id: nextId++, body };
      comments.set(id, [...(comments.get(id) ?? []), row]);
      return { id: row.id };
    },
    async deleteComment(commentId) {
      for (const [id, rows] of comments) {
        comments.set(
          id,
          rows.filter((r) => r.id !== commentId),
        );
      }
    },
  };
}

function deposit({ headSha = HEAD, halted = false } = {}) {
  return buildReviewDeposit({
    storyId: STORY,
    headSha,
    baseRef: 'origin/main',
    diffDigest: 'd'.repeat(64),
    result: {
      providerName: 'fake',
      severity: { critical: halted ? 1 : 0, high: 2, medium: 0, suggestion: 1 },
      halted,
      findings: [],
      report: `## 🔬 Code Review — Story #${STORY}\n\nDEPOSIT-REPORT-BODY`,
    },
  });
}

function seams({ provider, held = null, probed = null, friction = [] }) {
  return {
    storyId: STORY,
    prNumber: PR,
    prUrl: null,
    baseBranch: 'main',
    cwd: '/nowhere',
    provider,
    readPrHeadFn: async () => ({ headSha: HEAD, url: PR_URL }),
    readDepositFn: () => held,
    probeHeldReviewDiffFn: () => ({ deposit: probed }),
    emitRuntimeFrictionFn: async (signal) => {
      friction.push(signal);
      return true;
    },
    gitSpawnFn: () => ({ status: 1, stdout: '' }),
  };
}

const prBodies = (provider) =>
  (provider.comments.get(PR) ?? []).map((c) => c.body);
const storyBodies = (provider) =>
  (provider.comments.get(STORY) ?? []).map((c) => c.body);
const reviewComments = (provider) =>
  prBodies(provider).filter((b) => b.includes('verification-results'));

describe('recordLandReview — the land review record (Story #5975)', () => {
  it('AC-1: posts a deposit matching the merged head SHA, with provenance and a Story cross-reference', async () => {
    const provider = fakeProvider();
    const friction = [];
    const out = await recordLandReview(
      seams({ provider, held: deposit(), friction }),
    );
    assert.deepEqual(out, { ok: true, detail: 'posted-from-deposit' });
    const [review] = reviewComments(provider);
    assert.match(review, /DEPOSIT-REPORT-BODY/);
    assert.match(
      review,
      new RegExp(`Computed at handoff for \`${HEAD}\`; recorded at land`),
    );
    const [crossRef] = storyBodies(provider);
    assert.match(crossRef, new RegExp(`PR \\[#${PR}\\]\\(${PR_URL}\\)`));
    assert.deepEqual(
      friction.map((f) => f.category),
      [RUNTIME_FRICTION_CATEGORIES.REVIEW_RECORDED_AT_LAND],
    );
    assert.equal(friction[0].tool, 'runPostLandTail');
    assert.equal(friction[0].details.prNumber, PR);
    assert.equal(friction[0].details.severity.high, 2);
  });

  it('AC-1: posts a deposit whose diff digest matches after a base-sync moved the head', async () => {
    const provider = fakeProvider();
    const held = deposit({ headSha: 'b'.repeat(40) });
    let probedSha = null;
    const out = await recordLandReview({
      ...seams({ provider, held }),
      probeHeldReviewDiffFn: (args) => {
        probedSha = args.sha;
        return { deposit: args.readDepositFn() };
      },
    });
    assert.equal(out.detail, 'posted-from-deposit');
    assert.equal(probedSha, HEAD);
    assert.equal(reviewComments(provider).length, 1);
  });

  for (const [reason, held] of [
    ['no-deposit', null],
    ['stale-deposit', deposit({ headSha: 'c'.repeat(40) })],
  ]) {
    it(`AC-2: posts an Unreviewed marker naming ${reason}, plus a Story cross-reference`, async () => {
      const provider = fakeProvider();
      const friction = [];
      const out = await recordLandReview(seams({ provider, held, friction }));
      assert.deepEqual(out, { ok: true, detail: `unreviewed-${reason}` });
      const [review] = reviewComments(provider);
      assert.match(review, new RegExp(`## 🔬 Code Review — Story #${STORY}`));
      assert.match(review, /\*\*Unreviewed\*\*/);
      assert.match(review, new RegExp(`\`${reason}\``));
      assert.match(review, /story-review-compute\.js/);
      assert.match(storyBodies(provider)[0], /unreviewed/);
      assert.deepEqual(
        friction.map((f) => [f.category, f.details.outcome]),
        [
          [
            RUNTIME_FRICTION_CATEGORIES.REVIEW_RECORDED_AT_LAND,
            `unreviewed-${reason}`,
          ],
        ],
      );
    });
  }

  it('AC-3/AC-6: an existing review comment posts nothing and emits nothing, run after run', async () => {
    const provider = fakeProvider();
    const friction = [];
    const first = await recordLandReview(seams({ provider, friction }));
    assert.equal(first.detail, 'unreviewed-no-deposit');
    const before = provider.comments.get(PR).length;
    friction.length = 0;
    for (let run = 0; run < 2; run += 1) {
      const again = await recordLandReview({
        ...seams({ provider, held: deposit(), friction }),
        readPrHeadFn: async () => {
          throw new Error('must not read the PR head');
        },
      });
      assert.deepEqual(again, { ok: true, detail: 'already-recorded' });
    }
    assert.equal(provider.comments.get(PR).length, before);
    assert.equal(reviewComments(provider).length, 1);
    assert.deepEqual(friction, []);
  });

  it('AC-6: a posted deposit that held a CRITICAL also emits review-critical-merged', async () => {
    const provider = fakeProvider();
    const friction = [];
    await recordLandReview(
      seams({ provider, held: deposit({ halted: true }), friction }),
    );
    assert.deepEqual(
      friction.map((f) => f.category),
      [
        RUNTIME_FRICTION_CATEGORIES.REVIEW_RECORDED_AT_LAND,
        RUNTIME_FRICTION_CATEGORIES.REVIEW_CRITICAL_MERGED,
      ],
    );
  });

  it('AC-5: no PR number skips the record without any read', async () => {
    const out = await recordLandReview({
      ...seams({ provider: {} }),
      prNumber: null,
    });
    assert.deepEqual(out, { ok: true, detail: 'no-pr' });
  });

  it('AC-7: a failed post reports ok: false', async () => {
    const provider = fakeProvider();
    provider.postComment = async () => {
      throw new Error('post exploded');
    };
    const out = await recordLandReview(seams({ provider, held: deposit() }));
    assert.deepEqual(out, { ok: false, detail: 'post-failed' });
  });

  it('reads the merged head through the caller gh; a missing head throws for step() to degrade', async () => {
    const asked = [];
    const gh = {
      pr: {
        view: async (n, fields) => {
          asked.push([n, fields]);
          return { headRefOid: HEAD, url: PR_URL };
        },
      },
    };
    const provider = fakeProvider();
    const base = seams({ provider });
    delete base.readPrHeadFn;
    const out = await recordLandReview({ ...base, gh });
    assert.equal(out.detail, 'unreviewed-no-deposit');
    assert.deepEqual(asked, [[PR, ['headRefOid', 'url']]]);
    assert.match(
      reviewComments(provider)[0],
      /^.*\n\n## 🔬 Code Review — Story #5975\n/s,
    );
    await assert.rejects(
      recordLandReview({
        ...base,
        provider: fakeProvider(),
        gh: { pr: { view: async () => ({}) } },
      }),
      /no headRefOid/,
    );
  });
});

/** Every other tail step stubbed, each pushing its name to `trace`. */
function quietTail(trace) {
  const ok = (name, value) => async () => {
    trace.push(name);
    return value;
  };
  return {
    storyId: STORY,
    storyBranch: `story-${STORY}`,
    baseBranch: 'main',
    cwd: '/nowhere',
    provider: {},
    emitCloseRecoveredFrictionFn: async () => true,
    emitRecoveredFrictionMarkerFn: async () => true,
    captureStoryFollowUpsFn: ok('followUps', { ok: true }),
    reassertStatusColumnFn: ok('statusResync', { status: 'synced' }),
    reapPlanRunLabelsForStoryFn: ok('labelReap', { deleted: [], failed: [] }),
    rollUpEpicForStoryFn: ok('epicRollup', { closed: [], epics: [] }),
    acquireLockWithWaitFn: async () => ({ acquired: false, reason: 'test' }),
    reapWorktreePhaseFn: ok('worktreeReap', { skipped: true }),
    gitSpawnFn: () => ({ status: 0, stdout: '' }),
    planFastForwardFn: () => ({
      runnable: false,
      reason: 'already-up-to-date',
    }),
    executeFastForwardFn: () => ({ applied: false }),
    recordStoryDispositionsFn: ok('reviewDispositions', { ok: true }),
    purgeStoryTempArtifactsFn: ok('tempPurge', { errors: [] }),
    releaseStoryLeaseFn: ok('leaseRelease', { released: true }),
  };
}

describe('runPostLandTail — the review-record step (Story #5975)', () => {
  it('AC-4: records the review before the temp purge, passing the PR through', async () => {
    const trace = [];
    let seen = null;
    const tail = await runPostLandTail({
      ...quietTail(trace),
      prNumber: PR,
      prUrl: PR_URL,
      recordLandReviewFn: async (args) => {
        seen = args;
        trace.push('reviewRecord');
        return { ok: true, detail: 'posted-from-deposit' };
      },
    });
    assert.ok(trace.indexOf('reviewRecord') < trace.indexOf('tempPurge'));
    assert.equal(trace[0], 'reviewRecord');
    assert.equal(seen.prNumber, PR);
    assert.equal(seen.prUrl, PR_URL);
    assert.equal(tail.reviewRecord, true);
    assert.equal(tail.details.reviewRecord, 'posted-from-deposit');
  });

  it('AC-7: a throwing post degrades reviewRecord only; the land stays landed, exit 0', async () => {
    const provider = fakeProvider();
    const tail = await runPostLandTail({
      ...quietTail([]),
      provider,
      prNumber: PR,
      recordLandReviewFn: (args) =>
        recordLandReview({
          ...seams({ provider }),
          ...args,
          upsertStructuredCommentFn: async () => {
            throw new Error('upsert exploded');
          },
        }),
    });
    assert.equal(tail.reviewRecord, false);
    assert.equal(tail.details.reviewRecord, 'upsert exploded');
    const env = buildTerminalEnvelope({
      storyId: STORY,
      status: 'landed',
      phase: 'post-land',
      pr: { number: PR, state: 'MERGED' },
      tail,
      nextCommand: null,
      elapsedSeconds: 1,
    });
    assert.equal(env.status, 'landed');
    assert.equal(exitCodeForTerminal(env), 0);
  });

  it('AC-5: confirmAndLand hands the PR number and URL to the land tail', async () => {
    let seen = null;
    await confirmAndLand({
      storyId: STORY,
      prNumber: PR,
      prUrl: PR_URL,
      cwd: '/nowhere',
      provider: {
        getTicket: async () => ({ labels: ['agent::done'] }),
      },
      storyBranch: `story-${STORY}`,
      baseBranch: 'main',
      runPostLandTailFn: async (args) => {
        seen = args;
        return {};
      },
    });
    assert.equal(seen.prNumber, PR);
    assert.equal(seen.prUrl, PR_URL);
  });
});
