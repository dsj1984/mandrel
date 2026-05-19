/**
 * tests/lib/feedback-loop/code-review-graduator.test.js — Story #2555
 *
 * Unit tests for `graduateFindings`. The gh CLI and git probe are stubbed
 * via the `spawnImpl` seam; the ticketing provider is a hand-rolled stub.
 * No real network, no real git, no real filesystem access.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  buildIdempotencyMarker,
  graduateFindings,
  isAutoFileEnabled,
  parseFindings,
} from '../../../.agents/scripts/lib/feedback-loop/code-review-graduator.js';

/**
 * Build a spawn stub that routes by command + args[0] to a responder.
 * The responder returns `{ stdout, stderr, code }`; throw to simulate
 * a synchronous spawn failure.
 */
function makeSpawnStub(routes) {
  const calls = [];
  const fn = function spawnImpl(cmd, args) {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let result;
    if (cmd === 'git') {
      result = routes.git
        ? routes.git(args)
        : { stdout: '', stderr: '', code: 0 };
    } else if (args[0] === 'search') {
      result = routes.ghSearch
        ? routes.ghSearch(args)
        : { stdout: '[]', stderr: '', code: 0 };
    } else if (args[0] === 'issue' && args[1] === 'create') {
      result = routes.ghCreate
        ? routes.ghCreate(args)
        : {
            stdout: 'https://github.com/o/r/issues/999',
            stderr: '',
            code: 0,
          };
    } else {
      result = { stdout: '', stderr: '', code: 0 };
    }
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** Build a provider stub returning the given code-review comment body. */
function makeProvider(body) {
  return {
    getTicketComments: async () => [
      {
        body: `<!-- structured-comment: code-review -->\n${body}`,
      },
    ],
  };
}

const CODE_REVIEW_BODY = [
  '## 🔬 Automated Code Review Results for Epic #2547',
  '',
  '### 📦 Severity Tier Counts',
  '- 🔴 Critical Blocker: 0',
  '- 🟠 High Risk: 1',
  '- 🟡 Medium Risk: 1',
  '- 🟢 Suggestion: 1',
  '',
  '### 🚨 Critical Findings',
  '🟠 High Risk: `.agents/scripts/foo.js` (complex method, score 42)',
  '🟡 Size/Volume Warning: `src/consumer-app/Bar.tsx` (module 18.5, worst 71.2)',
  '',
  '### 🟡 Warnings',
  '🟢 Suggestion: `src/consumer-app/Baz.ts` (minor improvement)',
].join('\n');

describe('isAutoFileEnabled', () => {
  it('defaults to true when config is undefined', () => {
    assert.equal(isAutoFileEnabled(undefined), true);
  });
  it('defaults to true when feedbackLoop is missing', () => {
    assert.equal(isAutoFileEnabled({ delivery: {} }), true);
  });
  it('returns false when explicitly disabled', () => {
    assert.equal(
      isAutoFileEnabled({
        delivery: { feedbackLoop: { codeReviewAutoFile: false } },
      }),
      false,
    );
  });
  it('returns true when explicitly enabled', () => {
    assert.equal(
      isAutoFileEnabled({
        delivery: { feedbackLoop: { codeReviewAutoFile: true } },
      }),
      true,
    );
  });
});

describe('buildIdempotencyMarker', () => {
  it('produces a stable HTML comment marker per epicId+index', () => {
    assert.equal(
      buildIdempotencyMarker(42, 3),
      '<!-- code-review-followup: epic-42-finding-3 -->',
    );
  });
});

describe('parseFindings', () => {
  it('extracts non-blocking severity bullets with their cited paths', () => {
    const findings = parseFindings(CODE_REVIEW_BODY);
    assert.equal(findings.length, 3);
    assert.deepEqual(
      findings.map((f) => ({ severity: f.severity, path: f.path })),
      [
        { severity: 'high', path: '.agents/scripts/foo.js' },
        { severity: 'medium', path: 'src/consumer-app/Bar.tsx' },
        { severity: 'low', path: 'src/consumer-app/Baz.ts' },
      ],
    );
  });

  it('ignores blocking 🔴 lines', () => {
    const body = [
      '🔴 Critical: `dangerous/blocker.js` (blocking)',
      '🟡 Size/Volume Warning: `safe.js` (fine)',
    ].join('\n');
    const findings = parseFindings(body);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, 'safe.js');
  });

  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(parseFindings(''), []);
    assert.deepEqual(parseFindings(null), []);
    assert.deepEqual(parseFindings(undefined), []);
  });
});

describe('graduateFindings — toggle off', () => {
  it('short-circuits with toggle-disabled and never calls the provider', async () => {
    let providerCalls = 0;
    const provider = {
      getTicketComments: async () => {
        providerCalls += 1;
        return [];
      },
    };
    const result = await graduateFindings({
      epicId: 2547,
      provider,
      config: { delivery: { feedbackLoop: { codeReviewAutoFile: false } } },
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
    });
    assert.equal(providerCalls, 0);
    assert.deepEqual(result.filed, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'toggle-disabled');
    assert.deepEqual(result.errors, []);
  });
});

describe('graduateFindings — route by source', () => {
  it('routes framework findings to framework repo, consumer to current repo', async () => {
    const provider = makeProvider(CODE_REVIEW_BODY);
    // All three paths exist; idempotency probe returns empty; create succeeds.
    const spawn = makeSpawnStub({
      git: () => ({ stdout: '', stderr: '', code: 0 }),
      ghSearch: () => ({ stdout: '[]', stderr: '', code: 0 }),
      ghCreate: () => ({
        stdout: 'https://github.com/o/r/issues/1234\n',
        stderr: '',
        code: 0,
      }),
    });
    const result = await graduateFindings({
      epicId: 2547,
      provider,
      config: {},
      // Pretend the listener is running in the consumer repo so the
      // framework-tagged finding takes the cross-repo branch.
      currentRepo: { owner: 'acme', repo: 'product' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl: spawn,
    });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    // The .agents/ path → framework → cross-repo-deferred.
    const crossRepo = result.skipped.find(
      (s) => s.reason === 'cross-repo-deferred',
    );
    assert.ok(crossRepo, 'expected a cross-repo-deferred skip');
    assert.equal(crossRepo.path, '.agents/scripts/foo.js');
    // Consumer paths get filed against the current repo.
    assert.equal(result.filed.length, 2);
    for (const filed of result.filed) {
      assert.equal(filed.repo, 'acme/product');
      assert.equal(filed.source, 'consumer');
    }
  });

  it('files framework findings against current repo when listener runs in framework repo', async () => {
    const provider = makeProvider(CODE_REVIEW_BODY);
    const spawn = makeSpawnStub({
      git: () => ({ stdout: '', stderr: '', code: 0 }),
      ghSearch: () => ({ stdout: '[]', stderr: '', code: 0 }),
      ghCreate: () => ({
        stdout: 'https://github.com/dsj1984/mandrel/issues/4242\n',
        stderr: '',
        code: 0,
      }),
    });
    const result = await graduateFindings({
      epicId: 2547,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl: spawn,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.filed.length, 3);
    // The first .agents/ finding is classified framework.
    const framework = result.filed.find((f) => f.source === 'framework');
    assert.ok(framework);
    assert.equal(framework.path, '.agents/scripts/foo.js');
  });
});

describe('graduateFindings — deleted file skip', () => {
  it('skips findings whose path no longer exists in the merged tree', async () => {
    const provider = makeProvider(CODE_REVIEW_BODY);
    // git cat-file returns non-zero for the first finding only.
    const spawn = makeSpawnStub({
      git: (args) => {
        const target = args[args.length - 1]; // `HEAD:<path>`
        if (target.endsWith(':.agents/scripts/foo.js')) {
          return { stdout: '', stderr: 'missing', code: 1 };
        }
        return { stdout: '', stderr: '', code: 0 };
      },
      ghSearch: () => ({ stdout: '[]', stderr: '', code: 0 }),
      ghCreate: () => ({
        stdout: 'https://github.com/o/r/issues/77\n',
        stderr: '',
        code: 0,
      }),
    });
    const result = await graduateFindings({
      epicId: 2547,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl: spawn,
    });
    const removed = result.skipped.find((s) => s.reason === 'file-removed');
    assert.ok(removed);
    assert.equal(removed.path, '.agents/scripts/foo.js');
    // The other two are filed.
    assert.equal(result.filed.length, 2);
  });
});

describe('graduateFindings — idempotency marker re-run', () => {
  it('skips findings whose idempotency marker already exists', async () => {
    const provider = makeProvider(CODE_REVIEW_BODY);
    const spawn = makeSpawnStub({
      git: () => ({ stdout: '', stderr: '', code: 0 }),
      // Pretend marker for finding-1 is already present.
      ghSearch: (args) => {
        const query = args[2];
        if (query.includes('finding-1')) {
          return {
            stdout: JSON.stringify([{ number: 9999 }]),
            stderr: '',
            code: 0,
          };
        }
        return { stdout: '[]', stderr: '', code: 0 };
      },
      ghCreate: () => ({
        stdout: 'https://github.com/o/r/issues/123\n',
        stderr: '',
        code: 0,
      }),
    });
    const result = await graduateFindings({
      epicId: 2547,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
      frameworkRepo: { owner: 'dsj1984', repo: 'mandrel' },
      spawnImpl: spawn,
    });
    const already = result.skipped.find((s) => s.reason === 'already-filed');
    assert.ok(already, 'expected an already-filed skip');
    assert.equal(already.index, 1);
    // The remaining two findings get filed.
    assert.equal(result.filed.length, 2);
    assert.ok(result.filed.every((f) => f.index !== 1));
  });
});

describe('graduateFindings — never throws', () => {
  it('captures provider failures into errors[] rather than throwing', async () => {
    const provider = {
      getTicketComments: async () => {
        throw new Error('boom');
      },
    };
    const result = await graduateFindings({
      epicId: 2547,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
    });
    assert.equal(result.filed.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /boom/);
  });

  it('records no-code-review-comment when none is present on the Epic', async () => {
    const provider = {
      getTicketComments: async () => [{ body: 'unrelated comment' }],
    };
    const result = await graduateFindings({
      epicId: 2547,
      provider,
      config: {},
      currentRepo: { owner: 'dsj1984', repo: 'mandrel' },
    });
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'no-code-review-comment');
  });
});
