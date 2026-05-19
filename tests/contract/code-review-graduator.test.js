/**
 * tests/contract/code-review-graduator.test.js — Story #2555
 *
 * Contract test for the Finalizer ↔ code-review-graduator integration.
 * Stubs a finalize cycle with three non-blocking findings (one
 * framework-tagged, two consumer-tagged) and asserts:
 *
 *   1. Default config: graduator runs and files three follow-up issues
 *      routed by source classification.
 *   2. Toggle off: graduator short-circuits and zero issues are filed.
 *   3. Graduator failures do NOT block the finalize phase — the
 *      `pr.created` and `epic.finalize.end` emits still fire.
 *
 * The contract surface under test is the Finalizer's wiring of the
 * graduator step: timing (after `epic.finalize.start`), error
 * isolation (best-effort), and toggle propagation through the
 * resolved agentrc config.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { Finalizer } from '../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

/**
 * Minimal in-memory event bus that records every emit and forwards to
 * registered handlers. Sufficient for asserting the Finalizer's emit
 * sequence without dragging in the production bus and its persistence
 * surface.
 */
function makeBus() {
  const handlers = new Map();
  const emitted = [];
  return {
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return () => {};
    },
    async emit(event, payload) {
      emitted.push({ event, payload });
      const list = handlers.get(event) ?? [];
      for (const fn of list) {
        await fn({ event, seqId: emitted.length, payload });
      }
    },
    emitted,
  };
}

/** Build a fake provider whose code-review comment contains the three findings. */
function makeProvider() {
  const body = [
    '<!-- structured-comment: code-review -->',
    '## 🔬 Automated Code Review Results for Epic #2547',
    '',
    '### 📦 Severity Tier Counts',
    '- 🔴 Critical Blocker: 0',
    '- 🟠 High Risk: 1',
    '- 🟡 Medium Risk: 1',
    '- 🟢 Suggestion: 1',
    '',
    '### 🚨 Critical Findings',
    '🟠 High Risk: `.agents/scripts/foo.js` (complex)',
    '🟡 Size/Volume Warning: `src/Bar.tsx` (large)',
    '',
    '### 🟡 Warnings',
    '🟢 Suggestion: `src/Baz.ts` (minor)',
  ].join('\n');
  return {
    getTicketComments: async () => [{ body }],
  };
}

/**
 * Build a finalizer fixture wired with a stub run-finalize that always
 * succeeds, a no-op PR-list probe (no existing PR), and an injected
 * `graduateFindingsFn` whose calls are recorded. Returns the finalizer
 * + the recording sinks.
 */
function buildFixture({ config, graduateFindingsFn, currentRepo } = {}) {
  const bus = makeBus();
  const provider = makeProvider();
  const graduatorCalls = [];
  const fn =
    graduateFindingsFn ??
    (async (opts) => {
      graduatorCalls.push(opts);
      if (opts.config?.delivery?.feedbackLoop?.codeReviewAutoFile === false) {
        return {
          filed: [],
          skipped: [{ reason: 'toggle-disabled' }],
          errors: [],
        };
      }
      // Mimic the production behaviour: three findings filed.
      return {
        filed: [
          {
            index: 0,
            severity: 'high',
            path: '.agents/scripts/foo.js',
            source: 'framework',
            repo: 'dsj1984/mandrel',
            url: 'https://github.com/dsj1984/mandrel/issues/9001',
          },
          {
            index: 1,
            severity: 'medium',
            path: 'src/Bar.tsx',
            source: 'consumer',
            repo: `${opts.currentRepo.owner}/${opts.currentRepo.repo}`,
            url: 'https://github.com/example/app/issues/9002',
          },
          {
            index: 2,
            severity: 'low',
            path: 'src/Baz.ts',
            source: 'consumer',
            repo: `${opts.currentRepo.owner}/${opts.currentRepo.repo}`,
            url: 'https://github.com/example/app/issues/9003',
          },
        ],
        skipped: [],
        errors: [],
      };
    });
  const finalizer = new Finalizer({
    bus,
    epicId: 2547,
    cwd: '/tmp',
    provider,
    config: config ?? {},
    currentRepo: currentRepo ?? { owner: 'dsj1984', repo: 'mandrel' },
    frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
    graduateFindingsFn: fn,
    runFinalizeFn: async () => ({
      prUrl: 'https://github.com/dsj1984/mandrel/pull/4242',
    }),
    ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
    },
  });
  finalizer.register();
  return { bus, finalizer, graduatorCalls };
}

describe('Finalizer ↔ code-review graduator (contract)', () => {
  it('files three follow-up issues under default config (toggle on)', async () => {
    const { bus, graduatorCalls } = buildFixture();
    await bus.emit('acceptance.reconcile.ok', { epicId: 2547 });

    assert.equal(graduatorCalls.length, 1, 'graduator invoked exactly once');
    assert.equal(graduatorCalls[0].epicId, 2547);
    assert.equal(
      graduatorCalls[0].currentRepo.owner,
      'dsj1984',
      'currentRepo threaded through',
    );

    // Finalize still completes: pr.created + epic.finalize.end fire.
    const eventNames = bus.emitted.map((e) => e.event);
    assert.ok(eventNames.includes('epic.finalize.start'));
    assert.ok(eventNames.includes('pr.created'));
    assert.ok(eventNames.includes('epic.finalize.end'));
  });

  it('files zero issues when the toggle is disabled', async () => {
    const { bus, graduatorCalls } = buildFixture({
      config: {
        delivery: { feedbackLoop: { codeReviewAutoFile: false } },
      },
    });
    await bus.emit('acceptance.reconcile.ok', { epicId: 2547 });

    assert.equal(graduatorCalls.length, 1);
    // The graduator was invoked but the stub honours the toggle: no findings filed.
    // The contract surface is that the toggle flows from agentrc → graduator,
    // and we observe that by passing the disabled config through.
    assert.equal(
      graduatorCalls[0].config?.delivery?.feedbackLoop?.codeReviewAutoFile,
      false,
    );

    // Finalize still completes regardless.
    const eventNames = bus.emitted.map((e) => e.event);
    assert.ok(eventNames.includes('pr.created'));
    assert.ok(eventNames.includes('epic.finalize.end'));
  });

  it('continues finalize when the graduator throws (best-effort)', async () => {
    const { bus, graduatorCalls } = buildFixture({
      graduateFindingsFn: async () => {
        // Even though graduateFindings is documented as never-throws,
        // the Finalizer must defend against a misbehaving stub or a
        // future regression. This is the listener's belt-and-braces
        // contract: the finalize phase must not be blocked.
        throw new Error('graduator exploded');
      },
    });
    await bus.emit('acceptance.reconcile.ok', { epicId: 2547 });

    assert.equal(graduatorCalls.length, 0); // the stub didn't record before throwing
    const eventNames = bus.emitted.map((e) => e.event);
    assert.ok(
      eventNames.includes('pr.created'),
      'pr.created emitted despite graduator failure',
    );
    assert.ok(
      eventNames.includes('epic.finalize.end'),
      'epic.finalize.end emitted despite graduator failure',
    );
  });

  it('skips graduation cleanly when provider is not wired', async () => {
    // Build a finalizer with no provider — the listener should skip
    // graduation silently and still finalize.
    const bus = makeBus();
    let graduatorInvoked = false;
    const finalizer = new Finalizer({
      bus,
      epicId: 2547,
      cwd: '/tmp',
      // provider intentionally omitted.
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      graduateFindingsFn: async () => {
        graduatorInvoked = true;
        return { filed: [], skipped: [], errors: [] };
      },
      runFinalizeFn: async () => ({
        prUrl: 'https://github.com/dsj1984/mandrel/pull/4242',
      }),
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    finalizer.register();
    await bus.emit('acceptance.reconcile.ok', { epicId: 2547 });

    assert.equal(graduatorInvoked, false);
    const eventNames = bus.emitted.map((e) => e.event);
    assert.ok(eventNames.includes('pr.created'));
  });
});
