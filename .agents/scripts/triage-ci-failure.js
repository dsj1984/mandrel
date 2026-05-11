#!/usr/bin/env node
/**
 * CI failure triage commenter.
 *
 * Invoked from `.github/workflows/triage-pr-failure.yml` after the `CI /
 * CD` workflow's `validate` matrix completes with `conclusion == 'failure'`
 * on a pull_request event. Reads the test-output and crap-report artifacts
 * the upstream workflow already uploaded, renders a single marker-keyed
 * Markdown comment, and either creates it (no existing marker comment) or
 * edits the existing one (marker found) so re-runs do not duplicate.
 *
 * Inputs (env):
 *   - PR_NUMBER      target PR (resolved by the workflow's `Resolve PR number` step)
 *   - RUN_ID         the failing workflow_run id (used for the run-link URL)
 *   - ARTIFACTS_DIR  root of the downloaded artifacts tree
 *   - GH_TOKEN       PAT or GITHUB_TOKEN scoped to pull-requests:write
 *   - GITHUB_REPOSITORY  owner/repo (auto-set by GitHub Actions)
 *   - GITHUB_SERVER_URL  e.g. https://github.com (auto-set)
 *
 * Exit codes:
 *   0  comment posted or edited successfully
 *   1  missing required env var or artifacts directory absent
 *
 * The CLI is split into:
 *   - `runTriage(deps)`  the testable entry point. Accepts an injected
 *                        gh shim, fs, and env so tests can drive the
 *                        idempotent POST-then-PATCH behavior without
 *                        spawning gh.
 *   - `main()`           the production wrapper that wires the real gh
 *                        CLI, real fs, and process.env.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseCrapReport } from './lib/triage/parse-crap-report.js';
import { parseTestOutput } from './lib/triage/parse-test-output.js';
import {
  renderTriageComment,
  TRIAGE_MARKER,
} from './lib/triage/render-comment.js';

/**
 * @typedef {object} GhShim
 * @property {(args:string[], opts?:{ input?: string }) => { stdout:string, status:number, stderr:string }} run
 */

/**
 * Default gh shim that shells out to the real `gh` CLI. Production callers
 * receive this from `main()`. Tests pass a stub.
 *
 * Kept off the testable code path so coverage of `runTriage()` does not
 * depend on `gh` being installed in the test environment.
 *
 * @returns {GhShim}
 */
export function defaultGhShim() {
  return {
    run(args, opts = {}) {
      const result = spawnSync('gh', args, {
        input: opts.input,
        encoding: 'utf8',
        // Inherit GH_TOKEN, GH_REPO, etc.
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
 * Locate test-output.txt files inside `ARTIFACTS_DIR`. The actions
 * download-artifact step lays out artifacts as
 * `<dir>/<artifact-name>/<file>` so we glob the immediate children for
 * folder names starting with `test-results-`.
 *
 * Returns parsed payloads keyed by inferred OS label (extracted from the
 * artifact folder name) so the renderer can produce a stable order.
 *
 * @param {string} artifactsDir
 * @param {{ fsImpl?: typeof fs }} [deps]
 */
export function collectTestOutputs(artifactsDir, deps = {}) {
  const fsImpl = deps.fsImpl ?? fs;
  if (!fsImpl.existsSync(artifactsDir)) {
    return [];
  }
  const entries = fsImpl.readdirSync(artifactsDir, { withFileTypes: true });
  const folders = entries.filter(
    (e) => e.isDirectory() && e.name.startsWith('test-results-'),
  );
  const payloads = [];
  for (const folder of folders) {
    const txtPath = path.join(artifactsDir, folder.name, 'test-output.txt');
    if (!fsImpl.existsSync(txtPath)) continue;
    const raw = fsImpl.readFileSync(txtPath, 'utf8');
    // Folder name shape: test-results-<os>-node-<v>
    // Extract the <os> token between `test-results-` and `-node-`.
    const osMatch = folder.name.match(/^test-results-(.+)-node-\d+$/);
    const os = osMatch ? osMatch[1] : folder.name.replace(/^test-results-/, '');
    payloads.push(parseTestOutput(raw, { os, tailLines: 30 }));
  }
  return payloads;
}

/**
 * Locate and parse the first available `crap-report.json`. CRAP reports
 * are identical across OS legs by design (full-repo scan), so we pick the
 * first one found; if none are present we return an empty regression list
 * rather than failing — the CRAP gate is optional per consumer project.
 *
 * @param {string} artifactsDir
 * @param {{ fsImpl?: typeof fs }} [deps]
 */
export function collectCrapRegressions(artifactsDir, deps = {}) {
  const fsImpl = deps.fsImpl ?? fs;
  if (!fsImpl.existsSync(artifactsDir)) return [];
  const entries = fsImpl.readdirSync(artifactsDir, { withFileTypes: true });
  const folders = entries.filter(
    (e) => e.isDirectory() && e.name.startsWith('crap-report-'),
  );
  for (const folder of folders) {
    const jsonPath = path.join(artifactsDir, folder.name, 'crap-report.json');
    if (!fsImpl.existsSync(jsonPath)) continue;
    const raw = fsImpl.readFileSync(jsonPath, 'utf8');
    const { top } = parseCrapReport(raw, { source: jsonPath, top: 5 });
    return top;
  }
  return [];
}

/**
 * Look up the marker-keyed comment on the PR via `gh pr view`. Returns
 * the comment id (numeric) if found, otherwise null.
 *
 * @param {GhShim} gh
 * @param {string|number} prNumber
 * @param {string} marker
 */
export function findExistingTriageComment(gh, prNumber, marker) {
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
  // Iterate in reverse so we match the most recently posted marker comment
  // (if a stray duplicate exists, we update the newest one rather than the
  // stale one and leave the older for manual cleanup).
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (typeof c?.body === 'string' && c.body.includes(marker)) {
      const id = c.id ?? c.databaseId ?? c.url?.split('-')?.pop();
      if (id !== undefined && id !== null) return String(id);
    }
  }
  return null;
}

/**
 * Post a new comment on the PR via `gh pr comment --body-file -`.
 *
 * @param {GhShim} gh
 * @param {string|number} prNumber
 * @param {string} body
 */
export function postNewComment(gh, prNumber, body) {
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
 * Patch an existing comment in place via the REST API.
 *
 * @param {GhShim} gh
 * @param {string} owner
 * @param {string} repo
 * @param {string} commentId
 * @param {string} body
 */
export function patchExistingComment(gh, owner, repo, commentId, body) {
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
 * Idempotent entry point. Pure with respect to the injected `deps` so the
 * test suite can drive POST-then-PATCH behavior without spawning gh.
 *
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {GhShim} deps.gh
 * @param {typeof fs} [deps.fsImpl]
 * @returns {{ action: 'posted'|'patched', body: string, commentId?: string }}
 */
export function runTriage(deps) {
  const { env, gh, fsImpl = fs } = deps;
  const prNumber = env.PR_NUMBER;
  const runId = env.RUN_ID;
  const artifactsDir = env.ARTIFACTS_DIR;
  const repoSlug = env.GITHUB_REPOSITORY;
  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';

  if (!prNumber) throw new Error('PR_NUMBER is required');
  if (!runId) throw new Error('RUN_ID is required');
  if (!artifactsDir) throw new Error('ARTIFACTS_DIR is required');
  if (!fsImpl.existsSync(artifactsDir)) {
    throw new Error(`ARTIFACTS_DIR does not exist: ${artifactsDir}`);
  }

  const testOutputs = collectTestOutputs(artifactsDir, { fsImpl });
  const crapRegressions = collectCrapRegressions(artifactsDir, { fsImpl });

  // Require at least one signal — if both artifact families are absent we
  // exit non-zero so the workflow surfaces config drift loudly per the
  // acceptance criterion. (Empty crap report + empty test-output payloads
  // both indicate an upstream wiring problem worth a CI alert.)
  if (testOutputs.length === 0 && crapRegressions.length === 0) {
    throw new Error(
      'No triage artifacts found under ARTIFACTS_DIR ' +
        `(${artifactsDir}); expected test-results-*/test-output.txt or ` +
        'crap-report-*/crap-report.json',
    );
  }

  const runUrl = repoSlug
    ? `${serverUrl}/${repoSlug}/actions/runs/${runId}`
    : undefined;

  const body = renderTriageComment({
    runId,
    runUrl,
    testOutputs,
    crapRegressions,
  });

  const existingId = findExistingTriageComment(gh, prNumber, TRIAGE_MARKER);
  if (existingId) {
    const [owner, repo] = (repoSlug ?? '/').split('/');
    if (!owner || !repo) {
      throw new Error(
        'GITHUB_REPOSITORY must be owner/repo to PATCH an existing comment',
      );
    }
    patchExistingComment(gh, owner, repo, existingId, body);
    return { action: 'patched', commentId: existingId, body };
  }
  postNewComment(gh, prNumber, body);
  return { action: 'posted', body };
}

/**
 * Production wrapper. Reads `process.env`, wires the real gh shim, and
 * exits non-zero on any thrown error.
 */
export async function main() {
  try {
    const result = runTriage({ env: process.env, gh: defaultGhShim() });
    process.stdout.write(
      `${JSON.stringify({ ok: true, action: result.action, commentId: result.commentId })}\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`triage-ci-failure: ${err.message}\n`);
    process.exit(1);
  }
}

// Only auto-run when invoked directly (not when imported by tests).
const isDirect = (() => {
  try {
    const argvUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();
if (isDirect) {
  main();
}
