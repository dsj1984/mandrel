/**
 * Property tests for the `agent::*` transition table (Story #5805).
 *
 * Over every ordered pair of `AGENT_LABELS` values: a self-transition is
 * never valid, `agent::done` is terminal, and a `null` / `undefined`
 * from-state (initial entry) admits every label. Runs are pinned by
 * `fcParams()`; override with `MANDREL_FC_SEED` / `MANDREL_FC_NUM_RUNS`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import {
  AGENT_LABELS,
  isValidTransition,
  VALID_TRANSITIONS,
} from '../../.agents/scripts/lib/label-constants.js';
import { fcParams } from '../helpers/fast-check-config.js';

const STATES = Object.values(AGENT_LABELS);
const state = fc.constantFrom(...STATES);

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

  it('a non-null pair is valid exactly when the table lists it', () => {
    fc.assert(
      fc.property(
        state,
        state,
        (from, to) =>
          isValidTransition(from, to) ===
          (from !== to && VALID_TRANSITIONS[from].includes(to)),
      ),
      fcParams(),
    );
  });

  it('admits executing → ready (the init-failure claim rollback)', () => {
    assert.equal(
      isValidTransition(AGENT_LABELS.EXECUTING, AGENT_LABELS.READY),
      true,
    );
  });
});
