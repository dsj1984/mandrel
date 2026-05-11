#!/usr/bin/env node
/**
 * auto-fix-step.js — biome --apply + commit + push step for s4-auto-fix.
 *
 * Invoked from `.github/workflows/auto-fix.yml` when the detected failure
 * class is `lint` or `format`. Runs the documented sequence:
 *
 *   1. `npm ci` (clean install — workflows/auto-fix.yml does not run setup-node's
 *      install action; this script owns its dependencies).
 *   2. `npx biome check --apply .` and `npx biome format --write .`, both
 *      with tests/** excluded (`--files-ignore-unknown=true` + an explicit
 *      `--config-path` is not needed — biome already respects biome.json's
 *      `files.ignore` block, and we additionally skip-stage anything under
 *      tests/ as belt-and-suspenders).
 *   3. `git add -u :^tests/**` so only non-test changes are staged (the
 *      pathspec magic `:^` excludes paths matching the glob).
 *   4. `git commit -m '[auto-fix] biome lint/format'` authored by the bot
 *      identity (env: GIT_AUTHOR_NAME / GIT_COMMITTER_NAME = the App slug).
 *   5. `git push origin HEAD:<head_branch>` using GH_TOKEN auth via the
 *      `https://x-access-token:${GH_TOKEN}@github.com/...` remote URL.
 *   6. `gh api POST /repos/.../issues/<pr>/labels` to set `auto-fix-attempted`
 *      so the once-per-PR cap holds on subsequent runs.
 *
 * The `[auto-fix]` subject prefix is load-bearing — `.github/workflows/bot-approve.yml`'s
 * self-approval guard short-circuits on it as the second arm of the
 * defensive belt-and-suspenders (the primary arm is the bot user.login
 * comparison). Do not change the prefix without updating the guard.
 *
 * Test files are off-limits. The Tech Spec is explicit: auto-fix never
 * modifies tests/**. We achieve this through three independent layers:
 *   - biome.json `files.ignore` already excludes tests/** for lint
 *   - the `git add` pathspec excludes tests/**
 *   - a post-stage guard asserts `git diff --cached --name-only` contains
 *     no path beginning with `tests/`, aborting if it does
 *
 * Split into `runFixStep(deps)` + `main()` for the same reason as
 * `auto-fix-bail.js`: the unit tests under tests/auto-fix/ drive the
 * once-per-pr guard and the test-file exclusion without spawning gh / git.
 */

import { spawnSync } from 'node:child_process';
import { runAsCli } from './lib/cli-utils.js';

/** Subject of the auto-fix commit. The leading `[auto-fix]` token is
 *  parsed by `.github/workflows/bot-approve.yml`'s self-approval guard. */
export const COMMIT_SUBJECT = '[auto-fix] biome lint/format';

/** Sentinel label shared with `auto-fix-bail.js` and the workflow's
 *  label-guard step. Synchronised on the constant name. */
export const ATTEMPT_LABEL = 'auto-fix-attempted';

/** Default identity used for the auto-fix commit. The workflow overrides
 *  these with the actual GitHub App slug at runtime; the defaults exist
 *  so unit tests do not need to inject them. */
export const DEFAULT_BOT_NAME = 'agent-protocols-reviewer[bot]';
export const DEFAULT_BOT_EMAIL =
  'agent-protocols-reviewer[bot]@users.noreply.github.com';

/**
 * @typedef {object} ExecResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} status
 */

/**
 * @typedef {object} ExecShim
 * @property {(cmd: string, args: string[], opts?: { input?: string, env?: Record<string,string|undefined> }) => ExecResult} run
 */

/**
 * Default exec shim that shells out via `spawnSync`. Production callers
 * receive this from `main()`. Tests pass a stub that records the calls
 * and returns canned exit statuses.
 *
 * @returns {ExecShim}
 */
export function defaultExecShim() {
  return {
    run(cmd, args, opts = {}) {
      const result = spawnSync(cmd, args, {
        input: opts.input,
        encoding: 'utf8',
        env: opts.env ?? process.env,
        // Run npm.cmd / npx.cmd on Windows runners. The workflow always
        // runs on ubuntu-latest, but keeping shell:false maintains parity
        // with the rest of .agents/scripts/.
        shell: false,
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
 * Run a single command via the exec shim and throw if it exits non-zero.
 * Centralises the boilerplate so the orchestration is readable.
 *
 * @param {ExecShim} exec
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string,string|undefined>, label?: string }} [opts]
 * @returns {ExecResult}
 */
export function runOrThrow(exec, cmd, args, opts = {}) {
  const label = opts.label ?? `${cmd} ${args.join(' ')}`;
  const result = exec.run(cmd, args, { env: opts.env });
  if (result.status !== 0) {
    throw new Error(
      `[auto-fix-step] command failed: ${label} (status ${result.status})\n${result.stderr.trim()}`,
    );
  }
  return result;
}

/**
 * Assert that no path under tests/ has been staged for commit. The biome
 * config already ignores tests/**, and `git add` was called with a
 * `:^tests/**` pathspec, but a third layer of defense keeps the contract
 * obvious — if anyone alters either of the first two layers, this guard
 * still trips and the workflow fails loud.
 *
 * @param {ExecShim} exec
 * @returns {string[]} list of staged paths (for logging)
 */
export function assertNoTestFilesStaged(exec) {
  const result = exec.run('git', ['diff', '--cached', '--name-only']);
  if (result.status !== 0) {
    throw new Error(
      `[auto-fix-step] git diff --cached failed (status ${result.status}): ${result.stderr.trim()}`,
    );
  }
  const staged = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const offenders = staged.filter((p) => p.startsWith('tests/'));
  if (offenders.length > 0) {
    throw new Error(
      `[auto-fix-step] refusing to commit: staged paths under tests/: ${offenders.join(', ')}`,
    );
  }
  return staged;
}

/**
 * Build the authenticated remote URL for `git push`. Uses the
 * `x-access-token` pattern documented by GitHub for installation tokens.
 *
 * Exported for unit tests so they can assert the URL shape without
 * shelling out to git.
 *
 * @param {{ owner: string, repo: string, token: string }} input
 * @returns {string}
 */
export function buildAuthenticatedRemoteUrl({ owner, repo, token }) {
  if (!owner || !repo) {
    throw new Error('buildAuthenticatedRemoteUrl: owner and repo are required');
  }
  if (!token) {
    throw new Error('buildAuthenticatedRemoteUrl: token is required');
  }
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

/**
 * Idempotent entry point. Drives steps (1)–(6) above with the injected
 * exec shim. Returns `{ skipped: true, reason }` for the once-per-PR
 * fast-path (the workflow's label-guard step is the primary defense, but
 * the script re-checks defensively to keep callers honest).
 *
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {ExecShim} deps.exec
 * @returns {{
 *   skipped: false, committed: true, pushed: true, labeled: boolean, stagedPaths: string[]
 * } | { skipped: true, reason: string }}
 */
export function runFixStep(deps) {
  const { env, exec } = deps;
  const prNumber = env.PR_NUMBER;
  const headBranch = env.HEAD_BRANCH;
  const owner = env.OWNER;
  const repo = env.REPO;
  const token = env.GH_TOKEN;
  const botName = env.BOT_NAME ?? DEFAULT_BOT_NAME;
  const botEmail = env.BOT_EMAIL ?? DEFAULT_BOT_EMAIL;

  if (!prNumber) throw new Error('PR_NUMBER is required');
  if (!headBranch) throw new Error('HEAD_BRANCH is required');
  if (!owner || !repo) throw new Error('OWNER and REPO are required');
  if (!token) throw new Error('GH_TOKEN is required');

  // Belt: re-check the once-per-PR label even though the workflow already
  // guarded on it. The check is cheap and prevents a racy re-run from
  // landing two auto-fix commits on the same PR.
  const labelsResult = exec.run('gh', [
    'api',
    `/repos/${owner}/${repo}/issues/${prNumber}/labels`,
    '--jq',
    '.[].name',
  ]);
  if (labelsResult.status === 0) {
    const labels = labelsResult.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (labels.includes(ATTEMPT_LABEL)) {
      return {
        skipped: true,
        reason: `PR already labeled ${ATTEMPT_LABEL}; no-op`,
      };
    }
  }

  // 1. `npm ci` — clean install for the fix run. The workflow's working
  //    tree is a fresh checkout of head_sha so no node_modules pre-exists.
  runOrThrow(exec, 'npm', ['ci'], { label: 'npm ci' });

  // 2. Biome lint --apply (write fixable diagnostics in place). The path
  //    `.` plus the config's files.ignore takes care of tests/** exclusion,
  //    but we add `--no-errors-on-unmatched` so the run does not fail on
  //    an empty match set.
  runOrThrow(
    exec,
    'npx',
    ['biome', 'check', '--apply', '--no-errors-on-unmatched', '.'],
    {
      label: 'biome check --apply',
    },
  );

  // 3. Biome format --write (apply formatter rules). Same exclusion path.
  runOrThrow(
    exec,
    'npx',
    ['biome', 'format', '--write', '--no-errors-on-unmatched', '.'],
    {
      label: 'biome format --write',
    },
  );

  // 4. Stage modified tracked files only, excluding tests/**. The `:^`
  //    pathspec is "exclude" magic; combined with `-u` we never stage a
  //    new file biome might have created (it doesn't, but the contract
  //    holds without us having to trust biome's behaviour).
  runOrThrow(exec, 'git', ['add', '-u', '--', '.', ':^tests/**'], {
    label: 'git add -u :^tests/**',
  });

  // 4b. Belt-and-suspenders: assert no tests/ paths slipped through.
  const stagedPaths = assertNoTestFilesStaged(exec);

  // If biome found nothing to fix, the stage is empty. Treat that as a
  // no-op success rather than failing the workflow — the label still
  // gets set so we don't loop.
  if (stagedPaths.length === 0) {
    setLabel(exec, owner, repo, prNumber);
    return {
      skipped: true,
      reason: 'biome found nothing to fix; no-op (label set)',
    };
  }

  // 5. Commit as the bot identity. The author env vars are scoped to the
  //    git invocation only; we do not mutate process.env.
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: botName,
    GIT_AUTHOR_EMAIL: botEmail,
    GIT_COMMITTER_NAME: botName,
    GIT_COMMITTER_EMAIL: botEmail,
  };
  runOrThrow(exec, 'git', ['commit', '-m', COMMIT_SUBJECT], {
    env: commitEnv,
    label: `git commit -m "${COMMIT_SUBJECT}"`,
  });

  // 6. Push to the PR's head branch via an authenticated remote URL.
  //    We push HEAD to refs/heads/<head_branch> rather than relying on
  //    upstream tracking — the workflow checkout is detached at head_sha.
  const remoteUrl = buildAuthenticatedRemoteUrl({ owner, repo, token });
  runOrThrow(
    exec,
    'git',
    ['push', remoteUrl, `HEAD:refs/heads/${headBranch}`],
    {
      label: `git push origin HEAD:refs/heads/${headBranch}`,
    },
  );

  // 7. Set the sentinel label so the workflow short-circuits next time.
  setLabel(exec, owner, repo, prNumber);

  return {
    skipped: false,
    committed: true,
    pushed: true,
    labeled: true,
    stagedPaths,
  };
}

/**
 * Set the `auto-fix-attempted` label via the REST issues endpoint. POST
 * /issues/:n/labels is idempotent on the label set so a repeat call is
 * a no-op.
 *
 * @param {ExecShim} exec
 * @param {string} owner
 * @param {string} repo
 * @param {string|number} prNumber
 */
export function setLabel(exec, owner, repo, prNumber) {
  const result = exec.run('gh', [
    'api',
    '-X',
    'POST',
    `/repos/${owner}/${repo}/issues/${prNumber}/labels`,
    '-f',
    `labels[]=${ATTEMPT_LABEL}`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `[auto-fix-step] gh api set label failed (status ${result.status}): ${result.stderr.trim()}`,
    );
  }
  return true;
}

/**
 * Production wrapper. Reads `process.env`, wires the real exec shim, and
 * writes a single-line JSON envelope to stdout.
 */
export async function main() {
  const result = runFixStep({ env: process.env, exec: defaultExecShim() });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

runAsCli(import.meta.url, main, { source: 'auto-fix-step', exitCode: 1 });
