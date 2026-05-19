/**
 * tests/audit-suite/audit-results-graduator.test.js — Story #2615
 *
 * Contract test for the audit-results graduator + Finalizer wiring. Mirrors
 * the shape of `tests/contract/code-review-graduator.test.js` (Story #2555)
 * but exercises the audit-results auto-file path:
 *
 *   1. `graduateAuditResults` short-circuits when no `audit-results`
 *      structured comment is present on the Epic.
 *   2. With seeded findings of mixed severities, only non-blocking
 *      (high/medium/low/suggestion) findings file follow-up issues; 🔴
 *      critical findings are filtered out.
 *   3. Toggle `delivery.feedbackLoop.auditResultsAutoFile = false`
 *      short-circuits the graduator (no issues filed).
 *   4. The Finalizer invokes the injected `graduateAuditResultsFn` after
 *      the `graduateFindingsFn` (code-review) call on
 *      `acceptance.reconcile.ok`, honours the toggle, and continues
 *      `pr.created` / `epic.finalize.end` emits when the graduator throws.
 *
 * Tier: contract — exercises wire shape and listener ordering. No
 * filesystem, git, or network I/O fires; all collaborators are stubbed.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { graduateAuditResults } from '../../.agents/scripts/lib/feedback-loop/audit-results-graduator.js';
import { Finalizer } from '../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

const AUDIT_RESULTS_MARKER = '<!-- claude-managed: audit-results -->';

/** Stub provider returning a fixed set of comments. */
function makeProvider(comments) {
  return {
    getTicketComments: async () => comments,
  };
}

/** In-memory event bus mirroring the code-review contract fixture. */
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

function makeMixedFindingsBody() {
  return [
    AUDIT_RESULTS_MARKER,
    '',
    '### Epic #2586 — audit results',
    '',
    'Lenses applied: audit-security, audit-privacy',
    '',
    '#### audit-security',
    '🔴 Critical Blocker: `src/auth/login.js` (missing rate limit)',
    '🟠 High Risk: `src/auth/session.js` (cookie missing sameSite)',
    '',
    '#### audit-privacy',
    '🟡 Medium: `src/api/users.ts` (PII in logs)',
    '🟢 Suggestion: `src/api/admin.ts` (consider redaction)',
  ].join('\n');
}

describe('audit-results graduator (contract)', () => {
  it('returns empty envelope when no audit-results comment exists', async () => {
    const provider = makeProvider([{ body: 'unrelated comment' }]);
    const result = await graduateAuditResults({
      epicId: 2586,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      // Inject spawnImpl that should never be called on the no-comment path.
      spawnImpl: () => {
        throw new Error('spawn must not run when no audit-results comment');
      },
    });
    assert.deepEqual(result.filed, []);
    assert.equal(result.errors.length, 0);
    const reasons = result.skipped.map((s) => s.reason);
    assert.ok(reasons.includes('no-audit-results-comment'));
  });

  it('short-circuits when auditResultsAutoFile toggle is false', async () => {
    const provider = makeProvider([{ body: makeMixedFindingsBody() }]);
    const result = await graduateAuditResults({
      epicId: 2586,
      provider,
      config: { delivery: { feedbackLoop: { auditResultsAutoFile: false } } },
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl: () => {
        throw new Error('spawn must not run when toggle is disabled');
      },
    });
    assert.deepEqual(result.filed, []);
    assert.equal(
      result.skipped.some((s) => s.reason === 'toggle-disabled'),
      true,
    );
  });

  it('filters out 🔴 critical findings; only non-blocking findings graduate', async () => {
    const provider = makeProvider([{ body: makeMixedFindingsBody() }]);
    const filed = [];
    let cwd;
    // Stub spawnImpl to: (1) return success for git cat-file probes,
    // (2) return empty list for gh search issues (no duplicates),
    // (3) record gh issue create invocations as "filed".
    const spawnImpl = (cmd, args) => {
      cwd = cmd;
      const child = makeFakeChild((onClose, onData) => {
        if (cmd === 'git' && args[0] === 'cat-file') {
          onClose(0);
          return;
        }
        if (cmd === 'gh' && args[0] === 'search') {
          onData('[]');
          onClose(0);
          return;
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
          filed.push({ cmd, args });
          onData('https://github.com/dsj1984/mandrel/issues/9999\n');
          onClose(0);
          return;
        }
        onClose(0);
      });
      return child;
    };

    const result = await graduateAuditResults({
      epicId: 2586,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl,
      // classifier stub: everything classifies as framework so we stay
      // in-repo and avoid the cross-repo skip path.
      classifier: () => 'framework',
    });
    assert.equal(cwd, 'gh', 'sanity: spawn was invoked');
    assert.equal(
      result.errors.length,
      0,
      `errors: ${result.errors.join('; ')}`,
    );
    // Exactly three non-blocking findings (high, medium, suggestion).
    assert.equal(
      result.filed.length,
      3,
      `expected 3 filed; got ${result.filed.length}`,
    );
    // 🔴 critical should never appear in filed.
    for (const f of result.filed) {
      assert.notEqual(f.severity, 'critical');
    }
    // Every filed issue carries the audit-finding meta + a severity label.
    for (const issue of filed) {
      const labelArgs = collectLabelArgs(issue.args);
      assert.ok(
        labelArgs.some((l) => /^meta::audit-finding$/.test(l)),
        `meta::audit-finding label missing: ${labelArgs.join(',')}`,
      );
      assert.ok(
        labelArgs.some((l) => /^audit-results::/.test(l)),
        `audit-results::<severity> label missing: ${labelArgs.join(',')}`,
      );
      assert.ok(
        labelArgs.some((l) => /^domain::/.test(l)),
        `domain::<lens> label missing: ${labelArgs.join(',')}`,
      );
    }
  });

  it('returns empty envelope when there are zero non-blocking findings', async () => {
    const allCriticalBody = [
      AUDIT_RESULTS_MARKER,
      '',
      '### Epic #2586 — audit results',
      '',
      '#### audit-security',
      '🔴 Critical Blocker: `src/a.js` (blocking)',
      '🔴 Critical Blocker: `src/b.js` (blocking)',
    ].join('\n');
    const provider = makeProvider([{ body: allCriticalBody }]);
    const result = await graduateAuditResults({
      epicId: 2586,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      // spawn should not fire; nothing graduates.
      spawnImpl: () => {
        throw new Error('spawn should not run when no non-blocking findings');
      },
    });
    assert.deepEqual(result.filed, []);
    assert.ok(
      result.skipped.some((s) => s.reason === 'no-non-blocking-findings'),
      'no-non-blocking-findings skip reason recorded',
    );
  });
});

describe('Finalizer ↔ audit-results graduator (contract)', () => {
  function buildFixture({
    config,
    graduateAuditResultsFn,
    throwsInAudit,
  } = {}) {
    const bus = makeBus();
    const provider = makeProvider([{ body: makeMixedFindingsBody() }]);
    const codeReviewCalls = [];
    const auditResultsCalls = [];
    const fnAudit =
      graduateAuditResultsFn ??
      (async (opts) => {
        if (throwsInAudit) throw new Error('audit graduator exploded');
        auditResultsCalls.push(opts);
        if (
          opts.config?.delivery?.feedbackLoop?.auditResultsAutoFile === false
        ) {
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
              severity: 'medium',
              path: 'src/api/users.ts',
              source: 'framework',
              repo: 'dsj1984/mandrel',
              url: 'https://github.com/dsj1984/mandrel/issues/9001',
            },
          ],
          skipped: [],
          errors: [],
        };
      });
    const finalizer = new Finalizer({
      bus,
      epicId: 2586,
      cwd: '/tmp',
      provider,
      config: config ?? {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      graduateFindingsFn: async (opts) => {
        codeReviewCalls.push({ at: Date.now(), opts });
        return { filed: [], skipped: [], errors: [] };
      },
      graduateAuditResultsFn: async (opts) => {
        const ts = Date.now();
        const result = await fnAudit(opts);
        auditResultsCalls[auditResultsCalls.length - 1]?.at &&
          (auditResultsCalls[auditResultsCalls.length - 1].at = ts);
        return result;
      },
      runFinalizeFn: async () => ({
        prUrl: 'https://github.com/dsj1984/mandrel/pull/4242',
      }),
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    finalizer.register();
    return { bus, finalizer, codeReviewCalls, auditResultsCalls };
  }

  it('invokes audit-results graduator after code-review graduator on default config', async () => {
    const { bus, codeReviewCalls, auditResultsCalls } = buildFixture();
    await bus.emit('acceptance.reconcile.ok', { epicId: 2586 });

    assert.equal(codeReviewCalls.length, 1, 'code-review graduator ran once');
    assert.equal(
      auditResultsCalls.length,
      1,
      'audit-results graduator ran once',
    );
    const events = bus.emitted.map((e) => e.event);
    assert.ok(events.includes('epic.finalize.start'));
    assert.ok(events.includes('pr.created'));
    assert.ok(events.includes('epic.finalize.end'));
  });

  it('does not invoke audit-results graduator when toggle is disabled', async () => {
    let called = false;
    const { bus } = buildFixture({
      config: { delivery: { feedbackLoop: { auditResultsAutoFile: false } } },
      graduateAuditResultsFn: async () => {
        called = true;
        return { filed: [], skipped: [], errors: [] };
      },
    });
    await bus.emit('acceptance.reconcile.ok', { epicId: 2586 });
    assert.equal(
      called,
      false,
      'graduator must not run when auditResultsAutoFile=false',
    );
    const events = bus.emitted.map((e) => e.event);
    assert.ok(events.includes('pr.created'));
    assert.ok(events.includes('epic.finalize.end'));
  });

  it('continues finalize even when audit-results graduator throws', async () => {
    const { bus } = buildFixture({ throwsInAudit: true });
    await bus.emit('acceptance.reconcile.ok', { epicId: 2586 });
    const events = bus.emitted.map((e) => e.event);
    assert.ok(
      events.includes('pr.created'),
      'pr.created emitted despite throw',
    );
    assert.ok(
      events.includes('epic.finalize.end'),
      'epic.finalize.end emitted despite throw',
    );
  });
});

/**
 * Build a minimal EventEmitter-shaped fake child process. The
 * `setupBehaviour(onClose, onData)` callback drives the stdout and exit
 * sequence; the helper schedules them on `queueMicrotask` so the
 * graduator's `Promise` resolves correctly.
 */
function makeFakeChild(setupBehaviour) {
  const handlers = { stdout: [], stderr: [], error: [], close: [] };
  const child = {
    stdout: {
      on(event, fn) {
        handlers.stdout.push(fn);
      },
    },
    stderr: {
      on(event, fn) {
        handlers.stderr.push(fn);
      },
    },
    on(event, fn) {
      handlers[event].push(fn);
    },
  };
  queueMicrotask(() => {
    const onData = (data) => {
      for (const fn of handlers.stdout) fn(data);
    };
    const onClose = (code) => {
      for (const fn of handlers.close) fn(code);
    };
    setupBehaviour(onClose, onData);
  });
  return child;
}

function collectLabelArgs(args) {
  const labels = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--label' && i + 1 < args.length) {
      labels.push(args[i + 1]);
    }
  }
  return labels;
}
