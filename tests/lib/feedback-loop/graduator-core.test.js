/**
 * tests/lib/feedback-loop/graduator-core.test.js — Story #3845
 *
 * Unit tests for the shared graduator core extracted in Story #3845. The
 * audit-results and code-review graduators are now thin shells over this
 * module; these tests pin the shared mechanism directly (the spawn
 * helper's error envelope, the path/idempotency probes, the filer, the
 * toggle factory, and the parametrized `graduate()` walk with an injected
 * parser + body builder).
 *
 * The gh/git child processes are stubbed via the `spawnImpl` seam; no real
 * network, git, or filesystem access occurs.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  createFollowUpIssue,
  graduate,
  makeIsAutoFileEnabled,
  probeMarkerExists,
  probePathStatus,
  runChild,
} from '../../../.agents/scripts/lib/feedback-loop/graduator-core.js';

/**
 * Route a spawn by command + first arg to a responder returning
 * `{ stdout, stderr, code }`. Throw inside a responder to simulate a
 * synchronous spawn failure.
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
        : { stdout: 'https://github.com/o/r/issues/1', stderr: '', code: 0 };
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

describe('runChild', () => {
  it('captures a synchronous spawn throw as spawnError without throwing', async () => {
    const spawnImpl = () => {
      throw new Error('boom');
    };
    const res = await runChild({ cmd: 'gh', args: [], spawnImpl });
    assert.equal(res.code, null);
    assert.equal(res.spawnError.message, 'boom');
  });

  it('accumulates stdout/stderr and resolves the exit code', async () => {
    const spawnImpl = makeSpawnStub({
      git: () => ({ stdout: 'out', stderr: 'err', code: 7 }),
    });
    const res = await runChild({ cmd: 'git', args: ['x'], spawnImpl });
    assert.equal(res.stdout, 'out');
    assert.equal(res.stderr, 'err');
    assert.equal(res.code, 7);
    assert.equal(res.spawnError, null);
  });
});

describe('makeIsAutoFileEnabled', () => {
  it('binds to the supplied toggle key and defaults to true', () => {
    const reader = makeIsAutoFileEnabled('myToggle');
    assert.equal(reader(undefined), true);
    assert.equal(reader({ delivery: { feedbackLoop: {} } }), true);
    assert.equal(
      reader({ delivery: { feedbackLoop: { myToggle: false } } }),
      false,
    );
    // A different key must not disable it.
    assert.equal(
      reader({ delivery: { feedbackLoop: { otherToggle: false } } }),
      true,
    );
  });
});

describe('probePathStatus', () => {
  it('reports { exists, probeError } from the git cat-file exit code', async () => {
    const present = makeSpawnStub({ git: () => ({ code: 0 }) });
    const absent = makeSpawnStub({ git: () => ({ code: 1 }) });
    assert.deepEqual(
      await probePathStatus({ ref: 'HEAD', path: 'a', spawnImpl: present }),
      { exists: true, probeError: false },
    );
    assert.deepEqual(
      await probePathStatus({ ref: 'HEAD', path: 'a', spawnImpl: absent }),
      { exists: false, probeError: false },
    );
  });

  it('reports a spawn failure as a probe error, not a confirmed-missing file', async () => {
    const spawnImpl = () => {
      throw new Error('git missing');
    };
    assert.deepEqual(
      await probePathStatus({ ref: 'HEAD', path: 'a', spawnImpl }),
      { exists: false, probeError: true },
    );
  });
});

describe('probeMarkerExists', () => {
  it('returns true when gh search returns a non-empty array', async () => {
    const spawnImpl = makeSpawnStub({
      ghSearch: () => ({ stdout: '[{"number":5}]', code: 0 }),
    });
    assert.equal(
      await probeMarkerExists({
        marker: 'm',
        owner: 'o',
        repo: 'r',
        ghPath: 'gh',
        spawnImpl,
      }),
      true,
    );
  });

  it('degrades to false on non-zero exit', async () => {
    const spawnImpl = makeSpawnStub({ ghSearch: () => ({ code: 1 }) });
    assert.equal(
      await probeMarkerExists({
        marker: 'm',
        owner: 'o',
        repo: 'r',
        ghPath: 'gh',
        spawnImpl,
      }),
      false,
    );
  });
});

describe('createFollowUpIssue', () => {
  it('returns the trimmed URL on success', async () => {
    const spawnImpl = makeSpawnStub({
      ghCreate: () => ({ stdout: 'https://x/issues/9\n', code: 0 }),
    });
    const res = await createFollowUpIssue({
      owner: 'o',
      repo: 'r',
      title: 't',
      body: 'b',
      labels: ['l1'],
      ghPath: 'gh',
      spawnImpl,
    });
    assert.equal(res.url, 'https://x/issues/9');
    assert.equal(res.error, null);
  });

  it('captures a non-zero exit as a structured error', async () => {
    const spawnImpl = makeSpawnStub({
      ghCreate: () => ({ stdout: '', stderr: 'nope', code: 1 }),
    });
    const res = await createFollowUpIssue({
      owner: 'o',
      repo: 'r',
      title: 't',
      body: 'b',
      labels: [],
      ghPath: 'gh',
      spawnImpl,
    });
    assert.equal(res.url, null);
    assert.match(res.error, /gh issue create exited 1: nope/);
  });
});

/** Minimal spec for the parametrized graduate() walk. */
function makeSpec(overrides = {}) {
  return {
    fnName: 'testGraduate',
    isAutoFileEnabled: () => true,
    commentMarker: '<!-- test-marker -->',
    noCommentReason: 'no-test-comment',
    parseFindings: (body) =>
      body.includes('FIND')
        ? [{ severity: 'low', path: 'src/x.js', summary: 'FIND', index: 0 }]
        : [],
    buildContentMarker: (epicId, finding) =>
      `<!-- f-${epicId}-${finding.index} -->`,
    buildLegacyMarker: (epicId, index) =>
      `<!-- legacy-f-${epicId}-${index} -->`,
    buildCrossRepoLog: ({ routedRepo }) => `xrepo ${routedRepo.repo}`,
    buildFollowUp: ({ finding, source, epicId, idMarker }) => ({
      title: `t ${finding.path}`,
      body: `${idMarker} ${source} ${epicId}`,
      labels: ['lbl'],
    }),
    ...overrides,
  };
}

describe('graduate (parametrized walk)', () => {
  const currentRepo = { owner: 'o', repo: 'r' };

  it('short-circuits when the toggle is disabled', async () => {
    let called = false;
    const provider = {
      getTicketComments: async () => {
        called = true;
        return [];
      },
    };
    const env = await graduate({
      epicId: 1,
      provider,
      currentRepo,
      spec: makeSpec({ isAutoFileEnabled: () => false }),
    });
    assert.deepEqual(env, {
      filed: [],
      skipped: [{ reason: 'toggle-disabled' }],
      errors: [],
    });
    assert.equal(called, false, 'provider must not be read when toggled off');
  });

  it('records the spec-specific no-comment reason when the marker is absent', async () => {
    const provider = { getTicketComments: async () => [{ body: 'unrelated' }] };
    const env = await graduate({
      epicId: 1,
      provider,
      currentRepo,
      spec: makeSpec(),
    });
    assert.deepEqual(env.skipped, [{ reason: 'no-test-comment' }]);
  });

  it('files a follow-up issue using the injected parser + builder', async () => {
    const provider = {
      getTicketComments: async () => [{ body: '<!-- test-marker --> FIND' }],
    };
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghCreate: () => ({ stdout: 'https://x/issues/1', code: 0 }),
    });
    const env = await graduate({
      epicId: 42,
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 1);
    assert.equal(env.filed[0].path, 'src/x.js');
    assert.equal(env.filed[0].url, 'https://x/issues/1');
    // The injected builder body must have been threaded through.
    const createCall = spawnImpl.calls.find((c) => c.args[1] === 'create');
    const bodyIdx = createCall.args.indexOf('--body') + 1;
    assert.match(createCall.args[bodyIdx], /<!-- f-42-0 --> consumer 42/);
  });

  it('decorateRecord copies finding-specific fields onto records', async () => {
    const provider = {
      getTicketComments: async () => [{ body: '<!-- test-marker --> FIND' }],
    };
    const spawnImpl = makeSpawnStub({ git: () => ({ code: 1 }) }); // file-removed
    const env = await graduate({
      epicId: 1,
      provider,
      currentRepo,
      spawnImpl,
      spec: makeSpec({
        parseFindings: () => [
          {
            severity: 'low',
            path: 'src/x.js',
            summary: 's',
            index: 0,
            lens: 'audit-security',
          },
        ],
        decorateRecord: (record, finding) => {
          record.lens = finding.lens;
          return record;
        },
      }),
    });
    assert.equal(env.skipped[0].reason, 'file-removed');
    assert.equal(env.skipped[0].lens, 'audit-security');
  });

  it('never throws — provider failures land in errors[]', async () => {
    const provider = {
      getTicketComments: async () => {
        throw new Error('provider down');
      },
    };
    const env = await graduate({
      epicId: 1,
      provider,
      currentRepo,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0);
    assert.match(env.errors[0], /provider down/);
  });
});
