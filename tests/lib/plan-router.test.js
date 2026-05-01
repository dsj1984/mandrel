import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import {
  advancePhase,
  nextPhaseForEpic,
  PLAN_PHASE_DESCRIPTORS,
  PLAN_PHASE_NAMES,
} from '../../.agents/scripts/lib/orchestration/plan-runner/plan-router.js';

describe('plan-router', () => {
  describe('nextPhaseForEpic()', () => {
    it('returns the spec descriptor for a fresh Epic', () => {
      const next = nextPhaseForEpic(['type::epic']);
      assert.equal(next.phase, PLAN_PHASE_NAMES.SPEC);
    });

    it('returns null when the Epic is already on agent::ready', () => {
      const next = nextPhaseForEpic(['type::epic', AGENT_LABELS.READY]);
      assert.equal(next, null);
    });

    it('routes agent::review-spec → decompose descriptor', () => {
      const next = nextPhaseForEpic(['type::epic', AGENT_LABELS.REVIEW_SPEC]);
      assert.equal(next.phase, PLAN_PHASE_NAMES.DECOMPOSE);
    });
  });

  describe('advancePhase()', () => {
    it('advances spec → decompose', () => {
      const next = advancePhase(PLAN_PHASE_NAMES.SPEC);
      assert.equal(next.phase, PLAN_PHASE_NAMES.DECOMPOSE);
    });

    it('returns null after decompose (terminal)', () => {
      assert.equal(advancePhase(PLAN_PHASE_NAMES.DECOMPOSE), null);
    });

    it('returns null for unknown phases', () => {
      assert.equal(advancePhase('unknown'), null);
    });
  });

  describe('descriptor map', () => {
    it('has stable parking label mappings', () => {
      assert.equal(
        PLAN_PHASE_DESCRIPTORS[PLAN_PHASE_NAMES.SPEC].parkingLabel,
        AGENT_LABELS.REVIEW_SPEC,
      );
      assert.equal(
        PLAN_PHASE_DESCRIPTORS[PLAN_PHASE_NAMES.DECOMPOSE].parkingLabel,
        AGENT_LABELS.READY,
      );
    });
  });
});
