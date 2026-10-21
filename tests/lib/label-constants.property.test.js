/**
 * Property tests for the `agent::*` transition table (Story #5805).
 *
 * Over every ordered pair of `AGENT_LABELS` values: a self-transition is
 * never valid, `agent::done` is terminal, and a `null` / `undefined`
 * from-state (initial entry) admits every label. Runs are pinned by
 * `fcParams()`; override with `MANDREL_FC_SEED` / `MANDREL_FC_NUM_RUNS`.
 * Every pair a production caller performs is pinned as admitted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import {
  AGENT_LABELS,
  isValidTransition,
} from '../../.agents/scripts/lib/label-constants.js';
import { fcParams } from '../helpers/fast-check-config.js';

const STATES = Object.values(AGENT_LABELS);
const state = fc.constantFrom(...STATES);

const { REVIEW_SPEC, READY, EXECUTING, CLOSING, DONE, BLOCKED } = AGENT_LABELS;

/**
 * Each `[from, to, performer]` a production path flips through; a new caller
 * adds its pair here. The table must admit every one, or the observer files
 * friction against routine delivery.
 */
const PRODUCTION_TRANSITIONS = [
  [REVIEW_SPEC, READY, 'plan-persist source rewrite + markStoriesReady'],
  [READY, EXECUTING, 'single-story-init claim; parent-state cascade'],
  [BLOCKED, EXECUTING, 'single-story-init claim; parent-state cascade'],
  [EXECUTING, READY, 'single-story-init claim rollback'],
  [BLOCKED, READY, 'operator resume via update-ticket-state.js'],
  [EXECUTING, CLOSING, 'story-merged-notify flipLabel'],
  [BLOCKED, CLOSING, 'close re-run with --override-review-block'],
  [CLOSING, DONE, 'confirm-merge flipDone'],
  [EXECUTING, DONE, 'confirm-merge flipDone; parent DONE cascade'],
  [BLOCKED, DONE, 'confirm-merge after a merged-flip-failed block'],
  [EXECUTING, BLOCKED, 'close phases, handoff, init-remote, CI guard'],
  [CLOSING, BLOCKED, 'confirm-merge unlanded-merge block'],
];

describe('agent:: transition table properties (Story #5805)', () => {
  it('a self-transition is never valid', () => {
    fc.assert(
      fc.property(state, (s) => !isValidTransition(s, s)),
      fcParams(),
    );
  });

  it('every transition out of agent::done is invalid', () => {
    fc.assert(
      fc.property(state, (to) => !isValidTransition(AGENT_LABELS.DONE, to)),
      fcParams(),
    );
  });

  it('a null or undefined from-state admits every label', () => {
    fc.assert(
      fc.property(fc.constantFrom(null, undefined), state, (from, to) =>
        isValidTransition(from, to),
      ),
      fcParams(),
    );
  });

  for (const [from, to, performer] of PRODUCTION_TRANSITIONS) {
    it(`admits ${from} → ${to} (${performer})`, () => {
      assert.equal(isValidTransition(from, to), true);
    });
  }
});
