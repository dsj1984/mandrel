/**
 * tests/scripts/epic-deliver-reconcile.test.js — Task #2520 (Story #2506,
 * Epic #2501). Fixture-driven coverage for the host-crash watchdog:
 *
 *   1. `reconcileEpicAgentLabels` classifies live / dead / unknown
 *      Stories correctly given a fixture Epic with three children.
 *   2. The CLI helper `runReconcile`:
 *        - posts exactly one friction comment naming the dead Story
 *        - under `--auto-recover` writes a single-entry recovery-plan.json
 *
 * The test uses an in-memory provider stub (no network), a fake
 * `probePid` function (no real process probing), and a `tmpdir`-backed
 * repo root so PID-state fixtures and the recovery-plan write target are
 * fully sandboxed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildRecoveryPlan,
  renderFrictionBody,
  runReconcile,
} from '../../.agents/scripts/epic-deliver-reconcile.js';
import {
  classifyStory,
  readDispatchPid,
  reconcileEpicAgentLabels,
} from '../../.agents/scripts/lib/orchestration/epic-deliver-reconcile.js';

const EPIC_ID = 9001;
const STORY_LIVE = 9101;
const STORY_DEAD = 9102;
const STORY_UNKNOWN = 9103;

const LIVE_PID = 11111;
const DEAD_PID = 22222;

/** Build a minimal Story-shaped ticket fixture. */
function fixtureStory(id, title, label = 'agent::executing') {
  return {
    id,
    title,
    labels: [{ name: 'type::story' }, { name: label }],
  };
}

/** In-memory provider stub exposing `getTickets(parentId)`. */
function fakeProvider(children) {
  return {
    getTickets: async () => children,
  };
}

/** Write a Story's dispatch PID state file under the sandbox repo root. */
function seedPid(repoRoot, epicId, storyId, pid) {
  const dir = path.join(repoRoot, 'temp', `epic-${epicId}`, String(storyId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'story-init.state.json'),
    JSON.stringify({ pid, storyId, recordedAt: new Date().toISOString() }),
    'utf8',
  );
}

/** Fake liveness probe: alive only for LIVE_PID. */
function fakeProbePid(pid) {
  return pid === LIVE_PID;
}

let repoRoot;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('readDispatchPid', () => {
  it('returns the recorded PID when the state file exists', () => {
    seedPid(repoRoot, EPIC_ID, STORY_LIVE, LIVE_PID);
    assert.equal(readDispatchPid(repoRoot, EPIC_ID, STORY_LIVE), LIVE_PID);
  });

  it('returns null when the state file is missing', () => {
    assert.equal(readDispatchPid(repoRoot, EPIC_ID, 9999), null);
  });

  it('returns null when the state file lacks a pid field', () => {
    const dir = path.join(repoRoot, 'temp', `epic-${EPIC_ID}`, '9998');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'story-init.state.json'),
      JSON.stringify({}),
      'utf8',
    );
    assert.equal(readDispatchPid(repoRoot, EPIC_ID, 9998), null);
  });
});

describe('classifyStory', () => {
  it('returns unknown when pid is null', () => {
    const result = classifyStory({ id: 1, title: 't' }, null, () => true);
    assert.equal(result.classification, 'unknown');
    assert.equal(result.pid, null);
  });

  it('returns live when probePid returns true', () => {
    const result = classifyStory({ id: 1, title: 't' }, 42, () => true);
    assert.equal(result.classification, 'live');
  });

  it('returns dead when probePid returns false', () => {
    const result = classifyStory({ id: 1, title: 't' }, 42, () => false);
    assert.equal(result.classification, 'dead');
  });
});

describe('reconcileEpicAgentLabels', () => {
  it('classifies fixture Epic into live / dead / unknown buckets', async () => {
    seedPid(repoRoot, EPIC_ID, STORY_LIVE, LIVE_PID);
    seedPid(repoRoot, EPIC_ID, STORY_DEAD, DEAD_PID);
    // STORY_UNKNOWN intentionally has no PID file.

    const provider = fakeProvider([
      fixtureStory(STORY_LIVE, 'Story alive'),
      fixtureStory(STORY_DEAD, 'Story dead'),
      fixtureStory(STORY_UNKNOWN, 'Story unknown'),
    ]);

    const result = await reconcileEpicAgentLabels({
      epicId: EPIC_ID,
      provider,
      repoRoot,
      probePid: fakeProbePid,
    });

    assert.equal(result.epicId, EPIC_ID);
    assert.equal(result.live.length, 1);
    assert.equal(result.live[0].id, STORY_LIVE);
    assert.equal(result.dead.length, 1);
    assert.equal(result.dead[0].id, STORY_DEAD);
    assert.equal(result.dead[0].pid, DEAD_PID);
    assert.equal(result.unknown.length, 1);
    assert.equal(result.unknown[0].id, STORY_UNKNOWN);
  });

  it('skips children that do not carry agent::executing or agent::closing', async () => {
    seedPid(repoRoot, EPIC_ID, STORY_DEAD, DEAD_PID);
    const provider = fakeProvider([
      fixtureStory(STORY_DEAD, 'dead', 'agent::executing'),
      { id: 9200, title: 'done story', labels: [{ name: 'agent::done' }] },
      { id: 9201, title: 'ready story', labels: [{ name: 'agent::ready' }] },
    ]);

    const result = await reconcileEpicAgentLabels({
      epicId: EPIC_ID,
      provider,
      repoRoot,
      probePid: fakeProbePid,
    });

    assert.equal(result.dead.length, 1);
    assert.equal(result.live.length, 0);
    assert.equal(result.unknown.length, 0);
  });

  it('includes agent::closing children alongside agent::executing', async () => {
    seedPid(repoRoot, EPIC_ID, STORY_DEAD, DEAD_PID);
    const provider = fakeProvider([
      fixtureStory(STORY_DEAD, 'closing story', 'agent::closing'),
    ]);

    const result = await reconcileEpicAgentLabels({
      epicId: EPIC_ID,
      provider,
      repoRoot,
      probePid: fakeProbePid,
    });

    assert.equal(result.dead.length, 1);
    assert.equal(result.dead[0].id, STORY_DEAD);
  });

  it('throws on invalid epicId', async () => {
    await assert.rejects(
      reconcileEpicAgentLabels({
        epicId: 0,
        provider: fakeProvider([]),
        repoRoot,
      }),
      /epicId must be a positive integer/,
    );
  });
});

describe('renderFrictionBody', () => {
  it('names dead and unknown Stories in the rendered body', () => {
    const body = renderFrictionBody({
      epicId: EPIC_ID,
      dead: [{ id: STORY_DEAD, title: 'dead one', pid: DEAD_PID }],
      unknown: [{ id: STORY_UNKNOWN, title: 'unknown one', pid: null }],
      live: [{ id: STORY_LIVE, title: 'live one', pid: LIVE_PID }],
    });
    assert.match(body, /Epic #9001/);
    assert.match(body, /#9102/);
    assert.match(body, /#9103/);
    assert.match(body, /pid 22222/);
    assert.match(body, /no PID recorded/);
  });
});

describe('buildRecoveryPlan', () => {
  it('emits one entry per dead Story', () => {
    const plan = buildRecoveryPlan({
      epicId: EPIC_ID,
      dead: [{ id: STORY_DEAD, title: 'dead one', pid: DEAD_PID }],
      unknown: [],
      live: [],
    });
    assert.equal(plan.epicId, EPIC_ID);
    assert.equal(plan.recover.length, 1);
    assert.equal(plan.recover[0].storyId, STORY_DEAD);
    assert.equal(plan.recover[0].lastPid, DEAD_PID);
    assert.equal(plan.recover[0].reason, 'dispatch-pid-dead');
  });
});

describe('runReconcile (CLI core)', () => {
  it('posts exactly one friction comment naming the dead Story', async () => {
    seedPid(repoRoot, EPIC_ID, STORY_LIVE, LIVE_PID);
    seedPid(repoRoot, EPIC_ID, STORY_DEAD, DEAD_PID);
    const provider = fakeProvider([
      fixtureStory(STORY_LIVE, 'live'),
      fixtureStory(STORY_DEAD, 'dead'),
      fixtureStory(STORY_UNKNOWN, 'unknown'),
    ]);
    const posted = [];
    const postComment = async (ticketId, type, body) => {
      posted.push({ ticketId, type, body });
    };

    const envelope = await runReconcile({
      epicId: EPIC_ID,
      provider,
      repoRoot,
      probePid: fakeProbePid,
      postComment,
    });

    assert.equal(posted.length, 1);
    assert.equal(posted[0].ticketId, EPIC_ID);
    assert.equal(posted[0].type, 'friction');
    assert.match(posted[0].body, /#9102/);
    assert.equal(envelope.dead.length, 1);
    assert.equal(envelope.recoveryPlanPath, null);
  });

  it('writes a single-entry recovery-plan.json under --auto-recover', async () => {
    seedPid(repoRoot, EPIC_ID, STORY_DEAD, DEAD_PID);
    seedPid(repoRoot, EPIC_ID, STORY_LIVE, LIVE_PID);
    const provider = fakeProvider([
      fixtureStory(STORY_LIVE, 'live'),
      fixtureStory(STORY_DEAD, 'dead'),
    ]);
    const postComment = async () => {};

    const envelope = await runReconcile({
      epicId: EPIC_ID,
      provider,
      repoRoot,
      autoRecover: true,
      probePid: fakeProbePid,
      postComment,
    });

    assert.ok(envelope.recoveryPlanPath, 'recoveryPlanPath should be set');
    const planRaw = fs.readFileSync(envelope.recoveryPlanPath, 'utf8');
    const plan = JSON.parse(planRaw);
    assert.equal(plan.epicId, EPIC_ID);
    assert.equal(plan.recover.length, 1);
    assert.equal(plan.recover[0].storyId, STORY_DEAD);
    assert.equal(plan.recover[0].lastPid, DEAD_PID);
  });
});
