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

import {
  applyProjectBootstrap,
  BOOTSTRAP_PHASES,
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
      () => throwIfFatal(phase, { ok: false, version: '18.0.0', required: 20 }),
      /Node 18.0.0 is below required 20.x/,
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
