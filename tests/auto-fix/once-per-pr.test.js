import assert from 'node:assert';
import { test } from 'node:test';
import {
  ATTEMPT_LABEL as BAIL_ATTEMPT_LABEL,
  BAIL_MARKER,
  findExistingBailComment,
  patchExistingBailComment,
  postNewBailComment,
  renderBailBody,
  runBail,
  setAttemptedLabel,
} from '../../.agents/scripts/auto-fix-bail.js';
import {
  ATTEMPT_LABEL,
  assertNoTestFilesStaged,
  buildAuthenticatedRemoteUrl,
  COMMIT_SUBJECT,
  runFixStep,
} from '../../.agents/scripts/auto-fix-step.js';

/**
 * once-per-pr tests for the s4-auto-fix workflow.
 *
 * Covers the once-per-PR hard cap and the marker-keyed idempotency
 * contract from Task #1257's acceptance criteria:
 *
 *   1. Bail: first invocation POSTs a marker-keyed comment; second
 *      invocation finds the marker and PATCHes in place. The
 *      `auto-fix-attempted` label is set on both runs (label set is
 *      idempotent server-side, but the script always issues the POST).
 *   2. Fix step: when `auto-fix-attempted` is already present on the PR,
 *      the script short-circuits without running biome / git. When the
 *      label is absent, the script proceeds through npm ci → biome →
 *      commit → push → label. (Test exercises the label fast-path; the
 *      full run is unit-tested at the building-block level.)
 *   3. Fix step refuses to commit if any path under tests/ is staged,
 *      preventing the workflow from ever modifying test files even if
 *      the `:^tests/**` pathspec is removed by a future change.
 *
 * The fake `gh` / `exec` shims record each call so we can assert on the
 * sequence rather than just the final state. No network, no subprocess,
 * no filesystem — these tests run hermetically under `npm test` on
 * Windows and Linux.
 */

/** Constants exported by the two scripts must agree on the label name. */
test('ATTEMPT_LABEL — fix step and bail step share the same sentinel', () => {
  assert.strictEqual(ATTEMPT_LABEL, BAIL_ATTEMPT_LABEL);
  assert.strictEqual(ATTEMPT_LABEL, 'auto-fix-attempted');
});

test('COMMIT_SUBJECT — auto-fix subject begins with [auto-fix]', () => {
  assert.ok(COMMIT_SUBJECT.startsWith('[auto-fix]'));
});

/* ------------------------------ bail script ------------------------------ */

/** Build a fake gh shim shared by all bail-script tests. */
function buildFakeGh(commentsRef, labelsRef) {
  const calls = [];
  let nextId = 2000;
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
      // gh api -X POST /repos/.../issues/:n/labels -f labels[]=auto-fix-attempted
      if (
        args[0] === 'api' &&
        args.includes('POST') &&
        args.some((a) => /labels$/.test(a))
      ) {
        const arr = labelsRef?.value ?? [];
        if (!arr.includes(ATTEMPT_LABEL)) arr.push(ATTEMPT_LABEL);
        if (labelsRef) labelsRef.value = arr;
        return { status: 0, stdout: 'labeled\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

test('renderBailBody — body carries the marker and names the failure class explicitly', () => {
  for (const cls of [
    'coverage',
    'crap',
    'maintainability',
    'test',
    'unknown',
  ]) {
    const body = renderBailBody({ failureClass: cls });
    assert.ok(body.includes(BAIL_MARKER), `marker missing for ${cls}`);
    assert.ok(body.includes(`\`${cls}\``), `class name missing for ${cls}`);
  }
});

test('renderBailBody — run link is included when runUrl is provided', () => {
  const body = renderBailBody({
    failureClass: 'coverage',
    runUrl: 'https://github.com/owner/repo/actions/runs/123',
  });
  assert.ok(body.includes('actions/runs/123'));
});

test('renderBailBody — defaults to unknown headline on unrecognised class', () => {
  const body = renderBailBody({ failureClass: 'no-such-class' });
  assert.ok(body.includes('could not be determined'));
});

test('findExistingBailComment — returns null when no marker present', () => {
  const commentsRef = { value: [{ id: '1', body: 'unrelated' }] };
  const gh = buildFakeGh(commentsRef);
  assert.strictEqual(findExistingBailComment(gh, 42), null);
});

test('findExistingBailComment — returns marker comment id when present', () => {
  const commentsRef = {
    value: [
      { id: '1', body: 'unrelated' },
      { id: '2', body: `${BAIL_MARKER}\n...` },
    ],
  };
  const gh = buildFakeGh(commentsRef);
  assert.strictEqual(findExistingBailComment(gh, 42), '2');
});

test('findExistingBailComment — gh failure surfaces as Error', () => {
  const gh = {
    run: () => ({ status: 1, stdout: '', stderr: 'auth failed' }),
  };
  assert.throws(() => findExistingBailComment(gh, 42), /gh pr view failed/);
});

test('findExistingBailComment — non-JSON stdout surfaces as Error', () => {
  const gh = { run: () => ({ status: 0, stdout: 'not json', stderr: '' }) };
  assert.throws(() => findExistingBailComment(gh, 42), /non-JSON stdout/);
});

test('postNewBailComment — happy path returns posted action', () => {
  const commentsRef = { value: [] };
  const gh = buildFakeGh(commentsRef);
  const r = postNewBailComment(gh, 7, 'hello');
  assert.strictEqual(r.action, 'posted');
  assert.strictEqual(commentsRef.value.length, 1);
});

test('postNewBailComment — gh failure surfaces as Error', () => {
  const gh = { run: () => ({ status: 1, stdout: '', stderr: 'nope' }) };
  assert.throws(() => postNewBailComment(gh, 7, 'x'), /gh pr comment failed/);
});

test('patchExistingBailComment — happy path edits in place', () => {
  const commentsRef = { value: [{ id: '9', body: 'old' }] };
  const gh = buildFakeGh(commentsRef);
  const r = patchExistingBailComment(gh, 'o', 'r', '9', 'new');
  assert.strictEqual(r.action, 'patched');
  assert.strictEqual(commentsRef.value[0].body, 'new');
});

test('patchExistingBailComment — gh failure surfaces as Error', () => {
  const gh = { run: () => ({ status: 1, stdout: '', stderr: 'nope' }) };
  assert.throws(
    () => patchExistingBailComment(gh, 'o', 'r', '1', 'x'),
    /gh api PATCH comment 1 failed/,
  );
});

test('setAttemptedLabel — happy path returns labeled', () => {
  const labelsRef = { value: [] };
  const gh = buildFakeGh({ value: [] }, labelsRef);
  const r = setAttemptedLabel(gh, 'o', 'r', 42);
  assert.strictEqual(r.action, 'labeled');
  assert.ok(labelsRef.value.includes(ATTEMPT_LABEL));
});

test('setAttemptedLabel — gh failure surfaces as Error', () => {
  const gh = { run: () => ({ status: 1, stdout: '', stderr: 'nope' }) };
  assert.throws(
    () => setAttemptedLabel(gh, 'o', 'r', 42),
    /gh api set label failed/,
  );
});

test('runBail — first call POSTs + labels, second call PATCHes (idempotent)', () => {
  const commentsRef = { value: [] };
  const labelsRef = { value: [] };
  const gh = buildFakeGh(commentsRef, labelsRef);
  const env = {
    PR_NUMBER: '42',
    FAILURE_CLASS: 'coverage',
    OWNER: 'owner',
    REPO: 'repo',
    RUN_ID: '99',
    GITHUB_SERVER_URL: 'https://github.com',
  };

  const first = runBail({ env, gh });
  assert.strictEqual(first.action, 'posted');
  assert.strictEqual(commentsRef.value.length, 1);
  assert.ok(commentsRef.value[0].body.includes(BAIL_MARKER));
  assert.ok(labelsRef.value.includes(ATTEMPT_LABEL));

  const second = runBail({ env, gh });
  assert.strictEqual(second.action, 'patched');
  // No duplicate comment.
  assert.strictEqual(commentsRef.value.length, 1);
  // Body still carries the marker after the PATCH round-trip.
  assert.ok(commentsRef.value[0].body.includes(BAIL_MARKER));
});

test('runBail — missing PR_NUMBER throws', () => {
  const gh = buildFakeGh({ value: [] });
  assert.throws(
    () =>
      runBail({
        env: { FAILURE_CLASS: 'coverage', OWNER: 'o', REPO: 'r' },
        gh,
      }),
    /PR_NUMBER is required/,
  );
});

test('runBail — missing FAILURE_CLASS throws', () => {
  const gh = buildFakeGh({ value: [] });
  assert.throws(
    () =>
      runBail({
        env: { PR_NUMBER: '1', OWNER: 'o', REPO: 'r' },
        gh,
      }),
    /FAILURE_CLASS is required/,
  );
});

test('runBail — missing OWNER/REPO throws', () => {
  const gh = buildFakeGh({ value: [] });
  assert.throws(
    () => runBail({ env: { PR_NUMBER: '1', FAILURE_CLASS: 'crap' }, gh }),
    /OWNER and REPO are required/,
  );
});

test('runBail — body for unknown class still contains marker (config-drift loud)', () => {
  const commentsRef = { value: [] };
  const gh = buildFakeGh(commentsRef, { value: [] });
  runBail({
    env: {
      PR_NUMBER: '5',
      FAILURE_CLASS: 'unknown',
      OWNER: 'o',
      REPO: 'r',
    },
    gh,
  });
  assert.ok(commentsRef.value[0].body.includes(BAIL_MARKER));
  assert.ok(commentsRef.value[0].body.includes('`unknown`'));
});

/* ----------------------------- fix step ------------------------------- */

/**
 * Build a fake exec shim driven by a per-command response map. Each
 * recorded call is appended to `calls` so tests can assert on the full
 * sequence (npm ci → biome → git add → git diff --cached → commit → push → label).
 *
 * The `responses` map keys are command labels (e.g. `npm ci`) and
 * values are exec results. Unmatched commands default to `{ status: 0 }`
 * with empty stdout/stderr — the once-per-PR fast-path test exploits
 * this to avoid stubbing every step explicitly.
 */
function buildFakeExec(responses = {}) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts = {}) {
      calls.push({ cmd, args: [...args], env: opts.env });
      const key = `${cmd} ${args.join(' ')}`;
      // Allow tests to register a prefix match (e.g. all `gh api` calls).
      for (const [pattern, resp] of Object.entries(responses)) {
        if (key === pattern || key.startsWith(`${pattern} `)) {
          return { stdout: '', stderr: '', status: 0, ...resp };
        }
      }
      return { stdout: '', stderr: '', status: 0 };
    },
  };
}

test('buildAuthenticatedRemoteUrl — composes x-access-token URL', () => {
  const url = buildAuthenticatedRemoteUrl({
    owner: 'owner',
    repo: 'repo',
    token: 't0k3n',
  });
  assert.strictEqual(
    url,
    'https://x-access-token:t0k3n@github.com/owner/repo.git',
  );
});

test('buildAuthenticatedRemoteUrl — missing token throws', () => {
  assert.throws(
    () => buildAuthenticatedRemoteUrl({ owner: 'o', repo: 'r' }),
    /token is required/,
  );
});

test('buildAuthenticatedRemoteUrl — missing owner/repo throws', () => {
  assert.throws(
    () => buildAuthenticatedRemoteUrl({ owner: '', repo: 'r', token: 't' }),
    /owner and repo are required/,
  );
});

test('assertNoTestFilesStaged — passes when no tests/ paths staged', () => {
  const exec = buildFakeExec({
    'git diff --cached --name-only': { stdout: 'lib/foo.js\nlib/bar.js\n' },
  });
  const staged = assertNoTestFilesStaged(exec);
  assert.deepStrictEqual(staged, ['lib/foo.js', 'lib/bar.js']);
});

test('assertNoTestFilesStaged — throws when a tests/ path is staged', () => {
  const exec = buildFakeExec({
    'git diff --cached --name-only': {
      stdout: 'lib/foo.js\ntests/should-not-be-here.test.js\n',
    },
  });
  assert.throws(
    () => assertNoTestFilesStaged(exec),
    /refusing to commit: staged paths under tests\//,
  );
});

test('assertNoTestFilesStaged — git diff failure surfaces as Error', () => {
  const exec = buildFakeExec({
    'git diff --cached --name-only': { status: 1, stderr: 'fatal' },
  });
  assert.throws(
    () => assertNoTestFilesStaged(exec),
    /git diff --cached failed/,
  );
});

test('runFixStep — short-circuits when auto-fix-attempted label is already present', () => {
  const exec = buildFakeExec({
    // gh api .../labels --jq '.[].name' returns the label list. The
    // sentinel is present, so the script must skip without running
    // npm ci / biome / git.
    'gh api': { stdout: `${ATTEMPT_LABEL}\nsome::other\n` },
  });
  const result = runFixStep({
    env: {
      PR_NUMBER: '42',
      HEAD_BRANCH: 'feature/foo',
      OWNER: 'owner',
      REPO: 'repo',
      GH_TOKEN: 't0k3n',
    },
    exec,
  });
  assert.strictEqual(result.skipped, true);
  assert.match(result.reason, /already labeled/);
  // Only the label-list call should have been issued; no biome / git / push.
  const cmds = exec.calls.map((c) => `${c.cmd} ${c.args[0] ?? ''}`.trim());
  assert.deepStrictEqual(cmds, ['gh api']);
});

test('runFixStep — full run when label absent: npm ci → biome → add → diff → commit → push → label', () => {
  const exec = buildFakeExec({
    // No label in the labels listing — script must proceed.
    'gh api /repos/owner/repo/issues/42/labels --jq .[].name': { stdout: '' },
    // git diff --cached returns one non-test file so the commit goes through.
    'git diff --cached --name-only': { stdout: 'lib/foo.js\n' },
  });
  const result = runFixStep({
    env: {
      PR_NUMBER: '42',
      HEAD_BRANCH: 'feature/foo',
      OWNER: 'owner',
      REPO: 'repo',
      GH_TOKEN: 't0k3n',
    },
    exec,
  });
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.committed, true);
  assert.strictEqual(result.pushed, true);
  assert.strictEqual(result.labeled, true);
  assert.deepStrictEqual(result.stagedPaths, ['lib/foo.js']);

  // Assert the sequence shape (cmd + first arg) is what we expect.
  const seq = exec.calls.map((c) => `${c.cmd} ${c.args[0]}`);
  // Pre-label-guard read.
  assert.ok(seq.includes('gh api'));
  // npm ci.
  assert.ok(seq.includes('npm ci'));
  // biome twice (check --apply, format --write).
  const biomes = exec.calls.filter(
    (c) => c.cmd === 'npx' && c.args[0] === 'biome',
  );
  assert.strictEqual(biomes.length, 2);
  assert.ok(biomes[0].args.includes('check'));
  assert.ok(biomes[0].args.includes('--apply'));
  assert.ok(biomes[1].args.includes('format'));
  assert.ok(biomes[1].args.includes('--write'));
  // git add with :^tests/** exclusion.
  const addCall = exec.calls.find(
    (c) => c.cmd === 'git' && c.args[0] === 'add',
  );
  assert.ok(addCall);
  assert.ok(addCall.args.includes(':^tests/**'));
  // git commit with the [auto-fix] subject.
  const commitCall = exec.calls.find(
    (c) => c.cmd === 'git' && c.args[0] === 'commit',
  );
  assert.ok(commitCall);
  assert.ok(commitCall.args.includes(COMMIT_SUBJECT));
  // Commit env carries bot identity.
  assert.ok(commitCall.env);
  assert.match(commitCall.env.GIT_AUTHOR_NAME, /agent-protocols-reviewer/);
  // git push to refs/heads/<head_branch>.
  const pushCall = exec.calls.find(
    (c) => c.cmd === 'git' && c.args[0] === 'push',
  );
  assert.ok(pushCall);
  assert.ok(
    pushCall.args.some((a) => a === 'HEAD:refs/heads/feature/foo'),
    'push must target refs/heads/<head_branch>',
  );
  // Final label POST.
  const labelPost = exec.calls.find(
    (c) =>
      c.cmd === 'gh' &&
      c.args.includes('POST') &&
      c.args.some((a) => /labels$/.test(a)),
  );
  assert.ok(labelPost, 'final label POST must be issued');
});

test('runFixStep — empty stage after biome is a labeled no-op (still sets label)', () => {
  const exec = buildFakeExec({
    'gh api /repos/owner/repo/issues/42/labels --jq .[].name': { stdout: '' },
    // biome found nothing to fix → git diff --cached returns empty.
    'git diff --cached --name-only': { stdout: '' },
  });
  const result = runFixStep({
    env: {
      PR_NUMBER: '42',
      HEAD_BRANCH: 'feature/foo',
      OWNER: 'owner',
      REPO: 'repo',
      GH_TOKEN: 't0k3n',
    },
    exec,
  });
  assert.strictEqual(result.skipped, true);
  assert.match(result.reason, /nothing to fix/);
  // No commit or push should have been attempted.
  const commitCall = exec.calls.find(
    (c) => c.cmd === 'git' && c.args[0] === 'commit',
  );
  assert.strictEqual(commitCall, undefined);
  // But the label should still have been set.
  const labelPost = exec.calls.find(
    (c) =>
      c.cmd === 'gh' &&
      c.args.includes('POST') &&
      c.args.some((a) => /labels$/.test(a)),
  );
  assert.ok(labelPost);
});

test('runFixStep — refuses to commit when tests/ paths are staged (3rd-layer guard)', () => {
  const exec = buildFakeExec({
    'gh api /repos/owner/repo/issues/42/labels --jq .[].name': { stdout: '' },
    // Simulate a regression where biome/add somehow staged a test file.
    'git diff --cached --name-only': {
      stdout: 'lib/foo.js\ntests/regression.test.js\n',
    },
  });
  assert.throws(
    () =>
      runFixStep({
        env: {
          PR_NUMBER: '42',
          HEAD_BRANCH: 'feature/foo',
          OWNER: 'owner',
          REPO: 'repo',
          GH_TOKEN: 't0k3n',
        },
        exec,
      }),
    /refusing to commit: staged paths under tests\//,
  );
  // No commit or push should have been attempted past the guard.
  const commitCall = exec.calls.find(
    (c) => c.cmd === 'git' && c.args[0] === 'commit',
  );
  assert.strictEqual(commitCall, undefined);
});

test('runFixStep — missing PR_NUMBER throws', () => {
  assert.throws(
    () =>
      runFixStep({
        env: {
          HEAD_BRANCH: 'b',
          OWNER: 'o',
          REPO: 'r',
          GH_TOKEN: 't',
        },
        exec: buildFakeExec(),
      }),
    /PR_NUMBER is required/,
  );
});

test('runFixStep — missing HEAD_BRANCH throws', () => {
  assert.throws(
    () =>
      runFixStep({
        env: { PR_NUMBER: '1', OWNER: 'o', REPO: 'r', GH_TOKEN: 't' },
        exec: buildFakeExec(),
      }),
    /HEAD_BRANCH is required/,
  );
});

test('runFixStep — missing GH_TOKEN throws', () => {
  assert.throws(
    () =>
      runFixStep({
        env: {
          PR_NUMBER: '1',
          HEAD_BRANCH: 'b',
          OWNER: 'o',
          REPO: 'r',
        },
        exec: buildFakeExec(),
      }),
    /GH_TOKEN is required/,
  );
});
