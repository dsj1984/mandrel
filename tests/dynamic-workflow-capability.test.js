// tests/dynamic-workflow-capability.test.js
//
// Unit tier (Story #3278): strategy-selection is pure logic. These tests pin
// `detectDynamicWorkflowCapability` and `selectAuditStrategy` — capability
// present vs. absent yields the correct execution path, and every disable
// signal degrades to the sequential lens.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_STRATEGY,
  compareVersions,
  DECISION_REASON,
  DYNAMIC_WORKFLOW_VERSION_FLOOR,
  detectDynamicWorkflowCapability,
  ENV_KEYS,
  forceStrategyFromEnv,
  isFlagSet,
  meetsVersionFloor,
  selectAuditStrategy,
  snapshotFromEnv,
} from '../.agents/scripts/lib/dynamic-workflow/capability.js';

const CLAUDE_OK = Object.freeze({
  runtime: 'claude-code',
  version: '2.2.0',
  plan: 'max',
  disableWorkflowsSetting: false,
  disableWorkflowsEnv: undefined,
});

// --- isFlagSet ------------------------------------------------------------

test('isFlagSet: undefined / null / empty / falsey tokens are unset', () => {
  for (const v of [undefined, null, '', '0', 'false', 'off', 'no', 'FALSE']) {
    assert.equal(
      isFlagSet(v),
      false,
      `expected unset for ${JSON.stringify(v)}`,
    );
  }
});

test('isFlagSet: present truthy tokens are set', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'whatever']) {
    assert.equal(isFlagSet(v), true, `expected set for ${JSON.stringify(v)}`);
  }
});

// --- version comparison ---------------------------------------------------

test('compareVersions: orders dotted numeric versions', () => {
  assert.ok(compareVersions('2.1.154', '2.1.153') > 0);
  assert.ok(compareVersions('2.1.153', '2.1.154') < 0);
  assert.equal(compareVersions('2.1.154', '2.1.154'), 0);
  assert.ok(compareVersions('2.2.0', '2.1.999') > 0);
});

test('compareVersions: tolerates v-prefix and pre-release suffixes', () => {
  assert.equal(compareVersions('v2.1.154', '2.1.154'), 0);
  assert.equal(compareVersions('2.1.154-rc1', '2.1.154'), 0);
});

test('meetsVersionFloor: floor is the research-preview minimum', () => {
  assert.equal(DYNAMIC_WORKFLOW_VERSION_FLOOR, '2.1.154');
  assert.equal(meetsVersionFloor('2.1.154'), true);
  assert.equal(meetsVersionFloor('2.1.155'), true);
  assert.equal(meetsVersionFloor('2.1.153'), false);
  assert.equal(meetsVersionFloor('2.0.0'), false);
  assert.equal(meetsVersionFloor(''), false);
});

// --- capability detection -------------------------------------------------

test('detect: Claude Code runtime at/above floor on a paid plan is available', () => {
  const result = detectDynamicWorkflowCapability(CLAUDE_OK);
  assert.equal(result.available, true);
  assert.equal(result.reason, DECISION_REASON.CAPABILITY_PRESENT);
});

test('detect: non-Claude runtime is unavailable', () => {
  const result = detectDynamicWorkflowCapability({
    ...CLAUDE_OK,
    runtime: 'some-other-agent',
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, DECISION_REASON.NOT_CLAUDE_RUNTIME);
});

test('detect: missing runtime token is unavailable (non-Claude)', () => {
  const result = detectDynamicWorkflowCapability({
    ...CLAUDE_OK,
    runtime: undefined,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, DECISION_REASON.NOT_CLAUDE_RUNTIME);
});

test('detect: disableWorkflows settings flag forces unavailable', () => {
  const result = detectDynamicWorkflowCapability({
    ...CLAUDE_OK,
    disableWorkflowsSetting: true,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, DECISION_REASON.DISABLED_SETTING);
});

test('detect: CLAUDE_CODE_DISABLE_WORKFLOWS env forces unavailable', () => {
  const result = detectDynamicWorkflowCapability({
    ...CLAUDE_OK,
    disableWorkflowsEnv: '1',
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, DECISION_REASON.DISABLED_ENV);
});

test('detect: CC version below the floor is unavailable', () => {
  const result = detectDynamicWorkflowCapability({
    ...CLAUDE_OK,
    version: '2.1.100',
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, DECISION_REASON.VERSION_BELOW_FLOOR);
});

test('detect: Claude runtime with no version fails closed', () => {
  const result = detectDynamicWorkflowCapability({
    ...CLAUDE_OK,
    version: undefined,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, DECISION_REASON.RUNTIME_UNKNOWN);
});

test('detect: a known non-paid plan token is unavailable', () => {
  const result = detectDynamicWorkflowCapability({
    ...CLAUDE_OK,
    plan: 'free',
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, DECISION_REASON.UNPAID_PLAN);
});

test('detect: absent plan token does not block (runtime gates entitlement)', () => {
  const result = detectDynamicWorkflowCapability({
    ...CLAUDE_OK,
    plan: undefined,
  });
  assert.equal(result.available, true);
  assert.equal(result.reason, DECISION_REASON.CAPABILITY_PRESENT);
});

// --- strategy selection ---------------------------------------------------

test('select: capability present → orchestrated path', () => {
  const decision = selectAuditStrategy({ snapshot: CLAUDE_OK });
  assert.equal(decision.strategy, AUDIT_STRATEGY.ORCHESTRATED);
  assert.equal(decision.forced, false);
  assert.equal(decision.reason, DECISION_REASON.CAPABILITY_PRESENT);
});

test('select: capability absent → sequential fallback path', () => {
  const decision = selectAuditStrategy({
    snapshot: { ...CLAUDE_OK, runtime: 'other' },
  });
  assert.equal(decision.strategy, AUDIT_STRATEGY.SEQUENTIAL);
  assert.equal(decision.forced, false);
  assert.equal(decision.reason, DECISION_REASON.NOT_CLAUDE_RUNTIME);
});

test('select: each disable signal degrades to sequential', () => {
  const signals = [
    { ...CLAUDE_OK, disableWorkflowsSetting: true },
    { ...CLAUDE_OK, disableWorkflowsEnv: '1' },
    { ...CLAUDE_OK, version: '2.0.0' },
  ];
  for (const snapshot of signals) {
    const decision = selectAuditStrategy({ snapshot });
    assert.equal(
      decision.strategy,
      AUDIT_STRATEGY.SEQUENTIAL,
      `expected sequential for ${JSON.stringify(snapshot)}`,
    );
  }
});

test('select: force=sequential overrides an available capability', () => {
  const decision = selectAuditStrategy({
    snapshot: CLAUDE_OK,
    forceStrategy: 'sequential',
  });
  assert.equal(decision.strategy, AUDIT_STRATEGY.SEQUENTIAL);
  assert.equal(decision.forced, true);
  assert.equal(decision.reason, DECISION_REASON.FORCED_SEQUENTIAL);
});

test('select: force=orchestrated overrides an absent capability', () => {
  const decision = selectAuditStrategy({
    snapshot: { ...CLAUDE_OK, runtime: 'other' },
    forceStrategy: 'orchestrated',
  });
  assert.equal(decision.strategy, AUDIT_STRATEGY.ORCHESTRATED);
  assert.equal(decision.forced, true);
  assert.equal(decision.reason, DECISION_REASON.FORCED_ORCHESTRATED);
});

test('select: unknown force value is ignored (falls back to detection)', () => {
  const decision = selectAuditStrategy({
    snapshot: CLAUDE_OK,
    forceStrategy: 'banana',
  });
  assert.equal(decision.strategy, AUDIT_STRATEGY.ORCHESTRATED);
  assert.equal(decision.forced, false);
});

test('select: empty input degrades to sequential (no runtime)', () => {
  const decision = selectAuditStrategy();
  assert.equal(decision.strategy, AUDIT_STRATEGY.SEQUENTIAL);
});

// --- env adapters ---------------------------------------------------------

test('snapshotFromEnv: maps env keys + settings into a snapshot', () => {
  const env = {
    [ENV_KEYS.RUNTIME]: 'claude-code',
    [ENV_KEYS.VERSION]: '2.1.160',
    [ENV_KEYS.PLAN]: 'pro',
    [ENV_KEYS.DISABLE]: '0',
  };
  const snapshot = snapshotFromEnv(env, { disableWorkflows: false });
  assert.equal(snapshot.runtime, 'claude-code');
  assert.equal(snapshot.version, '2.1.160');
  assert.equal(snapshot.plan, 'pro');
  assert.equal(snapshot.disableWorkflowsSetting, false);
  assert.equal(snapshot.disableWorkflowsEnv, '0');
});

test('snapshotFromEnv → select: end-to-end via env yields orchestrated', () => {
  const env = {
    [ENV_KEYS.RUNTIME]: 'claude-code',
    [ENV_KEYS.VERSION]: '2.1.154',
    [ENV_KEYS.PLAN]: 'max',
  };
  const decision = selectAuditStrategy({
    snapshot: snapshotFromEnv(env),
    forceStrategy: forceStrategyFromEnv(env),
  });
  assert.equal(decision.strategy, AUDIT_STRATEGY.ORCHESTRATED);
});

test('forceStrategyFromEnv: recognises both strategies, rejects others', () => {
  assert.equal(
    forceStrategyFromEnv({ [ENV_KEYS.FORCE_STRATEGY]: 'orchestrated' }),
    'orchestrated',
  );
  assert.equal(
    forceStrategyFromEnv({ [ENV_KEYS.FORCE_STRATEGY]: 'SEQUENTIAL' }),
    'sequential',
  );
  assert.equal(
    forceStrategyFromEnv({ [ENV_KEYS.FORCE_STRATEGY]: 'nope' }),
    null,
  );
  assert.equal(forceStrategyFromEnv({}), null);
});
