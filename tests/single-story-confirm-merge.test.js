/**
 * tests/single-story-confirm-merge.test.js — coverage for the post-merge
 * confirmation path of the standalone close (Story #3385).
 *
 * `single-story-close.js` now rests a standalone Story at `agent::closing`
 * with its GitHub issue OPEN while the PR is open with auto-merge armed.
 * The `agent::done` flip (which closes the issue) is deferred to
 * `confirmStoryMerged` / `single-story-confirm-merge.js`, driven by the
 * CI-watch loop once the PR merge is confirmed.
 *
 * This file exercises the state-machine contract directly against the
 * pure `confirmStoryMerged` helper (no subprocess, no real `gh`):
 *
 *   - PR merged  → `executing|closing → done`, issue closes, story-merged
 *     notify fires once.
 *   - PR open    → stays `agent::closing`, issue stays OPEN, no done flip.
 *   - PR closed-without-merge → stays `agent::closing`, issue stays OPEN.
 *   - already-done / already-closed → idempotent noop.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, it } from 'node:test';

import { recordRequiredRed } from '../.agents/scripts/lib/orchestration/ci-red-handling.js';
import { readCiDigest } from '../.agents/scripts/lib/orchestration/ci-rerun-guard.js';
import {
  resolveAdvisoryRerunAllowance,
  resolveMergeWaitConfig,
  runConfirmMergePhase,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js';
import { confirmStoryMerged } from '../.agents/scripts/lib/single-story/confirm-merge.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import {
  resolvePrNumber,
  runConfirmMerge,
} from '../.agents/scripts/single-story-confirm-merge.js';

/** The done-flip back-off `flipDone` sleeps between attempts. */
const DONE_FLIP_RETRY_DELAYS_MS = [500, 2000];

/**
 * Fake ticketing provider. Records every `updateTicket` patch and applies
 * it to the in-memory story so subsequent reads reflect the flip.
 */
function makeFakeProvider({
  initialStory = {
    id: 3385,
    state: 'open',
    title: 'Confirm merge story',
    labels: ['agent::closing'],
  },
  updateThrows = false,
  // Story #5520 — fail only the first N writes (a transient label API fault).
  updateFailures = 0,
} = {}) {
  let story = { ...initialStory };
  const updates = [];
  let failuresLeft = updateFailures;
  return {
    getTicket: async () => ({ ...story }),
    updateTicket: async (id, patch) => {
      updates.push({ id, patch });
      if (updateThrows) throw new Error('provider failure');
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('labels API 502');
      }
      const labels = patch.labels
        ? [
            ...(story.labels ?? []).filter(
              (l) => !(patch.labels.remove ?? []).includes(l),
            ),
            ...(patch.labels.add ?? []),
          ]
        : story.labels;
      story = {
        ...story,
        ...(patch.state ? { state: patch.state } : {}),
        labels,
      };
    },
    _story: () => story,
    _updates: () => updates,
  };
}

/** A `readPrMergeStateFn` stub that returns a fixed PR state. */
function fakeMergeState(state, mergedAt = null) {
  return async () => ({ state, mergedAt });
}

describe('confirmStoryMerged', () => {
  it('flips agent::closing → agent::done and closes the issue when the PR is MERGED', async () => {
    const provider = makeFakeProvider();
    const notifyCalls = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      cwd: '/repo',
      injectedNotify: async (ticketId, payload) =>
        notifyCalls.push({ ticketId, payload }),
      readPrMergeStateFn: fakeMergeState('MERGED', '2026-05-31T00:00:00Z'),
    });

    assert.equal(result.action, 'done');
    assert.equal(result.merged, true);

    // The flip routes through transitionTicketState — the patch closes the
    // issue (`state: 'closed'`, `state_reason: 'completed'`) on the
    // agent::done transition.
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::done']);
    assert.ok(patch.labels.remove.includes('agent::closing'));
    assert.equal(patch.state, 'closed');
    assert.equal(patch.state_reason, 'completed');

    // story-merged notify fires exactly once.
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].payload.event, 'story-merged');
    assert.equal(notifyCalls[0].payload.level, 'story');
    assert.match(notifyCalls[0].payload.message, /agent::done/);
  });

  it('treats a non-null mergedAt as merged even when state is not literally MERGED', async () => {
    const provider = makeFakeProvider();
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {},
      readPrMergeStateFn: fakeMergeState(null, '2026-05-31T00:00:00Z'),
    });
    assert.equal(result.action, 'done');
    assert.equal(result.merged, true);
  });

  it('leaves the Story at agent::closing and issue OPEN when the PR is still open', async () => {
    const provider = makeFakeProvider();
    const notifyCalls = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async (...a) => notifyCalls.push(a),
      readPrMergeStateFn: fakeMergeState('OPEN'),
    });

    assert.equal(result.action, 'pending');
    assert.equal(result.reason, 'pr-open');
    assert.equal(result.merged, false);
    // No flip — issue stays OPEN at agent::closing.
    assert.equal(provider._updates().length, 0);
    assert.equal(provider._story().state, 'open');
    assert.deepEqual(provider._story().labels, ['agent::closing']);
    assert.equal(notifyCalls.length, 0);
  });

  it('leaves the Story at agent::closing when the PR was closed without merging', async () => {
    const provider = makeFakeProvider();
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {},
      readPrMergeStateFn: fakeMergeState('CLOSED'),
    });

    assert.equal(result.action, 'pending');
    assert.equal(result.reason, 'pr-not-merged');
    assert.equal(result.merged, false);
    assert.equal(provider._updates().length, 0);
    assert.equal(provider._story().state, 'open');
  });

  it('is idempotent: noop when the Story already carries agent::done', async () => {
    const provider = makeFakeProvider({
      initialStory: {
        id: 3385,
        state: 'closed',
        title: 'Already done',
        labels: ['agent::done'],
      },
    });
    let prRead = 0;
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {},
      readPrMergeStateFn: async () => {
        prRead += 1;
        return { state: 'MERGED', mergedAt: 'x' };
      },
    });

    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'already-done');
    assert.equal(result.merged, true);
    assert.equal(provider._updates().length, 0, 'no re-flip on noop');
    assert.equal(prRead, 0, 'PR state is not even read once already done');
  });

  it('is idempotent: noop when a closed issue also carries agent::done', async () => {
    const provider = makeFakeProvider({
      initialStory: {
        id: 3385,
        state: 'closed',
        title: 'Already done and closed',
        labels: ['agent::done'],
      },
    });
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {},
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
    });
    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'already-done');
    assert.equal(provider._updates().length, 0, 'no re-flip on noop');
  });

  it('still flips to agent::done when the Closes-footer already closed the issue but the label is agent::closing (Story #3415)', async () => {
    // Reproduces Story #3413 / PR #3414: GitHub auto-merge closes the issue
    // via the `Closes #<id>` footer *before* confirm-merge runs, so the
    // story arrives here with `state: 'closed'` while the label is still
    // `agent::closing`. A closed issue alone must NOT short-circuit — the
    // `agent::closing → agent::done` flip must still fire.
    const provider = makeFakeProvider({
      initialStory: {
        id: 3385,
        state: 'closed',
        title: 'Auto-closed by Closes-footer',
        labels: ['agent::closing'],
      },
    });
    const notifyCalls = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      cwd: '/repo',
      injectedNotify: async (ticketId, payload) =>
        notifyCalls.push({ ticketId, payload }),
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
    });

    // The flip fires (NOT a noop) even though the issue was already closed.
    assert.equal(result.action, 'done');
    assert.equal(result.merged, true);

    // transitionTicketState was invoked and applied the agent::done flip.
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::done']);
    assert.ok(patch.labels.remove.includes('agent::closing'));

    // story-merged notify fires exactly once.
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].payload.event, 'story-merged');
  });

  it('reports flip-failed and skips the notify when every bounded attempt throws', async () => {
    const provider = makeFakeProvider({ updateThrows: true });
    const notifyCalls = [];
    const slept = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async (...a) => notifyCalls.push(a),
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
      sleepFn: async (ms) => slept.push(ms),
    });

    assert.equal(result.action, 'flip-failed');
    // Story #5520 AC-6 — bounded: one attempt plus one per backoff step.
    assert.deepEqual(slept, [...DONE_FLIP_RETRY_DELAYS_MS]);
    assert.equal(
      provider._updates().length,
      DONE_FLIP_RETRY_DELAYS_MS.length + 1,
    );
    assert.equal(result.merged, true);
    assert.equal(
      notifyCalls.length,
      0,
      'notify must not fire on a failed flip',
    );
  });

  // Story #5520 AC-6 — a transient label fault that clears on retry lands done.
  it('retries a failed done flip and reports done when a retry succeeds', async () => {
    const provider = makeFakeProvider({ updateFailures: 1 });
    const notifyCalls = [];
    const slept = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async (...a) => notifyCalls.push(a),
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
      sleepFn: async (ms) => slept.push(ms),
    });
    assert.equal(result.action, 'done');
    assert.deepEqual(slept, [DONE_FLIP_RETRY_DELAYS_MS[0]]);
    assert.ok(provider._story().labels.includes('agent::done'));
    assert.equal(notifyCalls.length, 1, 'the merged notify fires once');
  });

  it('swallows notify failures and still reports done', async () => {
    const provider = makeFakeProvider();
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {
        throw new Error('webhook offline');
      },
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
    });
    assert.equal(result.action, 'done');
    assert.equal(provider._story().state, 'closed');
  });

  it('propagates a transient PR-read failure so the CLI can report it (Story #4543)', async () => {
    // The PR read is a live `gh` call. It throws on a transient API error, and
    // this is a landing surface — the one `pending` tells the operator to
    // re-run. The library propagates (a flaked read must not look like a
    // verdict); the CLI boundary turns it into a `failed` envelope so the
    // surface is never silent. Pin the propagation the CLI relies on.
    await assert.rejects(
      () =>
        confirmStoryMerged({
          provider: makeFakeProvider(),
          storyId: 3385,
          prNumber: 42,
          cwd: '/repo',
          readPrMergeStateFn: async () => {
            throw new Error('gh-exec: resource not found');
          },
        }),
      /resource not found/,
    );
  });
});

describe('single-story-confirm-merge --max-wait-seconds (Story #4710 AC-3)', () => {
  // The resume CLI is the exact command async mode's `pending` terminal hands
  // the merge wait to. Without this flag the documented per-run wait override
  // was unreachable on the resume path, so a slow-CI landing depended on an
  // unbounded chain of short invocations.
  it('threads the override to the merge-wait phase, where resolveMergeWaitConfig lets it win', async () => {
    const calls = [];
    await runConfirmMerge({
      storyId: 555,
      cwd: '/repo',
      pr: 77,
      wait: true,
      maxWaitSeconds: 45,
      injectedProvider: {
        getTicket: async () => ({
          id: 555,
          state: 'open',
          labels: ['agent::closing'],
        }),
        updateTicket: async () => {},
      },
      injectedConfig: {
        project: { baseBranch: 'main', paths: { tempRoot: 'temp' } },
        github: { owner: 'o', repo: 'r' },
      },
      injectedGh: {
        pr: { list: async () => [{ number: 77, url: 'https://e/pull/77' }] },
      },
      injectedNotify: async () => {},
      runConfirmMergePhaseFn: async (args) => {
        calls.push(args);
        return {
          confirmed: false,
          terminal: 'pending',
          waitBudget: {
            maxWaitSeconds: 45,
            waitedSeconds: 45,
            cumulativeSeconds: 45,
            maxBudgetSeconds: 3600,
          },
          prProbe: { state: 'OPEN', checksStatus: 'still-running' },
        };
      },
    });

    assert.equal(calls.length, 1, 'the wait phase must run');
    assert.equal(
      calls[0].maxWaitSeconds,
      45,
      'the override must reach the phase (and thence resolveMergeWaitConfig)',
    );
    // The phase resolves the override through resolveMergeWaitConfig exactly
    // as close does — the per-run value beats the config and the async cap.
    const resolved = resolveMergeWaitConfig(
      { delivery: { mergeWatch: { mode: 'async', maxWaitSeconds: 300 } } },
      calls[0].maxWaitSeconds,
    );
    assert.equal(resolved.maxWaitSeconds, 45);
  });
});

describe('resolvePrNumber — the gh pr list probe (Story #4842)', () => {
  function ghWithRows(rows) {
    return { pr: { list: async () => rows } };
  }

  it('returns the first row number when it is a valid PR number', async () => {
    const n = await resolvePrNumber({
      storyBranch: 'story-1',
      gh: ghWithRows([{ number: 77, url: 'https://github.com/o/r/pull/77' }]),
    });
    assert.equal(n, 77);
  });

  it('falls back to parsing the PR url when the number field is unusable', async () => {
    const n = await resolvePrNumber({
      storyBranch: 'story-1',
      gh: ghWithRows([{ url: 'https://github.com/o/r/pull/88' }]),
    });
    assert.equal(n, 88);
  });

  it('returns null when no PR exists for the branch', async () => {
    assert.equal(
      await resolvePrNumber({ storyBranch: 'story-1', gh: ghWithRows([]) }),
      null,
    );
    assert.equal(
      await resolvePrNumber({
        storyBranch: 'story-1',
        gh: ghWithRows(undefined),
      }),
      null,
    );
  });

  it('degrades to null instead of throwing when the probe fails', async () => {
    const gh = {
      pr: {
        list: async () => {
          throw new Error('gh exploded');
        },
      },
    };
    assert.equal(await resolvePrNumber({ storyBranch: 'story-1', gh }), null);
  });
});

describe('resolveAdvisoryRerunAllowance (Story #5266)', () => {
  it('is 0 with no flag and no configuration — close spends nothing unasked', () => {
    assert.equal(resolveAdvisoryRerunAllowance(undefined, undefined), 0);
    assert.equal(resolveAdvisoryRerunAllowance({}, undefined), 0);
    assert.equal(
      resolveAdvisoryRerunAllowance({ delivery: { ci: {} } }, undefined),
      0,
    );
  });

  it('reads delivery.ci.rerunAdvisory when no flag is supplied', () => {
    assert.equal(
      resolveAdvisoryRerunAllowance(
        { delivery: { ci: { rerunAdvisory: 2 } } },
        undefined,
      ),
      2,
    );
  });

  it('lets the flag win over the config, including an explicit 0', () => {
    const config = { delivery: { ci: { rerunAdvisory: 3 } } };
    assert.equal(resolveAdvisoryRerunAllowance(config, 1), 1);
    assert.equal(resolveAdvisoryRerunAllowance(config, 0), 0);
  });

  it('degrades a junk or negative value to the config rather than guessing', () => {
    const config = { delivery: { ci: { rerunAdvisory: 2 } } };
    assert.equal(resolveAdvisoryRerunAllowance(config, -1), 2);
    assert.equal(resolveAdvisoryRerunAllowance(config, Number.NaN), 2);
    assert.equal(
      resolveAdvisoryRerunAllowance(
        { delivery: { ci: { rerunAdvisory: -5 } } },
        undefined,
      ),
      0,
    );
  });
});

describe('merge wait — a merge-queue ejection', () => {
  const RUN = {
    id: 9001,
    name: 'CI',
    url: 'https://github.com/o/r/actions/runs/9001',
    conclusion: 'failure',
  };
  const ejectedProbe = (overrides = {}) => ({
    state: 'OPEN',
    mergedAt: null,
    createdAt: null,
    checksStatus: 'success',
    inMergeQueue: false,
    autoMergeArmed: false,
    headSha: 'head-6060',
    redHeadRuns: [],
    ...overrides,
  });
  const ejection = (verdict, id = RUN.id) => ({
    verdict,
    labels: ['hold'],
    run: { ...RUN, id },
    failedJobs: verdict === 'own' ? ['test (ubuntu)', 'lint'] : [],
  });

  /** Next scripted read; the last one repeats. */
  const next = (list, fallback) =>
    list.length > 1 ? list.shift() : (list[0] ?? fallback);

  /** Phase args over scripted probes and ejection reads. */
  function ejectionArgs({ probes, ejections = [], vetoHeld = false, ...rest }) {
    const h = { rearms: [], reads: [], comments: [], emitted: [] };
    let clock = 0;
    h.args = {
      cwd: '.',
      storyId: 6060,
      storyBranch: 'story-6060',
      baseBranch: 'main',
      prNumber: 77,
      prUrl: 'https://github.com/o/r/pull/77',
      autoMergeEnabled: true,
      closeArmed: true,
      config: {},
      provider: {
        ...makeFakeProvider({ initialStory: { id: 6060, labels: [] } }),
        postComment: async (_id, payload) => {
          h.comments.push(payload.body);
          return { id: 'c1' };
        },
      },
      sleepFn: async () => {},
      nowMsFn: () => {
        clock += 40_000;
        return clock;
      },
      emitMergeUnlandedFn: (event) => h.emitted.push(event),
      disarmAutoMergeFn: async () => ({
        disarmed: true,
        alreadyUnarmed: true,
        detail: 'already un-armed',
      }),
      confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      runPostLandTailFn: async () => ({ details: {} }),
      readPrWaitProbeFn: async () => next(probes),
      readQueueEjectionFn: async (args) => {
        h.reads.push(args);
        return next(ejections, { verdict: null, labels: [] });
      },
      releaseVetoFn: () => vetoHeld,
      recoverySeams: {
        readCiDigestFn: () => null,
        rearmAutoMergeFn: async () => {
          h.rearms.push(1);
          return { enabled: true };
        },
      },
      ...rest,
    };
    return h;
  }

  it('AC-1: re-arms a second inherited ejection on one head with a different run', async () => {
    const h = ejectionArgs({
      probes: [
        ejectedProbe(),
        ejectedProbe(),
        { state: 'MERGED', mergedAt: 'x' },
      ],
      ejections: [ejection('inherited', 1), ejection('inherited', 2)],
      // The real veto check: no releaseVeto configured, so nothing is held.
      releaseVetoFn: undefined,
    });
    const outcome = await runConfirmMergePhase(h.args);
    assert.equal(outcome.terminal, 'landed');
    assert.equal(h.rearms.length, 2);
  });

  it('AC-2: settles queue-ejected on that probe, its digest naming the queue run and failed jobs', async () => {
    const tempRoot = makeTempDir('mandrel-6060-');
    try {
      const h = ejectionArgs({
        probes: [ejectedProbe()],
        ejections: [ejection('own')],
        cwd: tempRoot,
        config: { project: { paths: { tempRoot } } },
        recordRequiredRedFn: (args) =>
          recordRequiredRed({
            ...args,
            writeDigestFn: (w) =>
              args.writeDigestFn({ ...w, logTailFn: () => 'Error: boom\n' }),
          }),
      });
      const outcome = await runConfirmMergePhase(h.args);
      assert.equal(outcome.terminal, 'blocked');
      assert.equal(outcome.blockClass, 'queue-ejected');
      assert.equal(h.emitted[0].blockClass, 'queue-ejected');
      assert.equal(h.rearms.length, 0);
      const digest = readCiDigest({ storyId: 6060, tempRoot, cwd: tempRoot });
      assert.equal(digest.runUrl, RUN.url);
      assert.deepEqual(
        digest.allFailures.map((f) => f.name),
        ['test (ubuntu)', 'lint'],
      );
      assert.match(
        h.comments[0],
        /queue run https:\/\/github\.com\/o\/r\/actions\/runs\/9001/,
      );
      assert.match(h.comments[0], /story-handoff\.js --story 6060/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('AC-4: an unknown ejection keeps one re-arm per head, then pending', async () => {
    const h = ejectionArgs({
      probes: [ejectedProbe(), ejectedProbe()],
      ejections: [
        { verdict: 'unknown', labels: [] },
        { verdict: 'unknown', labels: [] },
      ],
      mergeWatchMode: 'async',
    });
    const outcome = await runConfirmMergePhase(h.args);
    assert.equal(outcome.terminal, 'pending');
    assert.equal(h.rearms.length, 1);
  });

  it('AC-4: over REST (queue membership unread) no ejection is read', async () => {
    const h = ejectionArgs({
      probes: [ejectedProbe({ inMergeQueue: undefined })],
      mergeWatchMode: 'async',
    });
    const outcome = await runConfirmMergePhase(h.args);
    assert.equal(outcome.terminal, 'pending');
    assert.equal(h.reads.length, 0);
    assert.equal(h.rearms.length, 1);
  });

  it('AC-5: never re-arms under a held veto, under strict, or for a PR close did not arm', async () => {
    const cases = [
      { vetoHeld: true },
      { config: { delivery: { ci: { autoMerge: 'strict' } } } },
      { closeArmed: false },
    ];
    for (const opts of cases) {
      const h = ejectionArgs({
        probes: [ejectedProbe()],
        ejections: [ejection('inherited')],
        mergeWatchMode: 'async',
        ...opts,
      });
      const outcome = await runConfirmMergePhase(h.args);
      assert.equal(outcome.terminal, 'pending', JSON.stringify(opts));
      assert.equal(h.rearms.length, 0, JSON.stringify(opts));
    }
  });
});
