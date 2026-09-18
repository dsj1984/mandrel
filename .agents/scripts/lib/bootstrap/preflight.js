/**
 * Fail-before-mutate prerequisite gate run before any bootstrap mutation.
 * Every failing check carries a `remedy`.
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
 * @param {() => { ok: boolean, version: string, required: string }} nodeCheck
 * @returns {{ name: string, ok: boolean, remedy?: string }}
 */
function checkNode(nodeCheck) {
  const result = nodeCheck();
  if (result.ok) return { name: 'Node version', ok: true };
  return { name: 'Node version', ok: false, remedy: NODE_REMEDY(result) };
}

/**
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
 * @param {object} [opts]
 * @param {boolean} [opts.skipGithub=false]
 * @param {boolean} [opts.requireWorkTree=true] — false makes the work-tree
 *   probe informational (reported via `gitInitialized`); git is initialised later.
 * @param {boolean} [opts.checkProjectScope=false]
 * @param {() => { ok: boolean, version: string, required: string }}
 *   [opts.nodeCheck]
 * @param {(args: string[]) => object} [opts.gitRunner]
 * @param {(opts?: object) => Promise<{ version: string }>} [opts.gh]
 * @param {() => Promise<{ name: string, ok: boolean, remedy?: string }>}
 *   [opts.projectScope]
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
  // Without git, the work-tree probe is redundant noise.
  let gitInitialized = false;
  if (gitAvailable.ok) {
    const workTree = checkInsideWorkTree(gitRunner);
    gitInitialized = workTree.ok;
    if (requireWorkTree) {
      checks.push(workTree);
    } else {
      // `ok` stays true; the rendered glyph reads `gitInitialized`.
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
