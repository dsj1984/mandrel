#!/usr/bin/env node
/**
 * auto-fix-bail.js — marker-keyed bail comment for non-fixable failure classes.
 *
 * Invoked from `.github/workflows/auto-fix.yml` when the detected
 * `FailureClass` is anything other than `lint`/`format` (i.e. `coverage`,
 * `crap`, `maintainability`, `test`, or `unknown`). Posts a single
 * marker-keyed comment on the PR explaining why the auto-fix workflow
 * is *not* going to touch the branch, and sets the `auto-fix-attempted`
 * label so the once-per-PR cap holds (the workflow re-checks the label
 * on subsequent runs and short-circuits).
 *
 * Idempotent:
 *   - First call POSTs a new comment via `gh pr comment --body-file -`.
 *   - Second call (same fixtures) finds the existing marker comment via
 *     `gh pr view --json comments`, PATCHes it in place via the REST API.
 *   - The `auto-fix-attempted` label is set via `gh api PUT` which is a
 *     no-op if the label is already present.
 *
 * Inputs (env):
 *   - PR_NUMBER       target PR (resolved by the workflow's PR step)
 *   - FAILURE_CLASS   one of: coverage|crap|maintainability|test|unknown
 *   - RUN_ID          the failing workflow_run id (used for the deep-link)
 *   - OWNER           repository owner (auto-set from github.repository_owner)
 *   - REPO            repository name (auto-set from github.event.repository.name)
 *   - GH_TOKEN        installation token from create-github-app-token
 *   - GITHUB_SERVER_URL (optional, defaults to https://github.com)
 *
 * Exit codes:
 *   0 — comment + label landed successfully (idempotent on second run)
 *   1 — missing required env or gh failure
 *
 * Split, like `triage-ci-failure.js`, into a `runBail()` pure entry point
 * with an injected gh shim + `main()` production wrapper, so the unit
 * tests under tests/auto-fix/ can drive the POST-then-PATCH behavior
 * without spawning gh.
 */

import { spawnSync } from 'node:child_process';
import { runAsCli } from './lib/cli-utils.js';

/** Marker token that keys the comment. Bumping `v1` → `v2` would force a
 *  new POST on the next run; do not change without a migration plan. */
export const BAIL_MARKER = '<!-- auto-fix-bail v1 -->';

/** Sentinel label that gates the once-per-PR cap. Synchronised with the
 *  workflow's label-guard step and with the fix-step's label upsert. */
export const ATTEMPT_LABEL = 'auto-fix-attempted';

/** Human-readable headlines per failure class. Used by `renderBailBody`. */
const CLASS_HEADLINES = Object.freeze({
  coverage: 'Coverage threshold not met',
  crap: 'CRAP regression detected',
  maintainability: 'Maintainability regression detected',
  test: 'Test assertion failed',
  unknown: 'Failure class could not be determined',
});

/** Per-class operator hint. Kept brief — the deeper signal is in the
 *  sibling triage-ci-failure comment, which carries the actual stderr
 *  tail. We just explain why *this* workflow is not going to act. */
const CLASS_HINTS = Object.freeze({
  coverage:
    'A coverage gap needs new test coverage, which auto-fix cannot synthesise. ' +
    'Add tests that exercise the uncovered lines and re-push.',
  crap:
    'CRAP regressions reflect rising complexity-on-low-coverage. Either lower ' +
    'complexity in the flagged method or raise its coverage; auto-fix will ' +
    'not refactor for you.',
  maintainability:
    'Maintainability regressions reflect a structural drift the engine has ' +
    'flagged. Review the regression list in the triage comment and refactor ' +
    'before re-pushing.',
  test:
    'A test assertion failed. Auto-fix only handles lint/format and will not ' +
    'modify test behaviour. Read the triage comment for the failing leg.',
  unknown:
    'The failure-class detector could not find a recognised marker in the ' +
    'test-output artifacts. This usually means CI is failing for a reason ' +
    'upstream of the gates this workflow knows about — open the failing ' +
    'workflow run and triage manually.',
});

/**
 * @typedef {object} GhShim
 * @property {(args:string[], opts?:{ input?: string }) => { stdout:string, status:number, stderr:string }} run
 */

/**
 * Default gh shim that shells out to the real CLI. Production callers
 * receive this from `main()`. Tests pass a stub.
 *
 * @returns {GhShim}
 */
export function defaultGhShim() {
  return {
    run(args, opts = {}) {
      const result = spawnSync('gh', args, {
        input: opts.input,
        encoding: 'utf8',
        env: process.env,
      });
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        status: result.status ?? 1,
      };
    },
  };
}

/**
 * Render the bail comment body. Pure — exported so the test fixtures can
 * snapshot the rendered output without going through the gh shim.
 *
 * The body is intentionally short: the operator already gets the deep
 * signal from the sibling triage-ci-failure comment; this one is just the
 * explicit "auto-fix declined" record.
 *
 * @param {{ failureClass: string, runUrl?: string }} input
 * @returns {string}
 */
export function renderBailBody({ failureClass, runUrl }) {
  const cls = String(failureClass ?? 'unknown');
  const headline = CLASS_HEADLINES[cls] ?? CLASS_HEADLINES.unknown;
  const hint = CLASS_HINTS[cls] ?? CLASS_HINTS.unknown;
  const runLink = runUrl ? `\n\n[View failing workflow run](${runUrl})` : '';
  return [
    BAIL_MARKER,
    `### 🛑 Auto-fix declined — \`${cls}\``,
    '',
    `**${headline}.** ${hint}`,
    '',
    `_The \`${ATTEMPT_LABEL}\` label has been set on this PR; auto-fix ` +
      'will not re-run until the label is removed by a maintainer._',
    runLink,
  ]
    .join('\n')
    .trim();
}

/**
 * Look up the marker-keyed bail comment on the PR. Returns the comment
 * id (numeric) if found, otherwise null. Mirrors `findExistingTriageComment`
 * in triage-ci-failure.js so the two scripts stay readable side-by-side.
 *
 * @param {GhShim} gh
 * @param {string|number} prNumber
 * @returns {string | null}
 */
export function findExistingBailComment(gh, prNumber) {
  const result = gh.run(['pr', 'view', String(prNumber), '--json', 'comments']);
  if (result.status !== 0) {
    throw new Error(
      `gh pr view failed (status ${result.status}): ${result.stderr.trim()}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`gh pr view returned non-JSON stdout: ${err.message}`);
  }
  const comments = Array.isArray(parsed?.comments) ? parsed.comments : [];
  // Walk newest-first so a stray duplicate still hits the most recent
  // marker (and we leave the older one for manual cleanup).
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (typeof c?.body === 'string' && c.body.includes(BAIL_MARKER)) {
      const id = c.id ?? c.databaseId ?? c.url?.split('-')?.pop();
      if (id !== undefined && id !== null) return String(id);
    }
  }
  return null;
}

/**
 * Post a new bail comment via `gh pr comment --body-file -`.
 *
 * @param {GhShim} gh
 * @param {string|number} prNumber
 * @param {string} body
 */
export function postNewBailComment(gh, prNumber, body) {
  const result = gh.run(
    ['pr', 'comment', String(prNumber), '--body-file', '-'],
    { input: body },
  );
  if (result.status !== 0) {
    throw new Error(
      `gh pr comment failed (status ${result.status}): ${result.stderr.trim()}`,
    );
  }
  return { action: 'posted', stdout: result.stdout };
}

/**
 * Patch an existing bail comment in place via REST.
 *
 * @param {GhShim} gh
 * @param {string} owner
 * @param {string} repo
 * @param {string} commentId
 * @param {string} body
 */
export function patchExistingBailComment(gh, owner, repo, commentId, body) {
  const result = gh.run([
    'api',
    '-X',
    'PATCH',
    `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    '-f',
    `body=${body}`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `gh api PATCH comment ${commentId} failed (status ${result.status}): ${result.stderr.trim()}`,
    );
  }
  return { action: 'patched', commentId, stdout: result.stdout };
}

/**
 * Set the `auto-fix-attempted` label on the PR via the REST issues
 * endpoint. `POST /issues/:n/labels` is idempotent on the label set — if
 * the label is already present GitHub returns the existing label list
 * with no duplication, so a second invocation is a no-op.
 *
 * @param {GhShim} gh
 * @param {string} owner
 * @param {string} repo
 * @param {string|number} prNumber
 */
export function setAttemptedLabel(gh, owner, repo, prNumber) {
  const result = gh.run([
    'api',
    '-X',
    'POST',
    `/repos/${owner}/${repo}/issues/${prNumber}/labels`,
    '-f',
    `labels[]=${ATTEMPT_LABEL}`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `gh api set label failed (status ${result.status}): ${result.stderr.trim()}`,
    );
  }
  return { action: 'labeled', stdout: result.stdout };
}

/**
 * Idempotent entry point. Pure with respect to the injected `gh` shim so
 * the unit tests under tests/auto-fix/ can drive the POST-then-PATCH
 * behavior and the label call without spawning gh.
 *
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {GhShim} deps.gh
 * @returns {{ action: 'posted'|'patched', body: string, commentId?: string, labeled: boolean }}
 */
export function runBail(deps) {
  const { env, gh } = deps;
  const prNumber = env.PR_NUMBER;
  const failureClass = env.FAILURE_CLASS;
  const owner = env.OWNER;
  const repo = env.REPO;
  const runId = env.RUN_ID;
  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';

  if (!prNumber) throw new Error('PR_NUMBER is required');
  if (!failureClass) throw new Error('FAILURE_CLASS is required');
  if (!owner || !repo) {
    throw new Error('OWNER and REPO are required');
  }

  const runUrl =
    runId && owner && repo
      ? `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`
      : undefined;

  const body = renderBailBody({ failureClass, runUrl });

  const existingId = findExistingBailComment(gh, prNumber);
  let commentResult;
  if (existingId) {
    patchExistingBailComment(gh, owner, repo, existingId, body);
    commentResult = { action: 'patched', commentId: existingId, body };
  } else {
    postNewBailComment(gh, prNumber, body);
    commentResult = { action: 'posted', body };
  }

  setAttemptedLabel(gh, owner, repo, prNumber);

  return { ...commentResult, labeled: true };
}

/**
 * Production wrapper. Reads `process.env`, wires the real gh shim, and
 * writes a single-line JSON envelope to stdout.
 */
export async function main() {
  const result = runBail({ env: process.env, gh: defaultGhShim() });
  process.stdout.write(
    `${JSON.stringify({ ok: true, action: result.action, commentId: result.commentId, labeled: result.labeled })}\n`,
  );
}

runAsCli(import.meta.url, main, { source: 'auto-fix-bail', exitCode: 1 });
