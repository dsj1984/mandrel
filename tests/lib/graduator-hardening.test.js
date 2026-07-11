/**
 * tests/lib/graduator-hardening.test.js — Story #4415 / Epic #4406.
 *
 * Pins the graduator-hardening contract: content-hash idempotency
 * fingerprints (with legacy-marker recognition), a bounded `runChild`
 * spawn timeout, a per-run filing cap, the pre-parsed / path-less
 * `graduate()` seam the retro auto-filer consumes, the probe-error vs
 * confirmed-missing distinction, and durable persistence of
 * cross-repo-deferred findings as a structured comment on the Epic.
 *
 * All gh/git child processes are stubbed via the `spawnImpl` seam and the
 * provider is a stub — no real network, git, or filesystem access.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  buildContentMarker as buildAuditContentMarker,
  buildIdempotencyMarker as buildAuditLegacyMarker,
  parseFindings as parseAuditFindings,
} from '../../.agents/scripts/lib/feedback-loop/audit-results-graduator.js';
import {
  buildContentMarker as buildCodeReviewContentMarker,
  graduateFindings,
} from '../../.agents/scripts/lib/feedback-loop/code-review-graduator.js';
import {
  contentFingerprint,
  graduate,
  runChild,
} from '../../.agents/scripts/lib/feedback-loop/graduator-core.js';
import {
  _resetStructuredCommentCache,
  findStructuredComment,
} from '../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Route a spawn by command / first args to a responder returning
 * `{ stdout, stderr, code }`. `git` requests carry the probed path in the
 * last arg (`HEAD:<path>`); `gh search` carries the probed marker at
 * args[2]. Throwing inside a responder simulates a synchronous spawn
 * failure. Records every call for assertion.
 */
function makeSpawnStub(routes) {
  const calls = [];
  const fn = function spawnImpl(cmd, args) {
    calls.push({ cmd, args });
    if (cmd === 'git' && routes.gitThrows) throw new Error('git spawn boom');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let result;
    if (cmd === 'git') {
      result = routes.git ? routes.git(args) : { stdout: '', code: 0 };
    } else if (args[0] === 'search') {
      result = routes.ghSearch
        ? routes.ghSearch(args)
        : { stdout: '[]', code: 0 };
    } else if (args[0] === 'issue' && args[1] === 'create') {
      result = routes.ghCreate
        ? routes.ghCreate(args)
        : { stdout: 'https://github.com/o/r/issues/1', code: 0 };
    } else {
      result = { stdout: '', code: 0 };
    }
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code ?? 0);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** A minimal generic spec for the parametrized `graduate()` walk. */
function makeSpec(overrides = {}) {
  return {
    fnName: 'testGraduate',
    isAutoFileEnabled: () => true,
    commentMarker: '<!-- test-marker -->',
    noCommentReason: 'no-test-comment',
    parseFindings: () => [],
    buildContentMarker: (epicId, finding) =>
      `<!-- content-${epicId}-${contentFingerprint({
        category: finding.severity,
        path: finding.path,
        title: finding.summary,
      })} -->`,
    buildLegacyMarker: (epicId, index) =>
      `<!-- legacy-${epicId}-finding-${index} -->`,
    buildCrossRepoLog: ({ routedRepo }) =>
      `xrepo would file in ${routedRepo.owner}/${routedRepo.repo}`,
    buildFollowUp: ({ finding, source, epicId, idMarker }) => ({
      title: `t ${finding.path}`,
      body: `${idMarker} ${source} ${epicId}`,
      labels: ['lbl'],
    }),
    crossRepoCommentAttrs: { graduator: 'test' },
    ...overrides,
  };
}

/** A provider stub that records upserted comments. */
function makeRecordingProvider(initialComments = []) {
  const posted = [];
  const provider = {
    getTicketComments: async () => initialComments,
    postComment: async (ticketId, { type, body }) => {
      posted.push({ ticketId, type, body });
      return { id: posted.length };
    },
    deleteComment: async () => {},
  };
  provider.posted = posted;
  return provider;
}

describe('AC1 — content-hash idempotency markers', () => {
  it('keeps a finding marker stable across sibling reorder / insert', () => {
    const bodyA = [
      '<!-- claude-managed: audit-results -->',
      '#### audit-security',
      '🟠 high finding in `src/api.js`',
      '🟡 medium finding in `src/util.js`',
    ].join('\n');
    // Reordered + a sibling inserted; the src/api.js finding now has a
    // different parse index but identical content.
    const bodyB = [
      '<!-- claude-managed: audit-results -->',
      '#### audit-security',
      '🟢 suggestion in `src/new.js`',
      '🟡 medium finding in `src/util.js`',
      '🟠 high finding in `src/api.js`',
    ].join('\n');
    const apiA = parseAuditFindings(bodyA).find((f) => f.path === 'src/api.js');
    const apiB = parseAuditFindings(bodyB).find((f) => f.path === 'src/api.js');
    assert.notEqual(apiA.index, apiB.index, 'parse index must have shifted');
    assert.equal(
      buildAuditContentMarker(2586, apiA),
      buildAuditContentMarker(2586, apiB),
      'content marker must survive sibling churn',
    );
  });

  it('gives two distinct findings distinct markers', () => {
    const findings = parseAuditFindings(
      [
        '<!-- claude-managed: audit-results -->',
        '#### audit-security',
        '🟠 high finding in `src/api.js`',
        '🟡 medium finding in `src/util.js`',
      ].join('\n'),
    );
    const m0 = buildAuditContentMarker(2586, findings[0]);
    const m1 = buildAuditContentMarker(2586, findings[1]);
    assert.notEqual(m0, m1);
  });

  it('code-review markers are content-derived and collision-free', () => {
    const a = buildCodeReviewContentMarker(42, {
      severity: 'high',
      path: 'src/a.js',
      summary: 'one',
    });
    const b = buildCodeReviewContentMarker(42, {
      severity: 'high',
      path: 'src/b.js',
      summary: 'two',
    });
    assert.notEqual(a, b);
    assert.match(a, /^<!-- code-review-followup: epic-42-[0-9a-f]{16} -->$/);
  });
});

describe('AC2 — runChild bounded timeout', () => {
  it('kills a stalling child and resolves a timeout-shaped error', async () => {
    const killed = [];
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (sig) => killed.push(sig);
      return child; // never emits 'close'
    };
    const res = await runChild({
      cmd: 'gh',
      args: ['search', 'issues'],
      spawnImpl,
      timeoutMs: 25,
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.code, null);
    assert.ok(res.spawnError, 'a timeout must surface a spawnError');
    assert.deepEqual(killed, ['SIGKILL']);
  });

  it('honors a caller-overridden timeout and resolves normally under it', async () => {
    const spawnImpl = makeSpawnStub({ git: () => ({ code: 0 }) });
    const res = await runChild({
      cmd: 'git',
      args: ['x'],
      spawnImpl,
      timeoutMs: 5000,
    });
    assert.equal(res.timedOut, false);
    assert.equal(res.code, 0);
  });
});

describe('AC3 — per-run filing cap', () => {
  it('stops filing at maxFilingsPerRun and records the excess as cap-reached', async () => {
    const findings = [
      { severity: 'low', path: 'src/a.js', summary: 'a', index: 0 },
      { severity: 'low', path: 'src/b.js', summary: 'b', index: 1 },
      { severity: 'low', path: 'src/c.js', summary: 'c', index: 2 },
    ];
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghCreate: () => ({ stdout: 'https://x/issues/1', code: 0 }),
    });
    const env = await graduate({
      epicId: 4406,
      provider: { getTicketComments: async () => [] },
      currentRepo: { owner: 'o', repo: 'r' },
      classifier: () => 'consumer',
      spawnImpl,
      findings,
      maxFilingsPerRun: 2,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 2);
    const capped = env.skipped.filter((s) => s.reason === 'cap-reached');
    assert.equal(capped.length, 1);
    assert.equal(capped[0].path, 'src/c.js');
  });
});

describe('AC4 — pre-parsed findings + path-less seam', () => {
  it('bypasses structured-comment parsing when findings are supplied', async () => {
    let getCommentsCalled = false;
    const provider = {
      getTicketComments: async () => {
        getCommentsCalled = true;
        return [];
      },
    };
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghCreate: () => ({ stdout: 'https://x/issues/9', code: 0 }),
    });
    const env = await graduate({
      epicId: 4406,
      provider,
      currentRepo: { owner: 'o', repo: 'r' },
      classifier: () => 'consumer',
      spawnImpl,
      findings: [{ severity: 'low', path: 'src/x.js', summary: 's', index: 0 }],
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 1);
    assert.equal(
      getCommentsCalled,
      false,
      'pre-parsed findings must bypass the comment read',
    );
  });

  it('a path-less finding skips the path-exists gate instead of file-removed', async () => {
    // git cat-file would exit non-zero (→ file-removed) if it were probed.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 1 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghCreate: () => ({ stdout: 'https://x/issues/3', code: 0 }),
    });
    const env = await graduate({
      epicId: 4406,
      provider: { getTicketComments: async () => [] },
      currentRepo: { owner: 'o', repo: 'r' },
      classifier: () => 'consumer',
      spawnImpl,
      findings: [{ severity: 'low', path: null, summary: 'no-path', index: 0 }],
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 1, 'path-less finding must be filed');
    assert.equal(
      env.skipped.filter((s) => s.reason === 'file-removed').length,
      0,
      'a path-less finding must not be misclassified file-removed',
    );
    // git cat-file must never have been invoked for a path-less finding.
    assert.equal(spawnImpl.calls.filter((c) => c.cmd === 'git').length, 0);
  });
});

describe('AC5 — legacy (epicId, parse-index) marker recognition', () => {
  it('skips re-filing when only the legacy marker is present', async () => {
    const finding = {
      severity: 'low',
      path: 'src/x.js',
      summary: 's',
      index: 3,
    };
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: (args) => {
        const marker = args[2];
        // Content marker not found; the legacy `-finding-<idx>` marker is.
        if (/-finding-\d+ -->/.test(marker)) {
          return { stdout: '[{"number":88}]', code: 0 };
        }
        return { stdout: '[]', code: 0 };
      },
      ghCreate: () => ({ stdout: 'https://x/issues/1', code: 0 }),
    });
    const env = await graduate({
      epicId: 4406,
      provider: { getTicketComments: async () => [] },
      currentRepo: { owner: 'o', repo: 'r' },
      classifier: () => 'consumer',
      spawnImpl,
      findings: [finding],
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0);
    assert.equal(env.skipped.length, 1);
    assert.equal(env.skipped[0].reason, 'already-filed');
    // Sanity: the legacy marker the walk probed carries the parse index.
    assert.equal(
      buildAuditLegacyMarker(4406, 3),
      '<!-- audit-results-followup: epic-4406-finding-3 -->',
    );
  });
});

describe('AC6 — probe-error distinction + durable cross-repo deferral', () => {
  it('records a probe spawn failure as probe-error, not file-removed', async () => {
    const spawnImpl = makeSpawnStub({ gitThrows: true });
    const env = await graduate({
      epicId: 4406,
      provider: { getTicketComments: async () => [] },
      currentRepo: { owner: 'o', repo: 'r' },
      classifier: () => 'consumer',
      spawnImpl,
      findings: [{ severity: 'low', path: 'src/x.js', summary: 's', index: 0 }],
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0);
    assert.equal(env.skipped.length, 1);
    assert.equal(env.skipped[0].reason, 'probe-error');
  });

  it('upserts cross-repo-deferred findings into a durable Epic comment', async () => {
    _resetStructuredCommentCache();
    const codeReviewBody = [
      '<!-- structured-comment: code-review -->',
      '### 🚨 Critical Findings',
      '🟠 High Risk: `.agents/scripts/foo.js` (framework path)',
    ].join('\n');
    const provider = makeRecordingProvider([{ body: codeReviewBody }]);
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghCreate: () => ({ stdout: 'https://x/issues/1', code: 0 }),
    });
    const env = await graduateFindings({
      epicId: 4406,
      provider,
      config: {},
      // Listener runs in the consumer repo → the .agents/ finding routes
      // cross-repo.
      currentRepo: { owner: 'acme', repo: 'product' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl,
    });
    const crossRepo = env.skipped.find(
      (s) => s.reason === 'cross-repo-deferred',
    );
    assert.ok(crossRepo, 'expected a cross-repo-deferred skip');
    assert.equal(crossRepo.path, '.agents/scripts/foo.js');
    // The deferral must be persisted as a durable structured comment.
    const persisted = provider.posted.find(
      (p) => p.type === 'cross-repo-deferred',
    );
    assert.ok(persisted, 'cross-repo-deferred comment must be upserted');
    assert.match(persisted.body, /Cross-repo-deferred findings/);
    assert.match(persisted.body, /\.agents\/scripts\/foo\.js/);
    assert.match(persisted.body, /dsj1984\/mandrel/);
    assert.equal(env.errors.length, 0, JSON.stringify(env.errors));
  });

  it('is a no-op (no error) when the provider cannot post comments', async () => {
    // Provider without postComment — the persist step must silently skip.
    const provider = {
      getTicketComments: async () => [
        {
          body: [
            '<!-- structured-comment: code-review -->',
            '🟠 High Risk: `.agents/scripts/foo.js`',
          ].join('\n'),
        },
      ],
    };
    const spawnImpl = makeSpawnStub({ git: () => ({ code: 0 }) });
    const env = await graduateFindings({
      epicId: 4406,
      provider,
      config: {},
      currentRepo: { owner: 'acme', repo: 'product' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl,
    });
    assert.equal(env.errors.length, 0, JSON.stringify(env.errors));
    assert.ok(env.skipped.some((s) => s.reason === 'cross-repo-deferred'));
  });
});

describe('ticketing — cross-repo-deferred is a registered comment type', () => {
  it('findStructuredComment resolves the type without throwing', async () => {
    _resetStructuredCommentCache();
    const provider = {
      getTicketComments: async () => [],
    };
    // A registered but absent type resolves to null (no throw); an
    // unregistered type would throw in assertValidStructuredCommentType.
    const found = await findStructuredComment(
      provider,
      4406,
      'cross-repo-deferred',
      { graduator: 'audit-results' },
    );
    assert.equal(found, null);
  });
});
