// tests/code-review-audit-routing.test.js
//
// Contract tier (Story #3876): the post-delivery audit-lens routing in
// `code-review.js` maps the judged risk envelope's high-risk axes onto audit
// lenses and runs them through the EXISTING `selectAuditStrategy` engine — no
// new audit machinery. These tests pin the axis→lens contract:
//   - security            → audit-security
//   - public-api          → audit-architecture
//   - architecture        → audit-architecture
//   - low-risk envelope   → no lenses (baseline gates only)
//   - de-duplication + stable ordering of routed lenses
//   - the strategy engine seam is the shared `selectAuditStrategy`.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_STRATEGY,
  selectAuditStrategy,
} from '../.agents/scripts/lib/dynamic-workflow/capability.js';
import {
  planAuditLenses,
  resolveAuditLenses,
} from '../.agents/scripts/lib/orchestration/code-review.js';

// --- resolveAuditLenses: axis → lens --------------------------------------

test('resolveAuditLenses: a high-risk security axis routes audit-security', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [{ axis: 'security', level: 'high', rationale: 'auth boundary' }],
  };
  assert.deepEqual(resolveAuditLenses(envelope), ['audit-security']);
});

test('resolveAuditLenses: a high-risk public-api axis routes audit-architecture', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [{ axis: 'public-api', level: 'high', rationale: 'breaking api' }],
  };
  assert.deepEqual(resolveAuditLenses(envelope), ['audit-architecture']);
});

test('resolveAuditLenses: a high-risk architecture axis routes audit-architecture', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [{ axis: 'architecture', level: 'high', rationale: 'module split' }],
  };
  assert.deepEqual(resolveAuditLenses(envelope), ['audit-architecture']);
});

test('resolveAuditLenses: a low-risk envelope routes no lenses', () => {
  const envelope = {
    overallLevel: 'low',
    axes: [{ axis: 'docs-only', level: 'low', rationale: 'prose' }],
  };
  assert.deepEqual(resolveAuditLenses(envelope), []);
});

test('resolveAuditLenses: an empty / absent envelope routes no lenses', () => {
  assert.deepEqual(resolveAuditLenses(), []);
  assert.deepEqual(resolveAuditLenses({}), []);
  assert.deepEqual(resolveAuditLenses({ axes: [] }), []);
});

test('resolveAuditLenses: a non-high security axis does not route a lens', () => {
  const envelope = {
    overallLevel: 'medium',
    axes: [{ axis: 'security', level: 'medium', rationale: 'soft signal' }],
  };
  assert.deepEqual(resolveAuditLenses(envelope), []);
});

test('resolveAuditLenses: de-duplicates and orders security before architecture', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [
      { axis: 'architecture', level: 'high', rationale: 'split' },
      { axis: 'public-api', level: 'high', rationale: 'breaking' },
      { axis: 'security', level: 'high', rationale: 'auth' },
    ],
  };
  // public-api + architecture collapse to a single audit-architecture, and the
  // ordering is stable (security first) regardless of axis order.
  assert.deepEqual(resolveAuditLenses(envelope), [
    'audit-security',
    'audit-architecture',
  ]);
});

test('resolveAuditLenses: unmapped high-risk axes contribute no lens', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [{ axis: 'billing', level: 'high', rationale: 'stripe' }],
  };
  assert.deepEqual(resolveAuditLenses(envelope), []);
});

// --- planAuditLenses: routes through the existing strategy engine ----------

test('planAuditLenses: a high-risk security envelope plans audit-security via selectAuditStrategy', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [{ axis: 'security', level: 'high', rationale: 'auth' }],
  };
  // Force the orchestrated strategy through the real engine to prove the plan
  // is produced by `selectAuditStrategy`, not a bespoke audit machine.
  const { lenses, plan } = planAuditLenses(envelope, {
    forceStrategy: AUDIT_STRATEGY.ORCHESTRATED,
  });
  assert.deepEqual(lenses, ['audit-security']);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].lens, 'audit-security');
  assert.equal(plan[0].strategy, AUDIT_STRATEGY.ORCHESTRATED);
  assert.equal(plan[0].forced, true);
});

test('planAuditLenses: a low-risk envelope plans no lenses (baseline gates only)', () => {
  const envelope = {
    overallLevel: 'low',
    axes: [{ axis: 'internal-refactor', level: 'low', rationale: 'tidy' }],
  };
  const { lenses, plan } = planAuditLenses(envelope);
  assert.deepEqual(lenses, []);
  assert.deepEqual(plan, []);
});

test('planAuditLenses: delegates strategy selection to the injected engine', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [
      { axis: 'security', level: 'high', rationale: 'auth' },
      { axis: 'architecture', level: 'high', rationale: 'split' },
    ],
  };
  const calls = [];
  const fakeSelect = (input) => {
    calls.push(input);
    return {
      strategy: AUDIT_STRATEGY.SEQUENTIAL,
      reason: 'forced-sequential',
      forced: true,
      capability: {},
    };
  };
  const { lenses, plan } = planAuditLenses(envelope, {
    forceStrategy: AUDIT_STRATEGY.SEQUENTIAL,
    selectAuditStrategyFn: fakeSelect,
  });
  assert.deepEqual(lenses, ['audit-security', 'audit-architecture']);
  assert.equal(calls.length, 2);
  assert.equal(plan[0].strategy, AUDIT_STRATEGY.SEQUENTIAL);
  assert.equal(plan[1].strategy, AUDIT_STRATEGY.SEQUENTIAL);
});

test('planAuditLenses default engine reference is the shared selectAuditStrategy', () => {
  // Guards against a copy-paste fork: the module-level default must be the
  // exported engine, not a local re-implementation.
  assert.equal(typeof selectAuditStrategy, 'function');
  const { plan } = planAuditLenses({
    overallLevel: 'high',
    axes: [{ axis: 'security', level: 'high', rationale: 'auth' }],
  });
  // With no snapshot the real engine degrades to the sequential fallback
  // (not-claude-runtime), proving the real engine ran.
  assert.equal(plan[0].strategy, AUDIT_STRATEGY.SEQUENTIAL);
});
