/**
 * tests/contract/code-review-graduator.test.js — Story #2555, revised for
 * Epic #4405 (Story #4411 unification).
 *
 * Regression guard for the Finalizer's SINGLE graduation pass. After the
 * `verification-results` unification the former code-review + audit-results
 * structured-comment contracts collapsed into one comment, and BOTH former
 * graduators parsed the same 🟠/🟡/🟢 finding lines. Running both against
 * the one comment double-filed every non-blocking finding, so the Finalizer
 * now runs ONLY the lens-aware audit-results graduation pass.
 *
 * This file pins that behaviour at the Finalizer wiring boundary:
 *
 *   1. The Finalizer no longer wires any code-review graduation — a
 *      `graduateFindingsFn` handed to the constructor is ignored (the
 *      double-filing regression this fix closes).
 *   2. The single audit-results pass runs after `epic.finalize.start`,
 *      threads the resolved config through, and is error-isolated so a
 *      throwing graduator never blocks `pr.created` / `epic.finalize.end`.
 *   3. Graduation skips cleanly (and finalize still completes) when the
 *      provider is not wired.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { Finalizer } from '../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

/**
 * Minimal in-memory event bus that records every emit and forwards to
 * registered handlers.
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

/** A fake provider whose unified verification-results comment carries three findings. */
function makeProvider() {
  const body = [
    '<!-- structured-comment: verification-results -->',
    '## 🔬 Verification Results for Epic #2547',
    '',
    '### 📦 Severity Tier Counts',
    '- 🔴 Critical Blocker: 0',
    '- 🟠 High Risk: 1',
    '- 🟡 Medium Risk: 1',
    '- 🟢 Suggestion: 1',
    '',
    '#### audit-security',
    '🟠 High Risk: `.agents/scripts/foo.js` (complex)',
    '🟡 Size/Volume Warning: `src/Bar.tsx` (large)',
    '🟢 Suggestion: `src/Baz.ts` (minor)',
  ].join('\n');
  return {
    getTicketComments: async () => [{ body }],
  };
}

/**
 * Build a finalizer fixture wired with a stub run-finalize that always
 * succeeds, a no-op PR-list probe (no existing PR), and injected graduator
 * stubs whose calls are recorded. `graduateFindingsFn` is intentionally
 * still injectable so the regression guard can prove it is ignored.
 */
function buildFixture({
  config,
  graduateAuditResultsFn,
  graduateFindingsFn,
  currentRepo,
} = {}) {
  const bus = makeBus();
  const provider = makeProvider();
  const auditCalls = [];
  const codeReviewCalls = [];
  const fnAudit =
    graduateAuditResultsFn ??
    (async (opts) => {
      auditCalls.push(opts);
      if (opts.config?.delivery?.feedbackLoop?.auditResultsAutoFile === false) {
        return {
          filed: [],
          skipped: [{ reason: 'toggle-disabled' }],
          errors: [],
        };
      }
      return {
        filed: [
          {
            index: 0,
            severity: 'high',
            lens: 'audit-security',
            path: '.agents/scripts/foo.js',
            source: 'framework',
            repo: 'dsj1984/mandrel',
            url: 'https://github.com/dsj1984/mandrel/issues/9001',
          },
          {
            index: 1,
            severity: 'medium',
            lens: 'audit-security',
            path: 'src/Bar.tsx',
            source: 'consumer',
            repo: `${opts.currentRepo.owner}/${opts.currentRepo.repo}`,
            url: 'https://github.com/example/app/issues/9002',
          },
          {
            index: 2,
            severity: 'suggestion',
            lens: 'audit-security',
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
    graduateAuditResultsFn: fnAudit,
    // Deliberately still passed: the Finalizer must IGNORE it (the
    // single-pass contract). If a future change re-wires code-review
    // graduation, this stub would record a call and the regression test
    // below would fail.
    graduateFindingsFn:
      graduateFindingsFn ??
      (async (opts) => {
        codeReviewCalls.push(opts);
        return { filed: [], skipped: [], errors: [] };
      }),
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
  return { bus, finalizer, auditCalls, codeReviewCalls };
}

describe('Finalizer graduation — single canonical pass (contract)', () => {
  it('runs the audit-results pass exactly once and never the code-review pass', async () => {
    const { bus, auditCalls, codeReviewCalls } = buildFixture();
    await bus.emit('acceptance.reconcile.ok', { epicId: 2547 });

    assert.equal(
      auditCalls.length,
      1,
      'audit-results graduator invoked exactly once',
    );
    assert.equal(
      codeReviewCalls.length,
      0,
      'code-review graduator must NOT be invoked (single-pass contract)',
    );
    assert.equal(auditCalls[0].epicId, 2547);
    assert.equal(
      auditCalls[0].currentRepo.owner,
      'dsj1984',
      'currentRepo threaded through',
    );

    const eventNames = bus.emitted.map((e) => e.event);
    assert.ok(eventNames.includes('epic.finalize.start'));
    assert.ok(eventNames.includes('pr.created'));
    assert.ok(eventNames.includes('epic.finalize.end'));
  });

  it('threads a disabled toggle through to the single pass', async () => {
    const { bus, auditCalls } = buildFixture({
      config: {
        delivery: { feedbackLoop: { auditResultsAutoFile: false } },
      },
    });
    await bus.emit('acceptance.reconcile.ok', { epicId: 2547 });

    // The Finalizer gates the audit pass on the toggle before invoking it,
    // so a disabled toggle short-circuits and the graduator is never called.
    assert.equal(auditCalls.length, 0);

    const eventNames = bus.emitted.map((e) => e.event);
    assert.ok(eventNames.includes('pr.created'));
    assert.ok(eventNames.includes('epic.finalize.end'));
  });

  it('continues finalize when the graduator throws (best-effort)', async () => {
    const { bus } = buildFixture({
      graduateAuditResultsFn: async () => {
        throw new Error('graduator exploded');
      },
    });
    await bus.emit('acceptance.reconcile.ok', { epicId: 2547 });

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
    const bus = makeBus();
    let graduatorInvoked = false;
    const finalizer = new Finalizer({
      bus,
      epicId: 2547,
      cwd: '/tmp',
      // provider intentionally omitted.
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      graduateAuditResultsFn: async () => {
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
