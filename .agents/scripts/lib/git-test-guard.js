/**
 * git-test-guard.js — refuses a branch- or ref-moving git command in the
 * checkout under test.
 *
 * `run-tests.js` sets `MANDREL_TEST_GUARD_ROOT` to the repository it tests.
 * A test that forgets its temp cwd would otherwise check out and fast-forward
 * that checkout mid-suite, swapping the source tree under parallel tests.
 * Production never sets the variable, so this is a no-op outside the suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnCapture } from './child-exec.js';

const TEST_GUARD_ROOT_ENV = 'MANDREL_TEST_GUARD_ROOT';

const MOVING = new Set([
  'checkout',
  'switch',
  'merge',
  'reset',
  'rebase',
  'pull',
  'stash',
  'worktree',
  'commit',
  'update-ref',
]);
const BRANCH_MOVING_FLAGS = new Set([
  '-f',
  '--force',
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
]);

/** First non-option argument, skipping `-c k=v` and `-C <dir>` pairs. */
function subcommandOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c' || args[i] === '-C') i += 1;
    else if (!String(args[i]).startsWith('-')) return { name: args[i], at: i };
  }
  return null;
}

function isMoving(args) {
  const sub = subcommandOf(args);
  if (!sub) return false;
  if (MOVING.has(sub.name)) return true;
  return (
    sub.name === 'branch' &&
    args.slice(sub.at + 1).some((a) => BRANCH_MOVING_FLAGS.has(a))
  );
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The toplevel of the repository `cwd` sits in, or null outside one. */
function toplevelOf(cwd) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  const res = spawnCapture('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    env,
  });
  return res.status === 0 ? realpathOr(res.stdout) : null;
}

/**
 * Arm a test child env with the checkout under test: an inherited root wins,
 * else the toplevel of the current directory.
 *
 * @param {NodeJS.ProcessEnv} env mutated in place
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv} `env`
 */
export function armGitGuard(env, baseEnv) {
  const root = baseEnv[TEST_GUARD_ROOT_ENV] ?? toplevelOf(process.cwd());
  if (root) env[TEST_GUARD_ROOT_ENV] = root;
  return env;
}

/**
 * Throw before a moving git command runs in the guarded checkout. A nested
 * fixture repository has its own toplevel, so it is never refused.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {void}
 */
export function assertGitAllowed(cwd, args, env = process.env) {
  const root = env[TEST_GUARD_ROOT_ENV];
  if (!root || !isMoving(args)) return;
  const dir = realpathOr(cwd ?? process.cwd());
  if (!fs.existsSync(dir) || toplevelOf(dir) !== realpathOr(root)) return;
  throw new Error(
    `git ${subcommandOf(args).name} refused in the checkout under test (${root}) — pass a temp cwd`,
  );
}
