/**
 * tests/scripts/epic-deliver-reconcile.dead-classification.test.js —
 * Story #2535 (Epic #2527, Task #2543).
 *
 * Integration test that proves the host-crash watchdog now classifies
 * a Story whose recorded dispatch PID has been killed as `dead` rather
 * than `unknown`. Before Story #2535 landed, every Story classified as
 * `unknown` because nothing wrote a PID into
 * `temp/epic-<id>/<storyId>/story-init.state.json`. With the
 * `dispatch-state-writer` writing the file at story-init time, the
 * reconciler's `defaultProbePid` (which uses `process.kill(pid, 0)`)
 * now has a real signal to probe.
 *
 * The test exercises the full producer ↔ consumer contract:
 *
 *   1. Spawn a short-lived child Node process and capture its PID.
 *   2. Wait for the child to exit so its PID is definitively reapable
 *      (cross-platform: on POSIX we await `exit`; on Windows the same
 *      `exit` listener fires when the process handle is gone).
 *   3. Call `writeDispatchStateFile` (the production writer) to record
 *      that PID under a sandboxed `temp/` tree.
 *   4. Run `reconcileEpicAgentLabels` with the *real* `defaultProbePid`
 *      (no fake) and assert the fixture Story lands in the `dead`
 *      bucket, not `unknown`.
 *
 * Using the real probe — not a fake — is what makes this an integration
 * test rather than a unit test: it pins the cross-platform `process.kill
 * (pid, 0)` semantics that the watchdog ultimately relies on.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  defaultProbePid,
  reconcileEpicAgentLabels,
} from '../../.agents/scripts/lib/orchestration/epic-deliver-reconcile.js';
import { writeDispatchStateFile } from '../../.agents/scripts/lib/story-init/dispatch-state-writer.js';

const EPIC_ID = 8001;
const STORY_DEAD = 8101;
const STORY_UNKNOWN = 8102;

function fixtureStory(id, title, label = 'agent::executing') {
  return {
    id,
    title,
    labels: [{ name: 'type::story' }, { name: label }],
  };
}

function fakeProvider(children) {
  return {
    getTickets: async () => children,
  };
}

/**
 * Spawn a Node child that exits immediately, wait for it to exit, and
 * return the (now reapable) PID. The race-free signal we depend on is
 * the `exit` event: when it fires, the OS-level process is gone and
 * `process.kill(pid, 0)` will report ESRCH (or the Windows equivalent,
 * which Node maps to a thrown error other than EPERM).
 */
async function spawnAndKill() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '"setTimeout(()=>{},10)"'], {
      stdio: 'ignore',
      shell: false,
    });
    const pid = child.pid;
    if (!pid) {
      reject(new Error('Failed to spawn child — no PID returned'));
      return;
    }
    child.on('error', reject);
    child.on('exit', () => resolve(pid));
  });
}

let repoRoot;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-classify-test-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('reconcileEpicAgentLabels (integration) — dead vs unknown', () => {
  it('classifies a Story whose recorded dispatchPid has died as dead', async () => {
    // Arrange — spawn a child and wait for it to exit so its PID is
    // observably dead. Record that PID via the production writer.
    const deadPid = await spawnAndKill();

    // Sanity-check the real probe agrees the PID is gone before we drive
    // the reconciler. If this fails the test below is meaningless.
    assert.equal(
      defaultProbePid(deadPid),
      false,
      `precondition: spawned PID ${deadPid} must be reported dead by defaultProbePid`,
    );

    writeDispatchStateFile({
      repoRoot,
      epicId: EPIC_ID,
      storyId: STORY_DEAD,
      branch: `story-${STORY_DEAD}`,
      worktreePath: path.join(repoRoot, '.worktrees', `story-${STORY_DEAD}`),
      dispatchPid: deadPid,
    });
    // STORY_UNKNOWN deliberately gets no state file — it must remain
    // unknown so we prove the dead bucket is non-empty *and* distinct
    // from the unknown bucket.

    const provider = fakeProvider([
      fixtureStory(STORY_DEAD, 'killed dispatcher'),
      fixtureStory(STORY_UNKNOWN, 'no pid recorded'),
    ]);

    // Act — drive the reconciler with the *real* default probe.
    const result = await reconcileEpicAgentLabels({
      epicId: EPIC_ID,
      provider,
      repoRoot,
    });

    // Assert — the dead-not-unknown contract this Story exists to
    // establish.
    assert.equal(result.dead.length, 1, 'exactly one dead Story expected');
    assert.equal(
      result.dead[0].id,
      STORY_DEAD,
      'dead bucket must name STORY_DEAD',
    );
    assert.equal(
      result.dead[0].pid,
      deadPid,
      'dead-classification must carry the recorded dispatchPid',
    );
    assert.equal(result.unknown.length, 1, 'STORY_UNKNOWN stays unknown');
    assert.equal(result.unknown[0].id, STORY_UNKNOWN);
    assert.equal(result.live.length, 0, 'no Stories should classify live');
  });

  it('reads the canonical dispatchPid field name written by story-init', async () => {
    // Arrange — write through the production writer and inspect the
    // on-disk payload to confirm we are emitting `dispatchPid`, not a
    // legacy field name. This pins the contract for the reconciler.
    const deadPid = await spawnAndKill();
    const writeResult = writeDispatchStateFile({
      repoRoot,
      epicId: EPIC_ID,
      storyId: STORY_DEAD,
      branch: `story-${STORY_DEAD}`,
      worktreePath: '/wt',
      dispatchPid: deadPid,
    });
    const onDisk = JSON.parse(fs.readFileSync(writeResult.path, 'utf8'));
    assert.equal(onDisk.dispatchPid, deadPid);
    assert.equal(typeof onDisk.startedAt, 'string');
    assert.equal(onDisk.branch, `story-${STORY_DEAD}`);
    assert.equal(onDisk.worktreePath, '/wt');

    // Act + Assert — and the reconciler picks it up via the canonical
    // field name (not the legacy `pid` fallback).
    const provider = fakeProvider([fixtureStory(STORY_DEAD, 'killed')]);
    const result = await reconcileEpicAgentLabels({
      epicId: EPIC_ID,
      provider,
      repoRoot,
    });
    assert.equal(result.dead.length, 1);
    assert.equal(result.dead[0].pid, deadPid);
  });
});
