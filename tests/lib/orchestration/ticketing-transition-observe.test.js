/**
 * Story #5805 — `transitionTicketState` observes, never refuses, a flip
 * outside `VALID_TRANSITIONS`: an invalid non-self pair records one
 * `invalid-agent-transition` friction signal naming both states, and the
 * label write still happens. A self-transition (idempotent re-apply) and a
 * valid pair record nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { RUNTIME_FRICTION_CATEGORIES } from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import { forEachLine } from '../../../.agents/scripts/lib/observability/signals-writer.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from '../../../.agents/scripts/lib/orchestration/ticketing.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

/** Absolute, per-test tempRoot — never the shared checkout's `temp/`. */
let tempRoot;
let config;

beforeEach(async () => {
  tempRoot = await makeTempDir('transition-observe-');
  config = { project: { paths: { tempRoot } } };
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function buildFakeProvider(labels) {
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

async function flip(provider, id, newState) {
  return transitionTicketState(provider, id, newState, {
    config,
    cascade: false,
    _makeColumnSync: noopColumnSync,
  });
}

async function invalidSignals(storyId) {
  const rows = [];
  await forEachLine(null, storyId, (p) => rows.push(p), config);
  return rows.filter(
    (r) => r.category === RUNTIME_FRICTION_CATEGORIES.INVALID_AGENT_TRANSITION,
  );
}

describe('invalid agent:: transition observer (Story #5805)', () => {
  it('records one friction signal for done → executing and still applies the label', async () => {
    const provider = buildFakeProvider([STATE_LABELS.DONE]);
    await flip(provider, 5805, STATE_LABELS.EXECUTING);

    const rows = await invalidSignals(5805);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'friction');
    assert.equal(rows[0].emitter.tool, 'transitionTicketState');
    assert.deepEqual(rows[0].details, {
      fromState: STATE_LABELS.DONE,
      toState: STATE_LABELS.EXECUTING,
      allowed: [],
    });
    assert.equal(provider.updates.length, 1);
    assert.deepEqual(provider.updates[0].mutations.labels.add, [
      STATE_LABELS.EXECUTING,
    ]);
  });

  it('records nothing for a self-transition', async () => {
    const provider = buildFakeProvider([STATE_LABELS.EXECUTING]);
    await flip(provider, 5806, STATE_LABELS.EXECUTING);
    assert.equal((await invalidSignals(5806)).length, 0);
    assert.equal(provider.updates.length, 1);
  });

  it('records nothing for the executing → ready init-failure rollback', async () => {
    const provider = buildFakeProvider([STATE_LABELS.EXECUTING]);
    await flip(provider, 5807, STATE_LABELS.READY);
    assert.equal((await invalidSignals(5807)).length, 0);
  });

  it('records nothing on initial entry (no prior agent:: label)', async () => {
    const provider = buildFakeProvider([]);
    await flip(provider, 5808, STATE_LABELS.READY);
    assert.equal((await invalidSignals(5808)).length, 0);
  });

  it('does not throw when the signal write is broken', async () => {
    const filePath = `${tempRoot}/not-a-dir`;
    await fs.writeFile(filePath, 'x', 'utf8');
    const provider = buildFakeProvider([STATE_LABELS.DONE]);
    await transitionTicketState(provider, 5809, STATE_LABELS.READY, {
      config: { project: { paths: { tempRoot: filePath } } },
      cascade: false,
      _makeColumnSync: noopColumnSync,
    });
    assert.equal(provider.updates.length, 1);
  });
});
