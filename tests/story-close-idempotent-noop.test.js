/**
 * story-close-idempotent-noop.test.js
 *
 * Regression coverage for the story-close.js idempotency bug: re-running
 * `story-close.js` against a Story that is ALREADY `agent::done` /
 * CLOSED (worktree already reaped, branches already merged and deleted)
 * used to regress the ticket — Phase 3's unconditional
 * `transitionToClosing` flipped the label to `agent::closing` and
 * `transitionTicketState` unconditionally sent `state: 'open'` for any
 * non-`agent::done` target, reopening the GitHub issue — *before* the
 * post-merge pipeline even ran. If that pipeline then no-op'd or threw
 * (nothing left to redo — the merge and reap already happened), the
 * Story was left stranded at `agent::closing`/OPEN instead of a safe
 * no-op.
 *
 * `runStoryClose` now short-circuits immediately after `resolveCloseInputs`
 * — before preflight, before the `agent::closing` flip, before the merge
 * lock — when the fetched Story is already `agent::done` AND closed. The
 * "already done" test is an AND (label `agent::done` AND `state ===
 * 'closed'`), mirroring the deepest-level guard in
 * `post-merge/phases/ticket-closure.js`; a closed-issue-alone signal
 * (label still `agent::closing`) must NOT no-op, per the documented
 * PR-footer / partial-close trap in `lib/single-story/confirm-merge.js`.
 * These tests drive the guard directly with a `MockProvider` so no real
 * git repo, worktree, or GitHub API is needed; the guard fires before any
 * of those would be touched.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runStoryClose } from '../.agents/scripts/story-close.js';
import { MockProvider } from './fixtures/mock-provider.js';

function withTempCwd(fn) {
  const dir = mkdtempSync(
    path.join(os.tmpdir(), 'mandrel-story-close-idempotent-'),
  );
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test('runStoryClose is a safe no-op re-run against an already-done, already-closed Story', async () => {
  await withTempCwd(async (cwd) => {
    const provider = new MockProvider({
      tickets: {
        4428: {
          id: 4428,
          title: 'Already-closed Story',
          body: 'Epic: #4425',
          labels: ['type::story', 'persona::engineer', 'agent::done'],
          state: 'closed',
        },
      },
    });

    const { success, result } = await runStoryClose({
      storyId: 4428,
      epicId: 4425,
      cwd,
      injectedProvider: provider,
    });

    assert.equal(
      success,
      true,
      'a re-run against an already-done Story must succeed',
    );
    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'already-done');

    // The defining regression: no label/state mutation and no GitHub
    // reopen must occur. `transitionTicketState` -> `provider.updateTicket`
    // is the only path that could flip the label away from `agent::done`
    // or set `state: 'open'`; asserting it was never called proves the
    // guard fired before Phase 3 (`transitionToClosing`).
    assert.deepEqual(
      provider.updates,
      [],
      'no-op re-run must not call provider.updateTicket at all',
    );

    const ticket = await provider.getTicket(4428);
    assert.deepEqual(ticket.labels, [
      'type::story',
      'persona::engineer',
      'agent::done',
    ]);
    assert.equal(ticket.state, 'closed');
  });
});

test('runStoryClose no-op guard does NOT fire when the issue is closed but the label is still agent::closing (PR-footer / partial-close trap)', async () => {
  // The confirm-merge.js precedent: a Story can arrive at close with the
  // GitHub issue already `state: closed` (closed by a `Closes #<id>` PR
  // footer, or by a prior close that set state:closed but was killed before
  // the label flip) while its label is legitimately still `agent::closing`.
  // Treating that as already-done would skip the `closing → done`
  // re-assertion the re-run exists to perform. The guard must NOT fire —
  // the flow proceeds into Phase 3 and re-asserts the label.
  await withTempCwd(async (cwd) => {
    const provider = new MockProvider({
      tickets: {
        4429: {
          id: 4429,
          title: 'Closed-by-footer, label still closing',
          body: 'Epic: #4425',
          labels: ['type::story', 'persona::engineer', 'agent::closing'],
          state: 'closed',
        },
      },
    });

    // The minimal fixture has no worktree / story branch, so the flow will
    // fail fast downstream; we only assert the no-op guard did NOT swallow
    // it. Proof the guard did not fire: Phase 3 (`transitionToClosing`)
    // ran, which calls `provider.updateTicket` at least once.
    const outcome = await runStoryClose({
      storyId: 4429,
      epicId: 4425,
      cwd,
      injectedProvider: provider,
    }).catch(() => null);

    const wasNoop = outcome?.result?.action === 'noop';
    assert.equal(
      wasNoop,
      false,
      'a closed-but-not-done Story must NOT be treated as an already-done no-op',
    );
    assert.ok(
      provider.updates.length >= 1,
      'the flow must proceed into Phase 3 (transitionToClosing → updateTicket), not short-circuit',
    );
  });
});

test('runStoryClose no-op guard does not fire for a Story still executing (control case)', async () => {
  await withTempCwd(async (cwd) => {
    const provider = new MockProvider({
      tickets: {
        4430: {
          id: 4430,
          title: 'In-flight Story',
          body: 'Epic: #4425',
          labels: ['type::story', 'agent::executing'],
          state: 'open',
        },
      },
    });

    // A real close would proceed into preflight / the merge pipeline and
    // fail fast in this minimal fixture (no worktree, no story branch).
    // We only assert the guard did NOT short-circuit: Phase 3 fired and
    // flipped the label to `agent::closing`, proving `alreadyDone` was
    // correctly false for a non-done Story.
    await runStoryClose({
      storyId: 4430,
      epicId: 4425,
      cwd,
      injectedProvider: provider,
    }).catch(() => {});

    const ticket = await provider.getTicket(4430);
    assert.ok(
      ticket.labels.includes('agent::closing'),
      'a genuinely in-flight Story must still pass through Phase 3 (transitionToClosing)',
    );
  });
});
