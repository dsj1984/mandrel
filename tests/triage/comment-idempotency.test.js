import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TRIAGE_MARKER } from '../../.agents/scripts/lib/triage/render-comment.js';
import {
  collectCrapRegressions,
  collectTestOutputs,
  findExistingTriageComment,
  patchExistingComment,
  postNewComment,
  runTriage,
} from '../../.agents/scripts/triage-ci-failure.js';

/**
 * comment-idempotency tests.
 *
 * Drives `runTriage()` with a fake gh shim and a real on-disk artifacts
 * tree (written into a per-test `mkdtempSync` directory and cleaned up
 * via t.after). Locks the two contracts from t2-tests:
 *
 *   1. POST-then-PATCH idempotency. Two consecutive runs against the
 *      same fixtures yield: first call → POST `gh pr comment`, second
 *      call → PATCH `gh api ... /issues/comments/<id>`. The shim
 *      records each invocation so we can assert no duplicate POSTs and
 *      that the PATCH body equals the POST body (proves the marker
 *      keys correctly).
 *
 *   2. Missing-artifact loudness. When ARTIFACTS_DIR exists but contains
 *      no test-results-* or crap-report-* subfolders, the script
 *      throws — the workflow surfaces config drift instead of silently
 *      green-walking past it.
 *
 * The fake gh shim is a tiny in-process record/replay implementation;
 * it never touches the network and never spawns a child process, so the
 * suite runs hermetically under `npm test` on Windows and Linux.
 */

/** Stand up an artifacts tree mimicking actions/download-artifact@v4 layout. */
function buildArtifactsDir({ withCrap = true, withTestOutput = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-test-'));
  if (withTestOutput) {
    const ubuntu = path.join(dir, 'test-results-ubuntu-latest-node-22');
    fs.mkdirSync(ubuntu, { recursive: true });
    fs.writeFileSync(
      path.join(ubuntu, 'test-output.txt'),
      ['ok 1', 'ok 2', 'not ok 3 - assertion failed', ''].join('\n'),
      'utf8',
    );
    const windows = path.join(dir, 'test-results-windows-latest-node-22');
    fs.mkdirSync(windows, { recursive: true });
    fs.writeFileSync(
      path.join(windows, 'test-output.txt'),
      ['ok 1', 'not ok 2 - windows path failure', ''].join('\r\n'),
      'utf8',
    );
  }
  if (withCrap) {
    const crap = path.join(dir, 'crap-report-ubuntu-latest-node-22');
    fs.mkdirSync(crap, { recursive: true });
    const envelope = {
      kernelVersion: '1.2.3',
      escomplexVersion: '7.3.2',
      summary: {
        total: 1,
        regressions: 1,
        newViolations: 0,
        drifted: 0,
        removed: 0,
        skippedNoCoverage: 0,
      },
      violations: [
        {
          file: 'lib/example.js',
          method: 'doWork',
          startLine: 42,
          cyclomatic: 8,
          coverage: 0.2,
          crap: 40.768,
          baseline: 18,
          ceiling: 30,
          kind: 'regression',
          fixGuidance: {
            crapCeiling: 30,
            minComplexityAt100Cov: 5,
            minCoverageAtCurrentComplexity: 0.5,
          },
        },
      ],
    };
    fs.writeFileSync(
      path.join(crap, 'crap-report.json'),
      JSON.stringify(envelope),
      'utf8',
    );
  }
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a fake gh shim. `commentsRef.value` is the array of stored
 * comments (the world state). Each `gh pr view --json comments` call
 * returns the current contents; `gh pr comment --body-file -` appends a
 * new comment with an auto-incremented id; `gh api -X PATCH .../comments/:id`
 * edits the matching comment in place. Anything else returns status 0
 * with empty stdout — the shim is purpose-built for the triage script's
 * three gh invocations.
 */
function buildFakeGh(commentsRef) {
  const calls = [];
  let nextId = 1000;
  return {
    calls,
    run(args, opts = {}) {
      calls.push({ args: [...args], input: opts.input });
      // gh pr view <n> --json comments
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({ comments: commentsRef.value }),
          stderr: '',
        };
      }
      // gh pr comment <n> --body-file -
      if (args[0] === 'pr' && args[1] === 'comment') {
        const id = String(nextId++);
        commentsRef.value.push({ id, body: opts.input ?? '' });
        return { status: 0, stdout: `posted ${id}\n`, stderr: '' };
      }
      // gh api -X PATCH /repos/.../issues/comments/:id -f body=...
      if (args[0] === 'api' && args.includes('PATCH')) {
        const route = args[args.indexOf('PATCH') + 1];
        const id = route.split('/').pop();
        const bodyArg = args[args.indexOf('-f') + 1] ?? '';
        const body = bodyArg.startsWith('body=')
          ? bodyArg.slice('body='.length)
          : bodyArg;
        const existing = commentsRef.value.find((c) => c.id === id);
        if (!existing) {
          return { status: 1, stdout: '', stderr: `no such comment ${id}` };
        }
        existing.body = body;
        return { status: 0, stdout: `patched ${id}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

test('collectTestOutputs — happy path: returns one payload per artifact folder', (t) => {
  const dir = buildArtifactsDir();
  t.after(() => cleanup(dir));
  const payloads = collectTestOutputs(dir);
  // Two test-results-* folders → two payloads.
  assert.strictEqual(payloads.length, 2);
  const oses = payloads.map((p) => p.os).sort();
  assert.deepStrictEqual(oses, ['ubuntu-latest', 'windows-latest']);
  // Each anchored on its own `not ok` line.
  assert.ok(payloads.every((p) => p.anchored));
});

test('collectTestOutputs — missing dir returns empty array', () => {
  assert.deepStrictEqual(
    collectTestOutputs(path.join(os.tmpdir(), 'definitely-not-here-xyz')),
    [],
  );
});

test('collectCrapRegressions — returns top-5 from first found crap-report.json', (t) => {
  const dir = buildArtifactsDir();
  t.after(() => cleanup(dir));
  const top = collectCrapRegressions(dir);
  assert.strictEqual(top.length, 1);
  assert.strictEqual(top[0].file, 'lib/example.js');
});

test('collectCrapRegressions — no crap folders returns empty array', (t) => {
  const dir = buildArtifactsDir({ withCrap: false });
  t.after(() => cleanup(dir));
  assert.deepStrictEqual(collectCrapRegressions(dir), []);
});

test('findExistingTriageComment — returns null when no marker comment present', () => {
  const commentsRef = { value: [{ id: '1', body: 'unrelated chatter' }] };
  const gh = buildFakeGh(commentsRef);
  const found = findExistingTriageComment(gh, 42, TRIAGE_MARKER);
  assert.strictEqual(found, null);
});

test('findExistingTriageComment — returns the marker-comment id', () => {
  const commentsRef = {
    value: [
      { id: '1', body: 'unrelated' },
      { id: '2', body: `${TRIAGE_MARKER}\nbody` },
    ],
  };
  const gh = buildFakeGh(commentsRef);
  assert.strictEqual(findExistingTriageComment(gh, 42, TRIAGE_MARKER), '2');
});

test('findExistingTriageComment — gh failure surfaces as Error', () => {
  const gh = {
    run: () => ({ status: 1, stdout: '', stderr: 'auth failed' }),
  };
  assert.throws(
    () => findExistingTriageComment(gh, 42, TRIAGE_MARKER),
    /gh pr view failed/,
  );
});

test('findExistingTriageComment — non-JSON stdout surfaces as Error', () => {
  const gh = {
    run: () => ({ status: 0, stdout: 'not json', stderr: '' }),
  };
  assert.throws(
    () => findExistingTriageComment(gh, 42, TRIAGE_MARKER),
    /non-JSON stdout/,
  );
});

test('postNewComment — happy path returns posted action', () => {
  const commentsRef = { value: [] };
  const gh = buildFakeGh(commentsRef);
  const result = postNewComment(gh, 42, 'hello');
  assert.strictEqual(result.action, 'posted');
  assert.strictEqual(commentsRef.value.length, 1);
});

test('postNewComment — gh failure surfaces as Error', () => {
  const gh = {
    run: () => ({ status: 2, stdout: '', stderr: 'rate limited' }),
  };
  assert.throws(() => postNewComment(gh, 42, 'x'), /gh pr comment failed/);
});

test('patchExistingComment — happy path edits in place', () => {
  const commentsRef = { value: [{ id: '9', body: 'old' }] };
  const gh = buildFakeGh(commentsRef);
  const result = patchExistingComment(gh, 'me', 'repo', '9', 'new');
  assert.strictEqual(result.action, 'patched');
  assert.strictEqual(result.commentId, '9');
  assert.strictEqual(commentsRef.value[0].body, 'new');
});

test('patchExistingComment — gh failure surfaces as Error', () => {
  const gh = {
    run: () => ({ status: 1, stdout: '', stderr: 'nope' }),
  };
  assert.throws(
    () => patchExistingComment(gh, 'me', 'repo', '1', 'x'),
    /gh api PATCH comment 1 failed/,
  );
});

test('runTriage — first call POSTs, second call PATCHes (idempotent)', (t) => {
  const dir = buildArtifactsDir();
  t.after(() => cleanup(dir));
  const commentsRef = { value: [] };
  const gh = buildFakeGh(commentsRef);
  const env = {
    PR_NUMBER: '42',
    RUN_ID: '99999',
    ARTIFACTS_DIR: dir,
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_SERVER_URL: 'https://github.com',
  };

  const first = runTriage({ env, gh });
  assert.strictEqual(first.action, 'posted');
  assert.strictEqual(commentsRef.value.length, 1);
  assert.ok(commentsRef.value[0].body.includes(TRIAGE_MARKER));

  // Second run against the same fixtures must find the marker and PATCH.
  const second = runTriage({ env, gh });
  assert.strictEqual(second.action, 'patched');
  // Still exactly one comment — no duplicate POST.
  assert.strictEqual(commentsRef.value.length, 1);
  // Body unchanged (same fixtures → same render).
  assert.strictEqual(commentsRef.value[0].body, first.body);
  // The recorded gh calls show 1 view + 1 comment POST + 1 view + 1 api PATCH.
  const actions = gh.calls.map((c) => `${c.args[0]} ${c.args[1] ?? ''}`.trim());
  assert.deepStrictEqual(actions, [
    'pr view',
    'pr comment',
    'pr view',
    'api -X',
  ]);
});

test('runTriage — missing artifacts dir throws (loud config drift)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-test-empty-'));
  t.after(() => cleanup(dir));
  // Dir exists but has no test-results-* or crap-report-* subfolders.
  const env = {
    PR_NUMBER: '42',
    RUN_ID: '99999',
    ARTIFACTS_DIR: dir,
    GITHUB_REPOSITORY: 'owner/repo',
  };
  const gh = buildFakeGh({ value: [] });
  assert.throws(() => runTriage({ env, gh }), /No triage artifacts found/);
});

test('runTriage — ARTIFACTS_DIR that does not exist throws', () => {
  const env = {
    PR_NUMBER: '42',
    RUN_ID: '99999',
    ARTIFACTS_DIR: path.join(os.tmpdir(), 'definitely-not-here-abc'),
    GITHUB_REPOSITORY: 'owner/repo',
  };
  const gh = buildFakeGh({ value: [] });
  assert.throws(() => runTriage({ env, gh }), /ARTIFACTS_DIR does not exist/);
});

test('runTriage — missing PR_NUMBER throws', () => {
  const gh = buildFakeGh({ value: [] });
  assert.throws(
    () => runTriage({ env: { RUN_ID: '1', ARTIFACTS_DIR: '/tmp' }, gh }),
    /PR_NUMBER is required/,
  );
});

test('runTriage — missing RUN_ID throws', () => {
  const gh = buildFakeGh({ value: [] });
  assert.throws(
    () => runTriage({ env: { PR_NUMBER: '1', ARTIFACTS_DIR: '/tmp' }, gh }),
    /RUN_ID is required/,
  );
});

test('runTriage — missing ARTIFACTS_DIR throws', () => {
  const gh = buildFakeGh({ value: [] });
  assert.throws(
    () => runTriage({ env: { PR_NUMBER: '1', RUN_ID: '1' }, gh }),
    /ARTIFACTS_DIR is required/,
  );
});

test('runTriage — body contains the stable marker on POST and PATCH', (t) => {
  const dir = buildArtifactsDir();
  t.after(() => cleanup(dir));
  const commentsRef = { value: [] };
  const gh = buildFakeGh(commentsRef);
  const env = {
    PR_NUMBER: '7',
    RUN_ID: '12345',
    ARTIFACTS_DIR: dir,
    GITHUB_REPOSITORY: 'owner/repo',
  };

  const first = runTriage({ env, gh });
  // POST body carries the marker.
  assert.ok(first.body.includes(TRIAGE_MARKER));
  // The body sent to gh as stdin must also carry the marker (proves the
  // workflow's `--body-file -` invocation receives the rendered comment).
  const postCall = gh.calls.find(
    (c) => c.args[0] === 'pr' && c.args[1] === 'comment',
  );
  assert.ok(postCall.input.includes(TRIAGE_MARKER));

  const second = runTriage({ env, gh });
  // PATCH body sent via `-f body=...` must also include the marker.
  const patchCall = gh.calls.find(
    (c) => c.args[0] === 'api' && c.args.includes('PATCH'),
  );
  const bodyArg = patchCall.args[patchCall.args.indexOf('-f') + 1];
  assert.ok(bodyArg.startsWith('body='));
  assert.ok(bodyArg.includes(TRIAGE_MARKER));
  assert.strictEqual(second.action, 'patched');
});
