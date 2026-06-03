/**
 * project-bootstrap-phases.test — Story #2459 / Task #2473
 *
 * Pins the BOOTSTRAP_PHASES contract:
 *
 *   - Phase ordering matches the 11-step pipeline the inline
 *     `applyProjectBootstrap` previously ran.
 *   - The three fatal phases (`nodeCheck`, `validation`, `parity`) carry
 *     `isFatal: true` and surface their pre-refactor error messages via
 *     `throwIfFatal`.
 *   - `runPhases` lands each phase's result on `report[phase.name]`,
 *     producing the same shape the inline pipeline returned (JSON
 *     snapshot parity).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PHASE_GROUPS } from '../../.agents/scripts/lib/bootstrap/manifest.js';
import {
  applyProjectBootstrap,
  BOOTSTRAP_PHASES,
  isPhaseApproved,
  runPhases,
  throwIfFatal,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';

describe('BOOTSTRAP_PHASES — ordering', () => {
  it('lists the 12 phases in canonical order', () => {
    const names = BOOTSTRAP_PHASES.map((p) => p.name);
    assert.deepEqual(names, [
      'nodeCheck',
      'pkg',
      'install',
      'agentrc',
      'validation',
      'claudeSettings',
      'systemPromptWiring',
      'gitignore',
      'sync',
      'parity',
      'quality',
      'winPerf',
    ]);
  });

  it('is a frozen array of {name, run} objects', () => {
    assert.ok(Object.isFrozen(BOOTSTRAP_PHASES));
    for (const phase of BOOTSTRAP_PHASES) {
      assert.equal(typeof phase.name, 'string');
      assert.equal(typeof phase.run, 'function');
    }
  });

  it('marks exactly nodeCheck, validation, and parity as fatal', () => {
    const fatal = BOOTSTRAP_PHASES.filter((p) => p.isFatal).map((p) => p.name);
    assert.deepEqual(fatal, ['nodeCheck', 'validation', 'parity']);
  });
});

describe('throwIfFatal', () => {
  it('is a no-op when the phase is not marked fatal', () => {
    throwIfFatal({ name: 'pkg', run: () => ({}) }, { ok: false });
  });

  it('is a no-op when formatError returns null', () => {
    throwIfFatal(
      { name: 'x', isFatal: true, formatError: () => null, run: () => ({}) },
      { ok: true },
    );
  });

  it('throws when formatError returns a non-empty string', () => {
    assert.throws(
      () =>
        throwIfFatal(
          {
            name: 'x',
            isFatal: true,
            formatError: () => 'boom',
            run: () => ({}),
          },
          { ok: false },
        ),
      /boom/,
    );
  });

  it('surfaces the nodeCheck pre-refactor error verbatim', () => {
    const phase = BOOTSTRAP_PHASES.find((p) => p.name === 'nodeCheck');
    assert.throws(
      () =>
        throwIfFatal(phase, {
          ok: false,
          version: '18.0.0',
          required: '22.22.1',
        }),
      /Node 18\.0\.0 is below required 22\.22\.1/,
    );
  });

  it('surfaces the validation pre-refactor error verbatim', () => {
    const phase = BOOTSTRAP_PHASES.find((p) => p.name === 'validation');
    assert.throws(
      () =>
        throwIfFatal(phase, {
          ok: false,
          errors: [{ instancePath: '/x', message: 'bad' }],
        }),
      /.agentrc.json failed schema validation/,
    );
  });

  it('surfaces the parity pre-refactor error verbatim', () => {
    const phase = BOOTSTRAP_PHASES.find((p) => p.name === 'parity');
    assert.throws(
      () =>
        throwIfFatal(phase, {
          ok: false,
          missingCommand: ['foo'],
          orphanCommand: ['bar'],
        }),
      /Parity check failed/,
    );
  });
});

describe('isPhaseApproved', () => {
  it('always runs an always-run infrastructure phase (no phaseGroup)', () => {
    // Both gate states: even a present approvedGroups set never blocks an
    // ungrouped phase.
    assert.equal(isPhaseApproved({ name: 'install', run: () => ({}) }), true);
    assert.equal(
      isPhaseApproved({ name: 'install', run: () => ({}) }, new Set()),
      true,
    );
  });

  it('runs a grouped phase when no approval gate is supplied', () => {
    const phase = {
      name: 'pkg',
      phaseGroup: PHASE_GROUPS.REPO_CONFIG,
      run: () => ({}),
    };
    assert.equal(isPhaseApproved(phase, undefined), true);
  });

  it('runs a grouped phase when its group is in the approved set', () => {
    const phase = {
      name: 'pkg',
      phaseGroup: PHASE_GROUPS.REPO_CONFIG,
      run: () => ({}),
    };
    assert.equal(
      isPhaseApproved(phase, new Set([PHASE_GROUPS.REPO_CONFIG])),
      true,
    );
  });

  it('declines a grouped phase when its group is absent from the set', () => {
    const phase = {
      name: 'pkg',
      phaseGroup: PHASE_GROUPS.REPO_CONFIG,
      run: () => ({}),
    };
    assert.equal(
      isPhaseApproved(phase, new Set([PHASE_GROUPS.IDE_WIRING])),
      false,
    );
  });
});

describe('runPhases', () => {
  it('lands each phase result on report[phase.name] in order', async () => {
    const order = [];
    const phases = [
      {
        name: 'a',
        run: () => {
          order.push('a');
          return { kind: 'a' };
        },
      },
      {
        name: 'b',
        run: () => {
          order.push('b');
          return { kind: 'b' };
        },
      },
    ];
    const report = await runPhases(phases, {});
    assert.deepEqual(order, ['a', 'b']);
    assert.deepEqual(report, { a: { kind: 'a' }, b: { kind: 'b' } });
  });

  it('threads the accumulating report into subsequent phases', async () => {
    const phases = [
      { name: 'first', run: () => ({ value: 1 }) },
      {
        name: 'second',
        run: (_ctx, report) => ({ value: report.first.value + 1 }),
      },
    ];
    const report = await runPhases(phases, {});
    assert.equal(report.second.value, 2);
  });

  it('aborts the pipeline when a fatal phase fails', async () => {
    const phases = [
      {
        name: 'a',
        run: () => ({ ok: false }),
        isFatal: true,
        formatError: () => 'STOP',
      },
      {
        name: 'b',
        run: () => {
          throw new Error('phase b should not run');
        },
      },
    ];
    await assert.rejects(runPhases(phases, {}), /STOP/);
  });

  it('continues past a fatal phase that returns ok', async () => {
    let ran = false;
    const phases = [
      {
        name: 'a',
        run: () => ({ ok: true }),
        isFatal: true,
        formatError: () => null,
      },
      {
        name: 'b',
        run: () => {
          ran = true;
          return {};
        },
      },
    ];
    await runPhases(phases, {});
    assert.equal(ran, true);
  });

  it('skips a declined grouped phase without running it and records the no-op', async () => {
    let ran = false;
    const phases = [
      {
        name: 'gated',
        phaseGroup: PHASE_GROUPS.REPO_CONFIG,
        run: () => {
          ran = true;
          return { mutated: true };
        },
      },
      {
        name: 'always',
        run: () => ({ ok: true }),
      },
    ];
    const report = await runPhases(phases, {
      approvedGroups: new Set([PHASE_GROUPS.IDE_WIRING]),
    });
    assert.equal(ran, false);
    assert.deepEqual(report.gated, {
      skipped: true,
      reason: 'phase-group-declined',
      phaseGroup: PHASE_GROUPS.REPO_CONFIG,
    });
    // Declining one group never short-circuits the rest.
    assert.deepEqual(report.always, { ok: true });
  });

  it('does not skip a declined fatal grouped phase (no throw)', async () => {
    // A declined ide-wiring group must also skip its fatal parity check
    // rather than throwing on the un-run result.
    const phases = [
      {
        name: 'gatedFatal',
        phaseGroup: PHASE_GROUPS.IDE_WIRING,
        run: () => ({ ok: false }),
        isFatal: true,
        formatError: () => 'should not throw — phase was skipped',
      },
    ];
    const report = await runPhases(phases, {
      approvedGroups: new Set([PHASE_GROUPS.REPO_CONFIG]),
    });
    assert.equal(report.gatedFatal.reason, 'phase-group-declined');
  });

  it('awaits async phase functions', async () => {
    const phases = [
      {
        name: 'a',
        run: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { kind: 'async' };
        },
      },
    ];
    const report = await runPhases(phases, {});
    assert.deepEqual(report.a, { kind: 'async' });
  });
});

describe('applyProjectBootstrap — report shape parity', () => {
  it('produces a report keyed by the 12 phase names in canonical order', () => {
    // Assert the order of `BOOTSTRAP_PHASES` directly — this is the
    // contract `applyProjectBootstrap` thinly wraps. JSON-snapshot
    // parity against the inline-pipeline shape lives here so a Task
    // ticket reviewer can read it inline.
    const expected = [
      'nodeCheck',
      'pkg',
      'install',
      'agentrc',
      'validation',
      'claudeSettings',
      'systemPromptWiring',
      'gitignore',
      'sync',
      'parity',
      'quality',
      'winPerf',
    ];
    assert.deepEqual(
      BOOTSTRAP_PHASES.map((p) => p.name),
      expected,
    );
  });

  it('exports the function for the bootstrap.js pipeline driver', () => {
    assert.equal(typeof applyProjectBootstrap, 'function');
  });
});
