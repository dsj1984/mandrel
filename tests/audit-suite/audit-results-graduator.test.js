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
 *   4. The Finalizer invokes the injected `graduateAuditResultsFn` as the
 *      SINGLE graduation pass on `acceptance.reconcile.ok` (Story #4411
 *      collapsed the former dual code-review + audit-results passes into
 *      one canonical pass over the unified `verification-results` comment),
 *      honours the toggle, and continues `pr.created` / `epic.finalize.end`
 *      emits when the graduator throws.
 *
 * Tier: contract — exercises wire shape and listener ordering. No
 * filesystem, git, or network I/O fires; all collaborators are stubbed.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { graduateAuditResults } from '../../.agents/scripts/lib/feedback-loop/audit-results-graduator.js';
import {
  NO_VERIFICATION_RESULTS_COMMENT_REASON,
  VERIFICATION_RESULTS_MARKER,
} from '../../.agents/scripts/lib/feedback-loop/graduator-core.js';
import { Finalizer } from '../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

// Story #4411 — the audit graduator now reads the unified
// `verification-results` structured comment; the source-comment fixtures
// carry that one marker rather than the retired audit-results marker.
const AUDIT_RESULTS_MARKER = VERIFICATION_RESULTS_MARKER;

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
    assert.ok(reasons.includes(NO_VERIFICATION_RESULTS_COMMENT_REASON));
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

  it('reports validation errors for missing required collaborators', async () => {
    const invalidEpic = await graduateAuditResults({
      epicId: 0,
      provider: makeProvider([]),
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
    });
    assert.match(invalidEpic.errors[0], /missing or invalid epicId/);

    const invalidProvider = await graduateAuditResults({
      epicId: 2586,
      provider: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
    });
    assert.match(invalidProvider.errors[0], /provider lacks getTicketComments/);

    const invalidRepo = await graduateAuditResults({
      epicId: 2586,
      provider: makeProvider([]),
      currentRepo: { owner: 'dsj1984' },
    });
    assert.match(invalidRepo.errors[0], /missing currentRepo/);
  });

  it('records provider read failures without throwing', async () => {
    const result = await graduateAuditResults({
      epicId: 2586,
      provider: {
        async getTicketComments() {
          throw new Error('api unavailable');
        },
      },
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
    });

    assert.deepEqual(result.filed, []);
    assert.match(result.errors[0], /getTicketComments failed.*api unavailable/);
  });

  it('skips removed files before routing or filing', async () => {
    const provider = makeProvider([{ body: makeMixedFindingsBody() }]);
    const result = await graduateAuditResults({
      epicId: 2586,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl: (cmd, args) =>
        makeFakeChild((onClose) => {
          assert.equal(cmd, 'git');
          assert.equal(args[0], 'cat-file');
          onClose(1);
        }),
    });

    assert.deepEqual(result.filed, []);
    assert.equal(result.skipped.length, 3);
    assert.ok(result.skipped.every((s) => s.reason === 'file-removed'));
  });

  it('defers cross-repo framework findings instead of shelling out across repos', async () => {
    const provider = makeProvider([{ body: makeMixedFindingsBody() }]);
    const logLines = [];
    const result = await graduateAuditResults({
      epicId: 2586,
      provider,
      config: {},
      currentRepo: { owner: 'consumer', repo: 'app' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      classifier: () => 'framework',
      logger: { info: (line) => logLines.push(line) },
      spawnImpl: (cmd, args) =>
        makeFakeChild((onClose) => {
          assert.equal(cmd, 'git');
          assert.equal(args[0], 'cat-file');
          onClose(0);
        }),
    });

    assert.deepEqual(result.filed, []);
    assert.equal(result.skipped.length, 3);
    assert.ok(result.skipped.every((s) => s.reason === 'cross-repo-deferred'));
    assert.ok(
      logLines.some((line) => line.includes('would file in dsj1984/mandrel')),
    );
  });

  it('skips findings whose idempotency marker is already filed', async () => {
    const provider = makeProvider([{ body: makeMixedFindingsBody() }]);
    const result = await graduateAuditResults({
      epicId: 2586,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      classifier: () => 'consumer',
      spawnImpl: (cmd, args) =>
        makeFakeChild((onClose, onData) => {
          if (cmd === 'git') {
            onClose(0);
            return;
          }
          assert.equal(args[0], 'search');
          onData('[{"number":123}]');
          onClose(0);
        }),
    });

    assert.deepEqual(result.filed, []);
    assert.equal(result.skipped.length, 3);
    assert.ok(result.skipped.every((s) => s.reason === 'already-filed'));
  });

  it('records issue creation failures and continues processing', async () => {
    const provider = makeProvider([{ body: makeMixedFindingsBody() }]);
    const result = await graduateAuditResults({
      epicId: 2586,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      classifier: () => 'consumer',
      spawnImpl: (cmd, args) =>
        makeFakeChild((onClose, onData) => {
          if (cmd === 'git') {
            onClose(0);
            return;
          }
          if (args[0] === 'search') {
            onData('[]');
            onClose(0);
            return;
          }
          assert.equal(args[0], 'issue');
          onClose(1);
        }),
    });

    assert.deepEqual(result.filed, []);
    assert.equal(result.errors.length, 3);
    assert.ok(
      result.errors.every((error) =>
        error.includes('gh issue create exited 1'),
      ),
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
      graduateAuditResultsFn: async (opts) => fnAudit(opts),
      runFinalizeFn: async () => ({
        prUrl: 'https://github.com/dsj1984/mandrel/pull/4242',
      }),
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    finalizer.register();
    return { bus, finalizer, auditResultsCalls };
  }

  it('invokes the audit-results graduator as the single graduation pass on default config', async () => {
    const { bus, auditResultsCalls } = buildFixture();
    await bus.emit('acceptance.reconcile.ok', { epicId: 2586 });

    assert.equal(
      auditResultsCalls.length,
      1,
      'audit-results graduator ran exactly once (single canonical pass)',
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
      on(_event, fn) {
        handlers.stdout.push(fn);
      },
    },
    stderr: {
      on(_event, fn) {
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
