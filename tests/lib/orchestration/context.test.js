import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EpicRunnerContext,
  OrchestrationContext,
  PlanRunnerContext,
} from '../../../.agents/scripts/lib/orchestration/context.js';

const MIN_EPIC_CFG = {
  runners: {
    deliverRunner: { enabled: true, concurrencyCap: 2 },
  },
};

describe('OrchestrationContext family', () => {
  it('validates required base fields at construction', () => {
    assert.throws(() => new OrchestrationContext({}), /integer epicId/);
    assert.throws(() => new OrchestrationContext({ epicId: 1 }), /provider/);
    assert.throws(
      () => new OrchestrationContext({ epicId: 1, provider: {} }),
      /config/,
    );
  });

  it('freezes the base instance', () => {
    const ctx = new OrchestrationContext({
      epicId: 1,
      provider: {},
      config: {},
    });
    assert.ok(Object.isFrozen(ctx));
    assert.throws(() => {
      ctx.epicId = 99;
    });
  });

  it('EpicRunnerContext requires a dispatch adapter and positive concurrencyCap', () => {
    assert.throws(
      () =>
        new EpicRunnerContext({
          epicId: 1,
          provider: {},
          config: MIN_EPIC_CFG,
        }),
      /dispatch adapter/,
    );
    assert.throws(
      () =>
        new EpicRunnerContext({
          epicId: 1,
          provider: {},
          config: {
            runners: { deliverRunner: { enabled: true, concurrencyCap: 0 } },
          },
          dispatch: () => {},
        }),
      /concurrencyCap/,
    );
  });

  it('EpicRunnerContext refuses to construct when deliverRunner.enabled is false', () => {
    assert.throws(
      () =>
        new EpicRunnerContext({
          epicId: 1,
          provider: {},
          config: {
            runners: { deliverRunner: { enabled: false, concurrencyCap: 1 } },
          },
          dispatch: () => {},
        }),
      /enabled is false/,
    );
  });

  it('EpicRunnerContext reads concurrencyCap from config when omitted', () => {
    const ctx = new EpicRunnerContext({
      epicId: 1,
      provider: {},
      config: MIN_EPIC_CFG,
      dispatch: () => {},
    });
    assert.equal(ctx.concurrencyCap, 2);
    assert.ok(Object.isFrozen(ctx));
  });

  it('PlanRunnerContext only needs the base surface', () => {
    const ctx = new PlanRunnerContext({
      epicId: 42,
      provider: {},
      config: {},
      phase: 'planning',
      plannerClient: { name: 'test' },
    });
    assert.equal(ctx.phase, 'planning');
    assert.equal(ctx.plannerClient.name, 'test');
    assert.ok(Object.isFrozen(ctx));
  });
});
