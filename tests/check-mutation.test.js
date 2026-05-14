import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  evaluateFloors,
  extractFloors,
  resolveMutationGate,
  runMutationGate,
} from '../.agents/scripts/check-mutation.js';

/**
 * Story #1736 / Task #1753. Contract test for the story-close mutation
 * gate. Exercises `runMutationGate` end-to-end through fully-injected
 * boundaries (`resolveConfigFn`, `runStrykerFn`, `readBaselineFn`,
 * `logger`) so the test never spawns Stryker, reads `.agentrc.json`, or
 * touches the filesystem.
 *
 * AC covered:
 *  - exit 0 when gate passes
 *  - exit 1 with diagnostic when floor violated, citing the offending
 *    workspace name
 *  - exit 0 with the canonical skip line when no Stryker config is
 *    detected
 *  - Per-workspace floor violations are reported with the offending
 *    workspace name
 */

function silentLogger() {
  return {
    info: mock.fn(() => {}),
    warn: mock.fn(() => {}),
    error: mock.fn(() => {}),
    debug: mock.fn(() => {}),
  };
}

/**
 * Mirror the shape produced by `resolveConfig().agentSettings`. The
 * legacy shim flattens `delivery.quality.gates` under
 * `agentSettings.quality.gates`, so `getQuality({ agentSettings })`
 * reads the gates from `agentSettings.quality.gates`.
 */
function makeAgentSettings(mutationGate = {}) {
  return {
    quality: {
      gates: {
        mutation: { enabled: true, ...mutationGate },
      },
    },
  };
}

describe('check-mutation — resolveMutationGate', () => {
  it('returns sensible defaults for an empty gate block', () => {
    const gate = resolveMutationGate(makeAgentSettings());
    assert.equal(gate.enabled, true);
    assert.equal(gate.baselinePath, 'baselines/mutation.json');
    assert.equal(gate.tolerancePct, 0);
    assert.equal(gate.floors, null);
    assert.equal(gate.strykerConfigPath, null);
  });

  it('honours configured baselinePath, tolerance.value, and strykerConfigPath', () => {
    const gate = resolveMutationGate(
      makeAgentSettings({
        baselinePath: 'custom/mut.json',
        tolerance: { kind: 'absolute', value: 1.5 },
        strykerConfigPath: 'stryker.conf.cjs',
      }),
    );
    assert.equal(gate.baselinePath, 'custom/mut.json');
    assert.equal(gate.tolerancePct, 1.5);
    assert.equal(gate.strykerConfigPath, 'stryker.conf.cjs');
  });

  it('honours enabled=false', () => {
    const gate = resolveMutationGate(makeAgentSettings({ enabled: false }));
    assert.equal(gate.enabled, false);
  });

  it('extracts per-workspace floors from the gate block', () => {
    const gate = resolveMutationGate(
      makeAgentSettings({
        floors: { '*': { mutation: 70 }, api: { mutation: 80 } },
      }),
    );
    assert.deepEqual(gate.floors, { '*': 70, api: 80 });
  });
});

describe('check-mutation — extractFloors', () => {
  it('returns null for invalid inputs', () => {
    assert.equal(extractFloors(null), null);
    assert.equal(extractFloors(undefined), null);
    assert.equal(extractFloors([]), null);
    assert.equal(extractFloors({ '*': 'high' }), null);
  });

  it('skips workspace entries without numeric mutation values', () => {
    const result = extractFloors({
      '*': { mutation: 75 },
      web: { mutation: 'high' },
      api: { mutation: 80 },
    });
    assert.deepEqual(result, { '*': 75, api: 80 });
  });
});

describe('check-mutation — evaluateFloors', () => {
  it('passes when every workspace meets the floor', () => {
    const result = evaluateFloors({
      measured: { '*': 80, api: 90 },
      floors: { '*': 70 },
      baseline: null,
      tolerancePct: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
    assert.equal(result.passed.length, 2);
  });

  it('flags workspaces below the configured floor', () => {
    const result = evaluateFloors({
      measured: { api: 60 },
      floors: { '*': 70 },
      baseline: null,
      tolerancePct: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].workspace, 'api');
    assert.equal(result.violations[0].observed, 60);
    assert.equal(result.violations[0].floor, 70);
    assert.equal(result.violations[0].source, 'floors');
  });

  it('falls back to baseline minus tolerance when no floors configured', () => {
    const result = evaluateFloors({
      measured: { '*': 74 },
      floors: null,
      baseline: { workspaces: { '*': 80 }, tolerancePct: 5 },
      tolerancePct: 0,
    });
    // 80 - 5 = 75; observed 74 < 75 → violation
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].floor, 75);
    assert.equal(result.violations[0].source, 'baseline');
  });

  it('prefers per-workspace floor over catch-all', () => {
    const result = evaluateFloors({
      measured: { web: 72 },
      floors: { '*': 70, web: 75 },
      baseline: null,
      tolerancePct: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].floor, 75);
  });

  it('routes workspaces without floor or baseline to ungated', () => {
    const result = evaluateFloors({
      measured: { exotic: 50 },
      floors: null,
      baseline: null,
      tolerancePct: 0,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ungated, ['exotic']);
  });
});

describe('check-mutation — runMutationGate', () => {
  it('exits 0 with the canonical skip line when no Stryker config detected', async () => {
    const logger = silentLogger();
    const runStrykerFn = mock.fn(async () => ({
      ok: false,
      skipped: true,
      reason: 'no Stryker config found. Run `npx stryker init` to enable.',
    }));
    const result = await runMutationGate({
      cwd: '/repo',
      resolveConfigFn: () => ({ agentSettings: makeAgentSettings() }),
      runStrykerFn,
      readBaselineFn: () => null,
      logger,
    });
    assert.equal(result.status, 0);
    assert.equal(result.outcome, 'skipped-no-config');
    const infoCalls = logger.info.mock.calls.map((c) => c.arguments[0]);
    assert.ok(
      infoCalls.some((m) =>
        m.includes(
          '[mutation] skipped — no Stryker config found. Run `npx stryker init` to enable.',
        ),
      ),
      `expected canonical skip line; got: ${JSON.stringify(infoCalls)}`,
    );
  });

  it('exits 0 with disabled line when gate.enabled is false', async () => {
    const logger = silentLogger();
    const result = await runMutationGate({
      cwd: '/repo',
      resolveConfigFn: () => ({
        agentSettings: makeAgentSettings({ enabled: false }),
      }),
      runStrykerFn: mock.fn(async () => {
        throw new Error('runner should not be invoked when gate disabled');
      }),
      readBaselineFn: () => null,
      logger,
    });
    assert.equal(result.status, 0);
    assert.equal(result.outcome, 'skipped-disabled');
    const infoCalls = logger.info.mock.calls.map((c) => c.arguments[0]);
    assert.ok(
      infoCalls.some((m) =>
        m.includes('[mutation] skipped — disabled in config'),
      ),
    );
  });

  it('exits 0 when every workspace meets its floor', async () => {
    const logger = silentLogger();
    const result = await runMutationGate({
      cwd: '/repo',
      resolveConfigFn: () => ({
        agentSettings: makeAgentSettings({
          floors: { '*': { mutation: 70 } },
        }),
      }),
      runStrykerFn: mock.fn(async () => ({
        ok: true,
        byWorkspace: { '*': 80 },
        mutationScore: 80,
      })),
      readBaselineFn: () => null,
      logger,
    });
    assert.equal(result.status, 0);
    assert.equal(result.outcome, 'passed');
    const infoCalls = logger.info.mock.calls.map((c) => c.arguments[0]);
    assert.ok(infoCalls.some((m) => m.includes('[mutation] ✅ passed')));
  });

  it('exits 1 with a per-workspace diagnostic when floor is violated', async () => {
    const logger = silentLogger();
    const result = await runMutationGate({
      cwd: '/repo',
      resolveConfigFn: () => ({
        agentSettings: makeAgentSettings({
          floors: { '*': { mutation: 75 }, api: { mutation: 80 } },
        }),
      }),
      runStrykerFn: mock.fn(async () => ({
        ok: true,
        byWorkspace: { '*': 90, api: 60 },
      })),
      readBaselineFn: () => null,
      logger,
    });
    assert.equal(result.status, 1);
    assert.equal(result.outcome, 'floor-violated');
    const errorCalls = logger.error.mock.calls.map((c) => c.arguments[0]);
    assert.ok(
      errorCalls.some(
        (m) =>
          m.includes("workspace 'api'") && m.includes('60') && m.includes('80'),
      ),
      `expected per-workspace diagnostic citing 'api'; got: ${JSON.stringify(errorCalls)}`,
    );
  });

  it('exits 1 when Stryker invocation itself fails', async () => {
    const logger = silentLogger();
    const result = await runMutationGate({
      cwd: '/repo',
      resolveConfigFn: () => ({ agentSettings: makeAgentSettings() }),
      runStrykerFn: mock.fn(async () => ({
        ok: false,
        skipped: false,
        error: 'Stryker exited with status 1: boom',
      })),
      readBaselineFn: () => null,
      logger,
    });
    assert.equal(result.status, 1);
    assert.equal(result.outcome, 'stryker-failed');
    const errorCalls = logger.error.mock.calls.map((c) => c.arguments[0]);
    assert.ok(errorCalls.some((m) => m.includes('Stryker invocation error')));
  });

  it('uses baseline-derived floor when no configured floor matches', async () => {
    const logger = silentLogger();
    const result = await runMutationGate({
      cwd: '/repo',
      resolveConfigFn: () => ({
        agentSettings: makeAgentSettings({
          tolerance: { kind: 'absolute', value: 1 },
        }),
      }),
      runStrykerFn: mock.fn(async () => ({
        ok: true,
        byWorkspace: { '*': 78 },
      })),
      readBaselineFn: () => ({
        generatedAt: 'now',
        tolerancePct: 0,
        workspaces: { '*': 80 },
      }),
      logger,
    });
    // baseline 80, baselineTol 0, observed 78 → 78 < 80 → violation
    assert.equal(result.status, 1);
    const errorCalls = logger.error.mock.calls.map((c) => c.arguments[0]);
    assert.ok(
      errorCalls.some((m) => m.includes('baseline-adjusted')),
      `expected baseline-source diagnostic; got: ${JSON.stringify(errorCalls)}`,
    );
  });

  it('tolerates an unreadable baseline by falling back to configured floors', async () => {
    const logger = silentLogger();
    const result = await runMutationGate({
      cwd: '/repo',
      resolveConfigFn: () => ({
        agentSettings: makeAgentSettings({
          floors: { '*': { mutation: 60 } },
        }),
      }),
      runStrykerFn: mock.fn(async () => ({
        ok: true,
        byWorkspace: { '*': 75 },
      })),
      readBaselineFn: () => {
        throw new Error('corrupt baseline');
      },
      logger,
    });
    // 75 ≥ 60 → pass; warn surface emitted; no exit-1.
    assert.equal(result.status, 0);
    const warnCalls = logger.warn.mock.calls.map((c) => c.arguments[0]);
    assert.ok(warnCalls.some((m) => m.includes('failed to read baseline')));
  });
});
