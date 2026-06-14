/**
 * bootstrap/preflight — unified prerequisite preflight (Story #3375).
 *
 * Aggregates the cold-start prerequisite checks into a single
 * fail-before-mutate gate that `bootstrap.js` runs as the FIRST pipeline
 * phase, ahead of any project-side or GitHub-side mutation:
 *
 *   - Node version  — reuses `checkNodeVersion` from `project-bootstrap.js`.
 *   - git available — `git --version` resolves on PATH.
 *   - inside-work-tree — `git rev-parse --is-inside-work-tree` is true.
 *   - gh CLI + auth — reuses `preflightGh` from `gh-preflight.js`; skipped
 *     entirely when `skipGithub` is true.
 *
 * `runPreflight({ skipGithub })` returns `{ ok, checks }` where `ok` is
 * false when any check failed. Every failing check carries a `remedy`
 * string so the CLI can print actionable next steps before halting.
 *
 * The runner seams (`nodeCheck`, `gitRunner`, `gh`) default to the real
 * implementations and are injectable so the unit test can drive every
 * branch without spawning real child processes.
 */

import { spawnSync } from 'node:child_process';
import { checkProjectScopes, preflightGh } from './gh-preflight.js';
import { checkNodeVersion } from './project-bootstrap.js';

const GIT_INSTALL_HINT =
  'Install git: https://git-scm.com/downloads — then re-run this command.';
const GIT_WORKTREE_HINT =
  'Run this command from inside a git repository (run `git init` or `cd` into your project clone), then re-run.';
const NODE_REMEDY = (result) =>
  `Node ${result.version} is below required ${result.required}. Upgrade Node (https://nodejs.org/) and re-run this command.`;

/**
 * Default git runner: synchronously execs `git <args>` and returns the
 * normalized `{ status, stdout, stderr, error }` shape. Extracted so the
 * preflight tests can inject a stub without spawning a real child process.
 *
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string,
 *             error?: NodeJS.ErrnoException }}
 */
function defaultGitRunner(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

/**
 * Probe Node version via the injected `nodeCheck` seam (defaults to
 * `checkNodeVersion`). Returns a check record.
 *
 * @param {() => { ok: boolean, version: string, required: string }} nodeCheck
 * @returns {{ name: string, ok: boolean, remedy?: string }}
 */
function checkNode(nodeCheck) {
  const result = nodeCheck();
  if (result.ok) return { name: 'Node version', ok: true };
  return { name: 'Node version', ok: false, remedy: NODE_REMEDY(result) };
}

/**
 * Probe `git --version` for availability on PATH.
 *
 * @param {(args: string[]) => { status: number|null, stdout: string,
 *   stderr: string, error?: NodeJS.ErrnoException }} gitRunner
 * @returns {{ name: string, ok: boolean, remedy?: string }}
 */
function checkGitAvailable(gitRunner) {
  const result = gitRunner(['--version']);
  if (result.error?.code === 'ENOENT') {
    return { name: 'Git installed', ok: false, remedy: GIT_INSTALL_HINT };
  }
  if (result.status !== 0) {
    const snippet = (result.stderr || '').trim().slice(0, 200);
    return {
      name: 'Git installed',
      ok: false,
      remedy: `git --version failed (exit ${result.status})${
        snippet ? `: ${snippet}` : ''
      }. ${GIT_INSTALL_HINT}`,
    };
  }
  return { name: 'Git installed', ok: true };
}

/**
 * Probe `git rev-parse --is-inside-work-tree` to confirm the command is
 * running inside a git work tree.
 *
 * @param {(args: string[]) => { status: number|null, stdout: string,
 *   stderr: string, error?: NodeJS.ErrnoException }} gitRunner
 * @returns {{ name: string, ok: boolean, remedy?: string }}
 */
function checkInsideWorkTree(gitRunner) {
  const result = gitRunner(['rev-parse', '--is-inside-work-tree']);
  if (result.status === 0 && result.stdout.trim() === 'true') {
    return { name: 'Local git initialized', ok: true };
  }
  return {
    name: 'Local git initialized',
    ok: false,
    remedy: GIT_WORKTREE_HINT,
  };
}

/**
 * Probe the `gh` CLI + auth via the injected `gh` seam (defaults to
 * `preflightGh`). Maps the typed errors `preflightGh` throws into a
 * single failing check carrying the error message as the remedy.
 *
 * @param {(opts?: object) => Promise<{ version: string }>} gh
 * @returns {Promise<{ name: string, ok: boolean, remedy?: string }>}
 */
async function checkGh(gh) {
  try {
    await gh();
    return { name: 'GitHub CLI', ok: true };
  } catch (err) {
    return { name: 'GitHub CLI', ok: false, remedy: err.message };
  }
}

/**
 * Run every prerequisite check and aggregate them into a single result.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipGithub=false] — when true, skip the `gh` CLI
 *   + auth check (the Node and git checks always run).
 * @param {boolean} [opts.requireWorkTree=true] — when true (the default,
 *   used by `bootstrap.js`), being outside a git work tree FAILS the gate.
 *   When false (`bootstrap-new.js`), the work-tree probe is informational:
 *   it never fails the gate and its result is reported via the returned
 *   `gitInitialized` flag so later steps can fill in the missing git state.
 * @param {boolean} [opts.checkProjectScope=false] — when true (and
 *   `skipGithub` is false), also verify the `gh` token carries the
 *   `project` scope needed to read/modify GitHub Projects V2.
 * @param {() => { ok: boolean, version: string, required: string }}
 *   [opts.nodeCheck] — Node-version seam (defaults to `checkNodeVersion`).
 * @param {(args: string[]) => object} [opts.gitRunner] — git runner seam
 *   (defaults to a real `spawnSync('git', …)`).
 * @param {(opts?: object) => Promise<{ version: string }>} [opts.gh] —
 *   `gh` preflight seam (defaults to `preflightGh`).
 * @param {() => Promise<{ name: string, ok: boolean, remedy?: string }>}
 *   [opts.projectScope] — project-scope seam (defaults to
 *   `checkProjectScopes`).
 * @returns {Promise<{ ok: boolean, gitInitialized: boolean,
 *   checks: Array<{ name: string, ok: boolean, remedy?: string }> }>}
 */
export async function runPreflight(opts = {}) {
  const skipGithub = Boolean(opts.skipGithub);
  const requireWorkTree = opts.requireWorkTree !== false;
  const checkProjectScope = Boolean(opts.checkProjectScope);
  const nodeCheck = opts.nodeCheck ?? checkNodeVersion;
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const gh = opts.gh ?? preflightGh;
  const projectScope = opts.projectScope ?? checkProjectScopes;

  const checks = [checkNode(nodeCheck)];

  const gitAvailable = checkGitAvailable(gitRunner);
  checks.push(gitAvailable);
  // The inside-work-tree probe only makes sense when git itself resolved;
  // if git is missing the rev-parse error is redundant noise.
  let gitInitialized = false;
  if (gitAvailable.ok) {
    const workTree = checkInsideWorkTree(gitRunner);
    gitInitialized = workTree.ok;
    if (requireWorkTree) {
      checks.push(workTree);
    } else {
      // Non-fatal detection: record whether we are inside a git repo but
      // never fail the gate on it — bootstrap initialises git in a later
      // phase. `ok` stays true so the gate passes; the rendered glyph is
      // driven off `gitInitialized` (✓ when a repo exists, ✗ when not) so the
      // operator sees the real state without the run aborting.
      checks.push({
        name: 'Local git initialized',
        ok: true,
        gitInitialized,
      });
    }
  }

  if (!skipGithub) {
    checks.push(await checkGh(gh));
    if (checkProjectScope) {
      checks.push(await projectScope());
    }
  }

  const ok = checks.every((c) => c.ok);
  return { ok, gitInitialized, checks };
}
