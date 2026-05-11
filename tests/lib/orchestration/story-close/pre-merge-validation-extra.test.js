/**
 * Direct branch coverage for pre-merge-validation.js.
 *
 *   - runPreMergeGates: phaseTimer.mark only for `lint`/`test` gates,
 *     gateCwd embedded into the throw message, hint suffix when gate
 *     supplies one, missing-hint elided.
 *   - emitMaintainabilityProjection: missing baselinePath short-circuit,
 *     skipped projection logging, formatted advisory split into lines,
 *     thrown error swallowed via logger.warn.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { buildDefaultGates } from '../../../../.agents/scripts/lib/close-validation.js';
import {
  emitMaintainabilityProjection,
  runPreMergeGates,
} from '../../../../.agents/scripts/lib/orchestration/story-close/pre-merge-validation.js';

function silentLogger() {
  return {
    info: mock.fn(() => {}),
    warn: mock.fn(() => {}),
  };
}

describe('runPreMergeGates — onGateStart wiring', () => {
  it('drives phaseTimer.mark only for lint and test gates', async () => {
    const phaseTimer = { mark: mock.fn(() => {}) };
    const gates = [
      { name: 'typecheck' },
      { name: 'lint' },
      { name: 'format' },
      { name: 'test' },
      { name: 'maintainability' },
    ];
    await runPreMergeGates({
      cwd: '/repo',
      agentSettings: {},
      logger: silentLogger(),
      phaseTimer,
      buildDefaultGates: () => gates,
      runCloseValidation: async ({ onGateStart }) => {
        for (const g of gates) onGateStart(g);
        return { ok: true, failed: [] };
      },
    });
    // Only lint + test should mark.
    const marked = phaseTimer.mark.mock.calls.map((c) => c.arguments[0]);
    assert.deepEqual(marked, ['lint', 'test']);
  });

  it('skips mark entirely when phaseTimer is omitted', async () => {
    await runPreMergeGates({
      cwd: '/repo',
      agentSettings: {},
      logger: silentLogger(),
      buildDefaultGates: () => [{ name: 'lint' }, { name: 'test' }],
      runCloseValidation: async ({ onGateStart }) => {
        onGateStart({ name: 'lint' });
        onGateStart({ name: 'test' });
        return { ok: true, failed: [] };
      },
    });
    // No throw + completes without phaseTimer is sufficient.
    assert.ok(true);
  });
});

describe('runPreMergeGates — failure throw shape', () => {
  it('embeds gate name, exit status, and the supplied hint', async () => {
    await assert.rejects(
      () =>
        runPreMergeGates({
          cwd: '/repo',
          agentSettings: {},
          logger: silentLogger(),
          buildDefaultGates: () => [{ name: 'lint' }],
          runCloseValidation: async () => ({
            ok: false,
            failed: [
              {
                gate: { name: 'lint', hint: 'run npm run lint -- --fix' },
                status: 2,
                cwd: '/worktree',
              },
            ],
          }),
        }),
      /lint" \(exit 2\) in \/worktree\. run npm run lint --/,
    );
  });

  it('elides hint suffix when gate has no hint', async () => {
    await assert.rejects(
      () =>
        runPreMergeGates({
          cwd: '/repo',
          agentSettings: {},
          logger: silentLogger(),
          buildDefaultGates: () => [{ name: 'format' }],
          runCloseValidation: async () => ({
            ok: false,
            failed: [
              {
                gate: { name: 'format' },
                status: 1,
                cwd: '/worktree',
              },
            ],
          }),
        }),
      (err) => {
        assert.match(err.message, /format" \(exit 1\)/);
        assert.equal(/\.\s+\.\s/.test(err.message), false);
        return true;
      },
    );
  });

  it('elides cwd suffix when gate provides none', async () => {
    await assert.rejects(
      () =>
        runPreMergeGates({
          cwd: '/repo',
          agentSettings: {},
          logger: silentLogger(),
          buildDefaultGates: () => [{ name: 'typecheck' }],
          runCloseValidation: async () => ({
            ok: false,
            failed: [
              {
                gate: { name: 'typecheck', hint: 'tsc -p tsconfig.json' },
                status: 1,
                cwd: undefined,
              },
            ],
          }),
        }),
      /typecheck" \(exit 1\)\. tsc/,
    );
  });
});

describe('runPreMergeGates — Story #1394 diff-scoped default', () => {
  it('forwards the default gate list (no explicit --changed-since) so the new diff-scoped default applies to both gates', async () => {
    // The Tech Spec for Epic #1386 flips check-{maintainability,crap}.js to
    // default to diff-scoped (`--changed-since main`). Close-validation must
    // therefore NOT inject a redundant `--changed-since` argument — the
    // gate CLI's own resolver applies the layered default. This guard fails
    // if a future refactor smuggles an opinionated ref back into the gate
    // args without first updating the precedence story (Tech Spec §4).
    const gates = buildDefaultGates({
      agentSettings: {},
      epicBranch: 'epic/1386',
    });
    const mi = gates.find((g) => g.name === 'check-maintainability');
    const crap = gates.find((g) => g.name === 'check-crap');
    assert.ok(mi, 'check-maintainability gate must be present');
    assert.ok(crap, 'check-crap gate must be present');
    assert.equal(
      mi.args.includes('--changed-since'),
      false,
      'check-maintainability must rely on the new diff-scoped default — explicit --changed-since defeats the precedence chain documented in Story #1394',
    );
    assert.equal(
      crap.args.includes('--changed-since'),
      false,
      'check-crap must rely on the new diff-scoped default — explicit --changed-since defeats the precedence chain documented in Story #1394',
    );
    assert.equal(
      mi.args.includes('--full-scope'),
      false,
      'close-validation must not opt out via --full-scope; the diff-scoped default is the documented Story-close behavior',
    );
    assert.equal(
      crap.args.includes('--full-scope'),
      false,
      'close-validation must not opt out via --full-scope; the diff-scoped default is the documented Story-close behavior',
    );
    // Story #1120: --epic-ref still flows through to read the baseline at
    // the Epic-branch HEAD. Co-asserted here because dropping it silently
    // would also be a regression even though it's not the focus of #1394.
    assert.deepEqual(
      mi.args.slice(-2),
      ['--epic-ref', 'epic/1386'],
      'check-maintainability must still receive --epic-ref',
    );
    assert.deepEqual(
      crap.args.slice(-2),
      ['--epic-ref', 'epic/1386'],
      'check-crap must still receive --epic-ref',
    );
  });
});

describe('emitMaintainabilityProjection', () => {
  it('short-circuits when no maintainability baseline path is configured', () => {
    const logger = silentLogger();
    emitMaintainabilityProjection({
      cwd: '/repo',
      agentSettings: {},
      logger,
      getBaselines: () => ({ maintainability: { path: null } }),
      projectMaintainabilityRegressions: () => {
        throw new Error('should not be called');
      },
      formatMaintainabilityProjection: () => 'ignored',
    });
    assert.equal(logger.warn.mock.callCount(), 0);
    assert.equal(logger.info.mock.callCount(), 0);
  });

  it('logs each advisory line via logger.info when projection produces output', () => {
    const logger = silentLogger();
    emitMaintainabilityProjection({
      cwd: '/repo',
      agentSettings: { quality: {} },
      logger,
      getBaselines: () => ({
        maintainability: { path: 'baselines/maintainability.json' },
      }),
      projectMaintainabilityRegressions: () => ({ projected: 2 }),
      formatMaintainabilityProjection: () =>
        '[advisory] line 1\n[advisory] line 2',
    });
    const calls = logger.info.mock.calls.map((c) => c.arguments[0]);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /line 1/);
    assert.match(calls[1], /line 2/);
  });

  it('logs `skipped` reason when no advisory is produced and projection is.skipped', () => {
    const logger = silentLogger();
    emitMaintainabilityProjection({
      cwd: '/repo',
      agentSettings: {},
      logger,
      getBaselines: () => ({
        maintainability: { path: 'baselines/maintainability.json' },
      }),
      projectMaintainabilityRegressions: () => ({ skipped: 'no-changes' }),
      formatMaintainabilityProjection: () => '',
    });
    const calls = logger.info.mock.calls.map((c) => c.arguments[0]);
    assert.equal(
      calls.some((m) => /skipped \(no-changes\)/.test(m)),
      true,
    );
  });

  it('does nothing observable when projection is empty and not skipped', () => {
    const logger = silentLogger();
    emitMaintainabilityProjection({
      cwd: '/repo',
      agentSettings: {},
      logger,
      getBaselines: () => ({
        maintainability: { path: 'baselines/maintainability.json' },
      }),
      projectMaintainabilityRegressions: () => ({}),
      formatMaintainabilityProjection: () => '',
    });
    assert.equal(logger.warn.mock.callCount(), 0);
    assert.equal(logger.info.mock.callCount(), 0);
  });

  it('swallows projection throw via logger.warn (non-fatal advisory)', () => {
    const logger = silentLogger();
    assert.doesNotThrow(() =>
      emitMaintainabilityProjection({
        cwd: '/repo',
        agentSettings: {},
        logger,
        getBaselines: () => ({
          maintainability: { path: 'baselines/maintainability.json' },
        }),
        projectMaintainabilityRegressions: () => {
          throw new Error('escomplex died');
        },
        formatMaintainabilityProjection: () => '',
      }),
    );
    assert.equal(logger.warn.mock.callCount(), 1);
    assert.match(
      logger.warn.mock.calls[0].arguments[0],
      /MI projection failed.*escomplex died/,
    );
  });

  it('handles non-Error throws by stringifying them', () => {
    const logger = silentLogger();
    emitMaintainabilityProjection({
      cwd: '/repo',
      agentSettings: {},
      logger,
      getBaselines: () => ({
        maintainability: { path: 'baselines/maintainability.json' },
      }),
      projectMaintainabilityRegressions: () => {
        throw 'string thrown';
      },
      formatMaintainabilityProjection: () => '',
    });
    assert.equal(logger.warn.mock.callCount(), 1);
    assert.match(
      logger.warn.mock.calls[0].arguments[0],
      /MI projection failed: string thrown/,
    );
  });
});
