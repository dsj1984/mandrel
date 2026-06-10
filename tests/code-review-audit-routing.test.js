// tests/code-review-audit-routing.test.js
//
// Contract tier (Story #3876 / #3889 / #3939): the post-delivery audit-lens
// routing in `code-review.js` maps the judged risk envelope's high-risk axes
// onto audit lenses and runs them through the EXISTING `selectAuditStrategy`
// engine — no new audit machinery. These tests pin the axis→lens contract:
//   - security             → audit-security
//   - public-api           → audit-architecture (the canonical architectural axis)
//   - data-migration       → audit-quality        (Story #3939)
//   - destructive-mutation → audit-security        (Story #3939; co-routes)
//   - billing              → audit-privacy         (Story #3939)
//   - critical-workflow    → audit-quality         (Story #3939)
//   - visible-behavior     → no lens (intentional; forced at plan time)
//   - low-risk envelope    → no lenses (baseline gates only)
//   - de-duplication + stable ordering of routed lenses
//   - the strategy engine seam is the shared `selectAuditStrategy`.
//
// Story #3939 broadened the routing so every high-risk REQUIRED axis routes a
// lens. Every AXIS_TO_LENS key MUST still be a value in the
// risk-verdict.schema.json axis enum (the guard test below pins that), and the
// `visible-behavior` axis MUST continue to route nothing.
//
// Story #3889 removed the unreachable `architecture` key from AXIS_TO_LENS:
// `architecture` is NOT a value in the risk-verdict.schema.json axis enum, so a
// verdict-derived envelope can never carry it — the architectural axis is
// `public-api`. The guard test below pins that no AXIS_TO_LENS key references an
// off-schema axis.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_STRATEGY,
  selectAuditStrategy,
} from '../.agents/scripts/lib/dynamic-workflow/capability.js';
import {
  planAuditLenses,
  resolveAuditLenses,
} from '../.agents/scripts/lib/orchestration/code-review.js';

/**
 * Read the canonical risk-verdict axis enum so the routing guard below can
 * assert no AXIS_TO_LENS key references a value absent from the schema.
 */
function readRiskVerdictAxisEnum() {
  const schemaPath = fileURLToPath(
    new URL('../.agents/schemas/risk-verdict.schema.json', import.meta.url),
  );
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  return schema.properties.axes.items.properties.axis.enum;
}

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

test('resolveAuditLenses: the off-schema architecture axis routes no lens (Story #3889)', () => {
  // `architecture` is not in the risk-verdict.schema.json axis enum, so a
  // verdict-derived envelope can never carry it. Even if a caller hand-builds
  // an envelope with it, the dead key is gone and it routes nothing.
  const envelope = {
    overallLevel: 'high',
    axes: [{ axis: 'architecture', level: 'high', rationale: 'module split' }],
  };
  assert.deepEqual(resolveAuditLenses(envelope), []);
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
      { axis: 'public-api', level: 'high', rationale: 'breaking' },
      { axis: 'public-api', level: 'high', rationale: 'another break' },
      { axis: 'security', level: 'high', rationale: 'auth' },
    ],
  };
  // Repeated public-api collapses to a single audit-architecture, and the
  // ordering is stable (security first) regardless of axis order.
  assert.deepEqual(resolveAuditLenses(envelope), [
    'audit-security',
    'audit-architecture',
  ]);
});

// --- Story #3939: broadened high-risk REQUIRED-axis routing ---------------

test('resolveAuditLenses: a high-risk data-migration axis routes audit-quality', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [
      { axis: 'data-migration', level: 'high', rationale: 'schema migration' },
    ],
  };
  assert.deepEqual(resolveAuditLenses(envelope), ['audit-quality']);
});

test('resolveAuditLenses: a high-risk destructive-mutation axis routes audit-security', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [
      {
        axis: 'destructive-mutation',
        level: 'high',
        rationale: 'irreversible delete',
      },
    ],
  };
  assert.deepEqual(resolveAuditLenses(envelope), ['audit-security']);
});

test('resolveAuditLenses: a high-risk billing axis routes audit-privacy', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [{ axis: 'billing', level: 'high', rationale: 'stripe charge path' }],
  };
  assert.deepEqual(resolveAuditLenses(envelope), ['audit-privacy']);
});

test('resolveAuditLenses: a high-risk critical-workflow axis routes audit-quality', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [
      {
        axis: 'critical-workflow',
        level: 'high',
        rationale: 'checkout path',
      },
    ],
  };
  assert.deepEqual(resolveAuditLenses(envelope), ['audit-quality']);
});

test('resolveAuditLenses: the visible-behavior axis intentionally routes no lens', () => {
  const envelope = {
    overallLevel: 'high',
    axes: [
      {
        axis: 'visible-behavior',
        level: 'high',
        rationale: 'user-facing change',
      },
    ],
  };
  assert.deepEqual(resolveAuditLenses(envelope), []);
});

test('resolveAuditLenses: medium/low high-axis levels still route nothing', () => {
  // The broadened routing only fires at `high`; a medium/low judgment on any
  // of the new axes contributes no lens (parity with security/public-api).
  for (const axis of [
    'data-migration',
    'destructive-mutation',
    'billing',
    'critical-workflow',
  ]) {
    assert.deepEqual(
      resolveAuditLenses({
        overallLevel: 'medium',
        axes: [{ axis, level: 'medium', rationale: 'soft signal' }],
      }),
      [],
      `${axis} at medium must route no lens`,
    );
    assert.deepEqual(
      resolveAuditLenses({
        overallLevel: 'low',
        axes: [{ axis, level: 'low', rationale: 'low signal' }],
      }),
      [],
      `${axis} at low must route no lens`,
    );
  }
});

test('resolveAuditLenses: two distinct axes routing the same lens collapse to one', () => {
  // security + destructive-mutation both route audit-security — the result is
  // de-duplicated to a single entry.
  const envelope = {
    overallLevel: 'high',
    axes: [
      { axis: 'security', level: 'high', rationale: 'auth' },
      {
        axis: 'destructive-mutation',
        level: 'high',
        rationale: 'hard delete',
      },
    ],
  };
  assert.deepEqual(resolveAuditLenses(envelope), ['audit-security']);
});

test('resolveAuditLenses: all routed lenses come back in the canonical LENS_ORDER', () => {
  // A verdict touching every routed axis must yield the four distinct lenses
  // in the deterministic order security → architecture → quality → privacy,
  // regardless of the axis ordering in the verdict.
  const envelope = {
    overallLevel: 'high',
    axes: [
      { axis: 'billing', level: 'high', rationale: 'b' }, // audit-privacy
      { axis: 'critical-workflow', level: 'high', rationale: 'c' }, // audit-quality
      { axis: 'public-api', level: 'high', rationale: 'a' }, // audit-architecture
      { axis: 'security', level: 'high', rationale: 's' }, // audit-security
      { axis: 'data-migration', level: 'high', rationale: 'm' }, // audit-quality (dup)
    ],
  };
  assert.deepEqual(resolveAuditLenses(envelope), [
    'audit-security',
    'audit-architecture',
    'audit-quality',
    'audit-privacy',
  ]);
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
      { axis: 'public-api', level: 'high', rationale: 'breaking' },
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

// --- Story #3889: no AXIS_TO_LENS key is off-schema ------------------------

test('every routing axis is a value in the risk-verdict schema axis enum', () => {
  const enumAxes = new Set(readRiskVerdictAxisEnum());
  // The mapped axes the routing contract relies on MUST be schema-valid, else
  // the verdict-derived envelope can never carry them (dead routing). Story
  // #3939 broadened this set to every high-risk REQUIRED axis.
  for (const axis of [
    'security',
    'public-api',
    'data-migration',
    'destructive-mutation',
    'billing',
    'critical-workflow',
  ]) {
    assert.ok(
      enumAxes.has(axis),
      `routing axis "${axis}" is missing from the risk-verdict schema enum`,
    );
  }
  // The retired `architecture` axis is NOT in the enum and MUST NOT route.
  assert.ok(!enumAxes.has('architecture'));
  assert.deepEqual(
    resolveAuditLenses({
      axes: [{ axis: 'architecture', level: 'high', rationale: 'x' }],
    }),
    [],
  );
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
