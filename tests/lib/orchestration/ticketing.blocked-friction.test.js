/**
 * Story #4578 — an `agent::blocked` transition MUST leave a `friction`
 * record in the Story's signals stream.
 *
 * `agent::blocked` is the single runtime HITL pause point, and
 * `transitionTicketState` is its canonical mutator — so this one hook is
 * what makes a parked worker visible to the retro regardless of which path
 * parked it. Before this, a block was only ever a *label*: a run could park
 * a worker and still produce a zero-signal roll-up.
 *
 * The emit MUST also be unable to break the transition it observes
 * (`signals-writer.js`'s best-effort contract; `docs/patterns.md` friction
 * pattern) — the label flip is the thing that matters.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { RUNTIME_FRICTION_CATEGORIES } from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import { forEachLine } from '../../../.agents/scripts/lib/observability/signals-writer.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from '../../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Absolute, per-test tempRoot. Never the shared main-checkout `temp/` — a
 * test that writes there poisons real state for concurrent work.
 */
let tempRoot;
let config;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'blocked-friction-'));
  config = { project: { paths: { tempRoot } } };
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function buildFakeProvider(labels = ['agent::executing']) {
  const updates = [];
  return {
    updates,
    async getTicket(id) {
      return { id, title: 'fixture', labels: [...labels], body: '' };
    },
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
    },
  };
}

/** Stub the board sync away — it is not under test and would hit GraphQL. */
const noopColumnSync = () => ({ sync: async () => ({}) });

async function readSignals(storyId) {
  const rows = [];
  await forEachLine(null, storyId, (p) => rows.push(p), config);
  return rows;
}

describe('agent::blocked → friction signal (Story #4578)', () => {
  it('emits a friction record when a Story parks at agent::blocked', async () => {
    const provider = buildFakeProvider();
    await transitionTicketState(provider, 4578, STATE_LABELS.BLOCKED, {
      config,
      cascade: false,
      _makeColumnSync: noopColumnSync,
    });

    const rows = await readSignals(4578);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'friction');
    assert.equal(rows[0].category, RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED);
    assert.equal(rows[0].storyId, 4578);
    assert.equal(rows[0].emitter.tool, 'transitionTicketState');
    assert.equal(rows[0].details.toState, STATE_LABELS.BLOCKED);
  });

  it('emits nothing for the non-blocked transitions', async () => {
    const provider = buildFakeProvider();
    for (const state of [
      STATE_LABELS.EXECUTING,
      STATE_LABELS.READY,
      STATE_LABELS.DONE,
    ]) {
      await transitionTicketState(provider, 4579, state, {
        config,
        cascade: false,
        _makeColumnSync: noopColumnSync,
      });
    }
    assert.equal((await readSignals(4579)).length, 0);
  });

  it('still flips the label when the signal write is broken', async () => {
    // tempRoot points at a FILE, so every append genuinely fails.
    const filePath = path.join(tempRoot, 'not-a-dir');
    await fs.writeFile(filePath, 'x', 'utf8');
    const provider = buildFakeProvider();

    await transitionTicketState(provider, 4580, STATE_LABELS.BLOCKED, {
      config: { project: { paths: { tempRoot: filePath } } },
      cascade: false,
      _makeColumnSync: noopColumnSync,
    });

    // The transition — the thing that actually matters — is unharmed.
    assert.equal(provider.updates.length, 1);
    assert.deepEqual(provider.updates[0].mutations.labels.add, [
      STATE_LABELS.BLOCKED,
    ]);
  });
});

describe('agent::blocked → active recovery marker (Story #4622)', () => {
  for (const target of [STATE_LABELS.EXECUTING, STATE_LABELS.READY]) {
    it(`emits a recovered story-blocked marker on blocked → ${target}`, async () => {
      const provider = buildFakeProvider(['agent::blocked']);
      await transitionTicketState(provider, 4622, target, {
        config,
        cascade: false,
        _makeColumnSync: noopColumnSync,
      });

      const rows = await readSignals(4622);
      assert.equal(rows.length, 1, 'exactly one recovery marker');
      assert.equal(rows[0].category, RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED);
      assert.equal(rows[0].details.recovered, true);
      assert.equal(rows[0].details.fromState, STATE_LABELS.BLOCKED);
      assert.equal(rows[0].details.toState, target);
    });
  }

  it('does NOT emit a recovery marker on blocked → done (a terminal outcome, not a recovery)', async () => {
    const provider = buildFakeProvider(['agent::blocked']);
    await transitionTicketState(provider, 4624, STATE_LABELS.DONE, {
      config,
      cascade: false,
      _makeColumnSync: noopColumnSync,
    });
    assert.equal((await readSignals(4624)).length, 0);
  });

  it('does NOT emit a recovery marker when the prior state was not blocked', async () => {
    const provider = buildFakeProvider(['agent::executing']);
    await transitionTicketState(provider, 4625, STATE_LABELS.READY, {
      config,
      cascade: false,
      _makeColumnSync: noopColumnSync,
    });
    assert.equal((await readSignals(4625)).length, 0);
  });
});
