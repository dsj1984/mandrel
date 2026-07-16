// lib/cli/__tests__/update-plan.test.js
/**
 * Unit tests for the pure `planUpdate` decision function in lib/cli/update.js
 * (Story #4182 — extract the update-plan seam).
 *
 * `planUpdate({ current, target, dryRun, hasDrift }) -> { action, steps, variant? }`
 * encodes the four-way decision (`up-to-date` / `dry-run` / `resynced` /
 * `updated`) and the ordered per-action phase plan with **no** I/O. Because it
 * is a pure value, the branch-selection and step-sequencing logic that used to
 * be braided into the side-effecting orchestration can be asserted directly as
 * a table over plain inputs — no seams stubbed, no async drive of `spawnPhase`
 * / `write` / `exit`.
 *
 * Tier: unit (testing-standards § Unit). The function is pure — no network,
 * filesystem, child-process, or time source is touched.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): fixtures carry
 * only version strings and boolean flags; no tokens or credentials.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planUpdate } from '../update.js';

/** The phase `label`s a full upgrade drives, in order (the `stepsRun` contract). */
const FULL_UPGRADE_LABELS = [
  'npm-update',
  'runSync',
  'sync-commands',
  'sync-agents',
  'runMigrations',
  'doctor',
];

/** The phase `label`s a drift heal drives, in order. */
const DRIFT_HEAL_LABELS = ['runSync', 'sync-commands', 'sync-agents'];

// ---------------------------------------------------------------------------
// Table-driven: the full four-way decision matrix
// ---------------------------------------------------------------------------

describe('planUpdate — decision matrix (Story #4182)', () => {
  /**
   * Each row pins one input combination to its expected action / variant and
   * the ordered `label`s of the returned steps. `current`/`target` encode the
   * "version current" axis (target <= current) vs the "version bump" axis
   * (target > current); `dryRun` and `hasDrift` are the two flags.
   */
  const cases = [
    {
      name: 'version current + no drift → up-to-date (true no-op)',
      input: {
        current: '1.61.0',
        target: '1.61.0',
        dryRun: false,
        hasDrift: false,
      },
      action: 'up-to-date',
      variant: undefined,
      labels: [],
    },
    {
      name: 'version current + drift → resynced (sync heal)',
      input: {
        current: '1.61.0',
        target: '1.61.0',
        dryRun: false,
        hasDrift: true,
      },
      action: 'resynced',
      variant: undefined,
      labels: DRIFT_HEAL_LABELS,
    },
    {
      name: 'version current + drift + dry-run → dry-run (drift-heal variant)',
      input: {
        current: '1.61.0',
        target: '1.61.0',
        dryRun: true,
        hasDrift: true,
      },
      action: 'dry-run',
      variant: 'drift-heal',
      labels: [],
    },
    {
      name: 'version current + no drift + dry-run → up-to-date (dryRun is moot without drift)',
      input: {
        current: '1.61.0',
        target: '1.61.0',
        dryRun: true,
        hasDrift: false,
      },
      action: 'up-to-date',
      variant: undefined,
      labels: [],
    },
    {
      name: 'version bump + no dry-run → updated (full upgrade)',
      input: {
        current: '1.43.0',
        target: '1.44.0',
        dryRun: false,
        hasDrift: false,
      },
      action: 'updated',
      variant: undefined,
      labels: FULL_UPGRADE_LABELS,
    },
    {
      name: 'version bump + dry-run → dry-run (full-upgrade variant)',
      input: {
        current: '1.43.0',
        target: '1.44.0',
        dryRun: true,
        hasDrift: false,
      },
      action: 'dry-run',
      variant: 'full-upgrade',
      labels: [],
    },
    {
      name: 'version bump + drift is irrelevant on the upgrade path → updated',
      input: {
        current: '1.43.0',
        target: '1.44.0',
        dryRun: false,
        hasDrift: true,
      },
      action: 'updated',
      variant: undefined,
      labels: FULL_UPGRADE_LABELS,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const plan = planUpdate(c.input);
      assert.equal(plan.action, c.action, 'action');
      assert.equal(plan.variant, c.variant, 'variant');
      assert.deepEqual(
        plan.steps.map((s) => s.label),
        c.labels,
        'ordered step labels',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Step descriptor shape — the executor depends on these fields
// ---------------------------------------------------------------------------

describe('planUpdate — step descriptor shape', () => {
  it('threads the version range into the migrate phase argv on a full upgrade', () => {
    const plan = planUpdate({
      current: '1.43.0',
      target: '2.0.0',
      dryRun: false,
      hasDrift: false,
    });
    const migrate = plan.steps.find((s) => s.phase === 'migrate');
    assert.ok(migrate, 'a migrate step is present on a full upgrade');
    assert.deepEqual(migrate.args, ['--from', '1.43.0', '--to', '2.0.0']);
  });

  it('marks the first step as the npm-update kind and the doctor step as the doctor kind', () => {
    const plan = planUpdate({
      current: '1.43.0',
      target: '1.44.0',
      dryRun: false,
      hasDrift: false,
    });
    assert.equal(plan.steps[0].kind, 'npm-update');
    const doctor = plan.steps.find((s) => s.label === 'doctor');
    assert.equal(doctor.kind, 'doctor');
    // The doctor step is soft-fail — it carries no fatal failMessage.
    assert.equal(doctor.failMessage, undefined);
  });

  it('gives every fatal spawn step (sync/sync-commands/migrate) a failMessage', () => {
    const plan = planUpdate({
      current: '1.43.0',
      target: '1.44.0',
      dryRun: false,
      hasDrift: false,
    });
    for (const step of plan.steps) {
      if (step.kind === 'spawn') {
        assert.ok(
          typeof step.failMessage === 'string' && step.failMessage.length > 0,
          `spawn step '${step.label}' must carry a failMessage`,
        );
      }
    }
  });

  it('drift-heal steps are sync + sync-commands + sync-agents only (no npm-update, migrate, or doctor)', () => {
    const plan = planUpdate({
      current: '1.61.0',
      target: '1.61.0',
      dryRun: false,
      hasDrift: true,
    });
    assert.deepEqual(
      plan.steps.map((s) => s.phase),
      ['sync', 'sync-commands', 'sync-agents'],
    );
    assert.ok(
      plan.steps.every((s) => s.kind === 'spawn'),
      'every drift-heal step is a spawn (no npm-update / doctor kinds)',
    );
  });

  it('returns an empty step list for every non-executing action', () => {
    for (const input of [
      { current: '1.61.0', target: '1.61.0', dryRun: false, hasDrift: false }, // up-to-date
      { current: '1.61.0', target: '1.61.0', dryRun: true, hasDrift: true }, // dry-run (heal)
      { current: '1.43.0', target: '1.44.0', dryRun: true, hasDrift: false }, // dry-run (upgrade)
    ]) {
      assert.deepEqual(planUpdate(input).steps, [], JSON.stringify(input));
    }
  });
});
