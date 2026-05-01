import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDefaultGitAdapter,
  COMMIT_ASSERTION_ZERO_DELTA_DETAIL,
  CommitAssertion,
} from '../../.agents/scripts/lib/orchestration/epic-runner/commit-assertion.js';

function stubAdapter(map) {
  return async ({ epicId, storyId }) => {
    if (!(storyId in map)) {
      throw new Error(`no stub for story-${storyId} vs epic/${epicId}`);
    }
    const value = map[storyId];
    if (value instanceof Error) throw value;
    return value;
  };
}

describe('CommitAssertion', () => {
  it('requires an injected gitAdapter function', () => {
    assert.throws(() => new CommitAssertion({}), /gitAdapter function/);
  });

  it('returns zero-, one-, and many-commit rows as-is from the adapter', async () => {
    const assertion = new CommitAssertion({
      gitAdapter: stubAdapter({ 400: 0, 401: 1, 402: 17 }),
    });
    const rows = await assertion.check([400, 401, 402], { epicId: 321 });
    assert.deepEqual(rows, [
      { storyId: 400, newCommitCount: 0 },
      { storyId: 401, newCommitCount: 1 },
      { storyId: 402, newCommitCount: 17 },
    ]);
  });

  it('records adapter errors as null count + error detail, and keeps going', async () => {
    const assertion = new CommitAssertion({
      gitAdapter: stubAdapter({
        400: 2,
        401: new Error('unknown revision'),
        402: 5,
      }),
      logger: { warn: () => {} },
    });
    const rows = await assertion.check([400, 401, 402], { epicId: 321 });
    assert.equal(rows[0].newCommitCount, 2);
    assert.equal(rows[1].newCommitCount, null);
    assert.match(rows[1].error, /unknown revision/);
    assert.equal(rows[2].newCommitCount, 5);
  });

  it('requires a numeric epicId', async () => {
    const assertion = new CommitAssertion({ gitAdapter: async () => 0 });
    await assert.rejects(() => assertion.check([400], {}), /numeric epicId/);
  });

  it('coerces non-integer adapter output to a safe integer', async () => {
    const assertion = new CommitAssertion({
      gitAdapter: stubAdapter({ 400: '3', 401: -1, 402: Number.NaN }),
    });
    const rows = await assertion.check([400, 401, 402], { epicId: 321 });
    assert.equal(rows[0].newCommitCount, 3);
    // Negative and NaN both collapse to 0 rather than propagating.
    assert.equal(rows[1].newCommitCount, 0);
    assert.equal(rows[2].newCommitCount, 0);
  });

  it('exports the zero-delta detail constant for the wave-observer wiring', () => {
    assert.equal(
      COMMIT_ASSERTION_ZERO_DELTA_DETAIL,
      'commit-assertion: zero-delta',
    );
  });

  it('fans out git reads with at most 4 adapter calls in flight at once', async () => {
    // Track concurrent adapter invocations. Each call holds until release() is
    // invoked so we can assert the high-water mark before anything resolves.
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = [];
    const adapter = async ({ storyId }) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((resolve) => {
        gates.push(resolve);
      });
      inFlight--;
      return storyId % 7; // some non-trivial count per story
    };

    const assertion = new CommitAssertion({ gitAdapter: adapter });
    const ids = [401, 402, 403, 404, 405, 406, 407, 408, 409, 410];
    const pending = assertion.check(ids, { epicId: 321 });

    // Yield once so workers spin up and saturate against the gate.
    while (gates.length < 4) {
      await new Promise((r) => setImmediate(r));
    }
    // Only 4 adapter calls should be parked simultaneously, never 5+.
    assert.equal(gates.length, 4);
    assert.equal(maxInFlight, 4);

    // Drain in batches and verify the cap holds throughout the run.
    while (gates.length > 0) {
      const batch = gates.splice(0, gates.length);
      for (const release of batch) release();
      // Let the next wave schedule before asserting again.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }

    const rows = await pending;
    assert.equal(rows.length, ids.length);
    assert.ok(maxInFlight <= 4, `maxInFlight=${maxInFlight} exceeded cap of 4`);
    // Output order must still match input order regardless of resolve order.
    assert.deepEqual(
      rows.map((r) => r.storyId),
      ids,
    );
  });

  it('records transient Windows lock errors (EBUSY/EPERM) as per-row errors without aborting the batch', async () => {
    // Simulates the Windows git-worktree lock-contention fixture: a few story
    // reads throw EBUSY/EPERM the way `git` surfaces them under AV/indexer
    // pressure, while siblings succeed. The batch must survive and each
    // failing row must capture the adapter's error message so operators can
    // triage from the wave-end comment.
    const ebusy = Object.assign(
      new Error("EBUSY: resource busy or locked, open '.git/index.lock'"),
      { code: 'EBUSY' },
    );
    const eperm = Object.assign(
      new Error(
        "EPERM: operation not permitted, unlink '.git/objects/pack/.tmp'",
      ),
      { code: 'EPERM' },
    );
    const warnings = [];
    const assertion = new CommitAssertion({
      gitAdapter: stubAdapter({
        500: 2,
        501: ebusy,
        502: 4,
        503: eperm,
        504: 1,
      }),
      logger: { warn: (msg) => warnings.push(msg) },
    });
    const rows = await assertion.check([500, 501, 502, 503, 504], {
      epicId: 321,
    });
    assert.deepEqual(
      rows.map((r) => ({ id: r.storyId, count: r.newCommitCount })),
      [
        { id: 500, count: 2 },
        { id: 501, count: null },
        { id: 502, count: 4 },
        { id: 503, count: null },
        { id: 504, count: 1 },
      ],
    );
    assert.match(rows[1].error, /EBUSY/);
    assert.match(rows[3].error, /EPERM/);
    // Each failure must have been logged so operators see it in the runner log.
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => /#501/.test(w) && /EBUSY/.test(w)));
    assert.ok(warnings.some((w) => /#503/.test(w) && /EPERM/.test(w)));
  });
});

describe('buildDefaultGitAdapter', () => {
  it('invokes git rev-list --count with origin/epic and origin/story refspecs', async () => {
    const calls = [];
    const fakeExecFile = (cmd, args, opts, cb) => {
      calls.push({ cmd, args, opts });
      cb(null, { stdout: '4\n', stderr: '' });
    };
    const adapter = buildDefaultGitAdapter({
      cwd: '/tmp/repo',
      execFileImpl: fakeExecFile,
    });
    const count = await adapter({ epicId: 413, storyId: 420 });
    assert.equal(count, 4);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.deepEqual(calls[0].args, [
      'rev-list',
      '--count',
      'origin/epic/413..origin/story-420',
    ]);
    assert.equal(calls[0].opts.cwd, '/tmp/repo');
  });

  it('propagates git errors (missing refs) so CommitAssertion can record them', async () => {
    const fakeExecFile = (_cmd, _args, _opts, cb) => {
      const err = new Error("fatal: bad revision 'origin/epic/999'");
      cb(err, { stdout: '', stderr: err.message });
    };
    const adapter = buildDefaultGitAdapter({ execFileImpl: fakeExecFile });
    await assert.rejects(
      () => adapter({ epicId: 999, storyId: 420 }),
      /bad revision/,
    );
  });

  it('rejects non-numeric stdout instead of silently returning zero', async () => {
    const fakeExecFile = (_cmd, args, _opts, cb) => {
      if (args[0] === 'rev-list') {
        cb(null, { stdout: 'not-a-number\n', stderr: '' });
        return;
      }
      // Fallback git log returns no matching commits, so the original
      // "unexpected rev-list" error must surface.
      cb(null, { stdout: '', stderr: '' });
    };
    const adapter = buildDefaultGitAdapter({ execFileImpl: fakeExecFile });
    await assert.rejects(
      () => adapter({ epicId: 413, storyId: 420 }),
      /unexpected rev-list/,
    );
  });

  it('falls back to epic-branch "resolves #<id>" grep when story branch is deleted', async () => {
    // story-close deletes both the local and remote story branch after
    // a successful merge. By the time the wave-observer runs this assertion,
    // origin/story-<id> is gone — the fallback should find the landing commit
    // on origin/epic/<id> via its "(resolves #<id>)" message.
    const fakeExecFile = (_cmd, args, _opts, cb) => {
      if (args[0] === 'rev-list') {
        const err = new Error(
          "fatal: ambiguous argument 'origin/epic/441..origin/story-448': unknown revision",
        );
        cb(err, { stdout: '', stderr: err.message });
        return;
      }
      // Fallback path: git log origin/epic/441 -E --grep=...
      assert.equal(args[0], 'log');
      assert.equal(args[1], 'origin/epic/441');
      assert.equal(args[2], '-E');
      assert.match(args[3], /resolves #448/);
      cb(null, {
        stdout: '3c7afd1beaf198d847be8ca34e03bed4cfccee8c\n',
        stderr: '',
      });
    };
    const adapter = buildDefaultGitAdapter({ execFileImpl: fakeExecFile });
    const count = await adapter({ epicId: 441, storyId: 448 });
    assert.equal(count, 1);
  });

  it('rethrows the rev-list error when the fallback also finds nothing', async () => {
    const fakeExecFile = (_cmd, args, _opts, cb) => {
      if (args[0] === 'rev-list') {
        const err = new Error("fatal: unknown revision 'origin/story-999'");
        cb(err, { stdout: '', stderr: err.message });
        return;
      }
      cb(null, { stdout: '', stderr: '' });
    };
    const adapter = buildDefaultGitAdapter({ execFileImpl: fakeExecFile });
    await assert.rejects(
      () => adapter({ epicId: 441, storyId: 999 }),
      /unknown revision/,
    );
  });
});
