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
    } else if (args[0] === 'issue' && args[1] === 'list') {
      result = routes.ghList
        ? routes.ghList(args)
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

/**
 * Story #4657 — the idempotency probe repair. The wrapped `<!-- … -->`
 * marker form never matched the search index; these pin the delimiter
 * normalization (via the exported `probeMarkerExists` seam), the strong-read
 * confirmation on the would-file path, and the preserved degrade-toward-
 * filing posture (via the exported `graduate` seam). The delimiter stripper
 * and the strong-read helper are internal to the module and exercised
 * through those two public seams rather than imported directly.
 */
describe('probeMarkerExists — query normalization (AC-1)', () => {
  it('never sends comment delimiters to the search index', async () => {
    const spawnImpl = makeSpawnStub({
      ghSearch: () => ({ stdout: '[]', code: 0 }),
    });
    await probeMarkerExists({
      marker: '<!-- retro-proposal-followup: epic-1-abc -->',
      owner: 'o',
      repo: 'r',
      ghPath: 'gh',
      spawnImpl,
    });
    const searchCall = spawnImpl.calls.find((c) => c.args[0] === 'search');
    assert.ok(searchCall, 'a gh search issues call was made');
    for (const arg of searchCall.args) {
      assert.ok(
        !arg.includes('<!--') && !arg.includes('-->'),
        `no search arg carries comment delimiters: ${arg}`,
      );
    }
    // And the query is the bare marker text the index actually matches.
    assert.ok(
      searchCall.args.includes('retro-proposal-followup: epic-1-abc'),
      'the undelimited marker text is the query',
    );
  });
});

describe('graduate — dedup dispatch (Story #4657)', () => {
  const currentRepo = { owner: 'o', repo: 'r' };

  // The content marker the minimal spec embeds, in wrapped form.
  const wrappedMarker = (epicId, index) => `<!-- f-${epicId}-${index} -->`;

  it('AC-2: identifies the marker via the undelimited search query', async () => {
    const provider = {
      getTicketComments: async () => [{ body: '<!-- test-marker --> FIND' }],
    };
    // Match ONLY on the undelimited marker text — a wrapped query never hits.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: (args) => ({
        stdout: args[2] === 'f-42-0' ? '[{"number":3}]' : '[]',
        code: 0,
      }),
    });
    const env = await graduate({
      epicId: 42,
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0, 'no filing when already present');
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    // The search query carried no delimiters.
    const searchCall = spawnImpl.calls.find((c) => c.args[0] === 'search');
    assert.equal(searchCall.args[2], 'f-42-0');
    // No create was attempted.
    assert.ok(!spawnImpl.calls.some((c) => c.args[1] === 'create'));
  });

  it('AC-3: legacy ordinal markers get the same normalization', async () => {
    const provider = {
      getTicketComments: async () => [{ body: '<!-- test-marker --> FIND' }],
    };
    // Content marker absent; the legacy marker is present — matched only in
    // its undelimited form.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: (args) => ({
        stdout: args[2] === 'legacy-f-1-0' ? '[{"number":4}]' : '[]',
        code: 0,
      }),
    });
    const env = await graduate({
      epicId: 1,
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0);
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    const legacySearch = spawnImpl.calls.find(
      (c) => c.args[0] === 'search' && c.args[2] === 'legacy-f-1-0',
    );
    assert.ok(legacySearch, 'the legacy marker was probed undelimited');
    assert.ok(
      !legacySearch.args.some((a) => a.includes('<!--') || a.includes('-->')),
      'the legacy query carried no delimiters',
    );
  });

  it('AC-4: a duplicate inside the search-index window is caught by the strong read', async () => {
    const provider = {
      getTicketComments: async () => [{ body: '<!-- test-marker --> FIND' }],
    };
    // Search index misses it (empty), but the strongly-consistent issue list
    // returns a body carrying the marker.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghList: () => ({
        stdout: JSON.stringify([
          { number: 7, body: `x ${wrappedMarker(42, 0)} y` },
        ]),
        code: 0,
      }),
    });
    const env = await graduate({
      epicId: 42,
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0, 'the window duplicate is not re-filed');
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    assert.ok(
      !spawnImpl.calls.some((c) => c.args[1] === 'create'),
      'createFollowUpIssue was never spawned',
    );
    // The strong read is a strongly-consistent (`--state all`), label-scoped
    // `gh issue list` — scoped by the labels the follow-up would carry.
    const listCall = spawnImpl.calls.find(
      (c) => c.args[0] === 'issue' && c.args[1] === 'list',
    );
    assert.ok(listCall, 'a gh issue list strong read ran');
    assert.ok(
      listCall.args.includes('--state') && listCall.args.includes('all'),
    );
    assert.ok(
      listCall.args.includes('--label') && listCall.args.includes('lbl'),
    );
  });

  it('AC-5: the strong read runs only on the would-file path', async () => {
    const provider = {
      getTicketComments: async () => [{ body: '<!-- test-marker --> FIND' }],
    };
    // Search already reports a match → no gh issue list spawn.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[{"number":1}]', code: 0 }),
    });
    const env = await graduate({
      epicId: 42,
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    assert.ok(
      !spawnImpl.calls.some(
        (c) => c.args[0] === 'issue' && c.args[1] === 'list',
      ),
      'no gh issue list spawn when the search probe already matched',
    );
  });

  it('AC-7: an undecidable probe still files rather than swallowing', async () => {
    const provider = {
      getTicketComments: async () => [{ body: '<!-- test-marker --> FIND' }],
    };
    // Both read probes error; only the create succeeds.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => {
        throw new Error('search down');
      },
      ghList: () => {
        throw new Error('list down');
      },
      ghCreate: () => ({ stdout: 'https://x/issues/11', code: 0 }),
    });
    const env = await graduate({
      epicId: 42,
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 1, 'degrade-toward-filing preserved');
    assert.equal(env.filed[0].url, 'https://x/issues/11');
  });
});
