// tests/contract/lifecycle/terminal-state-on-confirm.test.js
/**
 * Contract test for the terminal-state rebind
 * (Story #2896 / Task #2912, Epic #2880).
 *
 * Acceptance contract:
 *   - `Cleaner.events === ['epic.merge.confirmed']` (rebound from
 *     `epic.merge.armed`).
 *   - `LabelTransitioner.events` is unchanged from prior taxonomy and
 *     still includes `'epic.complete'` (it is the listener that
 *     flips the Epic ticket to `agent::done` on the terminal event).
 *   - Harness wiring: emitting only `epic.merge.armed` does NOT
 *     transition the Epic label to `agent::done`. Emitting the
 *     downstream `epic.merge.confirmed` DOES — because Cleaner
 *     subscribes to the confirmed event, emits `epic.complete`, and
 *     LabelTransitioner translates `epic.complete` into the
 *     `agent::done` flip.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bus } from '../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { Cleaner } from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/cleaner.js';
import { LabelTransitioner } from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/label-transitioner.js';
import { STATE_LABELS } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

describe('Cleaner.events — Story #2896 rebind', () => {
  it('subscribes to epic.merge.confirmed (exactly that event)', () => {
    const bus = new Bus();
    const cleaner = new Cleaner({
      bus,
      epicId: 2880,
      tempRoot: '/tmp/never-touched',
      logger: quietLogger(),
    });
    assert.deepEqual([...cleaner.events], ['epic.merge.confirmed']);
  });
});

describe('LabelTransitioner.events — unchanged', () => {
  it('still subscribes to epic.complete (the terminal-state event)', () => {
    const lt = new LabelTransitioner({
      provider: {},
      epicId: 2880,
      transitionTicketState: async () => {},
      logger: quietLogger(),
    });
    assert.ok(
      lt.events.includes('epic.complete'),
      'LabelTransitioner must subscribe to epic.complete',
    );
  });
});

describe('Terminal-state harness — armed alone does NOT flip; confirmed DOES', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-2896-'));
    fs.mkdirSync(path.join(tempRoot, 'epic-2880'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emitting only epic.merge.armed does not transition the Epic label', async () => {
    const bus = new Bus();
    const transitions = [];
    const transitionTicketState = async (_provider, ticketId, state) => {
      transitions.push({ ticketId, state });
    };
    const cleaner = new Cleaner({
      bus,
      epicId: 2880,
      tempRoot,
      logger: quietLogger(),
    });
    cleaner.register();
    const lt = new LabelTransitioner({
      provider: {},
      epicId: 2880,
      transitionTicketState,
      logger: quietLogger(),
    });
    lt.register(bus);

    await bus.emit('epic.merge.armed', {
      prUrl: 'https://github.com/o/r/pull/4242',
    });

    // No transition fired: Cleaner does not listen to .armed any
    // more, so no epic.complete was emitted, so LabelTransitioner
    // had nothing to translate.
    assert.equal(
      transitions.length,
      0,
      'no label transition on epic.merge.armed alone',
    );
  });

  it('emitting epic.merge.confirmed transitions the Epic to agent::done', async () => {
    const bus = new Bus();
    const transitions = [];
    const transitionTicketState = async (_provider, ticketId, state) => {
      transitions.push({ ticketId, state });
    };
    const cleaner = new Cleaner({
      bus,
      epicId: 2880,
      tempRoot,
      logger: quietLogger(),
    });
    cleaner.register();
    const lt = new LabelTransitioner({
      provider: {},
      epicId: 2880,
      transitionTicketState,
      logger: quietLogger(),
    });
    lt.register(bus);

    await bus.emit('epic.merge.confirmed', {
      epicId: 2880,
      prUrl: 'https://github.com/o/r/pull/4242',
      prNumber: 4242,
      mergeCommitSha: 'deadbeef',
      mergedAt: '2026-05-22T13:00:00Z',
      pollAttempts: 1,
    });

    // The Cleaner emits epic.complete (carrying { epicId, prUrl }),
    // LabelTransitioner translates that into a flip to agent::done
    // on the Epic ticket.
    const epicDoneFlip = transitions.find(
      (t) => t.ticketId === 2880 && t.state === STATE_LABELS.DONE,
    );
    assert.ok(
      epicDoneFlip,
      `expected an agent::done flip on Epic #2880; got ${JSON.stringify(transitions)}`,
    );
  });
});
