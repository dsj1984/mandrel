/**
 * format-autofix.js — self-healing biome-format step for story-close, plus
 * the git plumbing it shares with `baseline-upward-writeback.js`.
 *
 * The pre-merge format gate is check-only, and drift in files lint-staged
 * doesn't glob (JSON/YAML) would otherwise fail the next close; this step
 * formats the changed files and commits the result instead.
 */

import { execFileSync } from 'node:child_process';

import { diffNameOnly } from '../../changed-files.js';
import { resolveFormatWriteCommand } from '../../close-validation/commands.js';
import { Logger as DefaultLogger } from '../../Logger.js';

const SCOPED_TAG = '[format-autofix-scoped]';

/**
 * Paths from `git status --porcelain`. Lines are `XY <path>` and the status
 * pair's leading space is significant, so slice 3 chars rather than trim.
 *
 * @param {string} cwd
 * @param {(args: string[], opts: object) => string} git
 * @returns {string[]}
 */
export function listDirtyPaths(cwd, git) {
  const out = git(['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
    .split('\n')
    .filter((line) => line.length >= 4)
    .map((line) => line.slice(3));
}

/**
 * Split the configured format-write command into executable + argv, dropping
 * a trailing whole-tree `.` so a file list can be appended.
 *
 * @param {{ commands?: object }} [opts]
 * @returns {{ writeCmdString: string, writeCmd: string, writeArgs: string[] }}
 */
function resolveFormatterCmd({ commands } = {}) {
  const writeCmdString = resolveFormatWriteCommand({ project: { commands } });
  const parts = writeCmdString.split(/\s+/).filter(Boolean);
  if (parts[parts.length - 1] === '.') parts.pop();
  const [writeCmd, ...writeArgs] = parts;
  return { writeCmdString, writeCmd, writeArgs };
}

/**
 * Checked-out branch at `cwd`, or `null` on failure or detached HEAD. Guards
 * commits against landing on the wrong branch.
 *
 * @param {string} cwd
 * @param {(args: string[], opts: object) => string} git
 * @returns {string|null}
 */
export function currentBranch(cwd, git) {
  try {
    const out = git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const branch = (out ?? '').toString().trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * `git add -u` + commit with hooks enabled (never `--no-verify`).
 *
 * @param {{
 *   cwd: string,
 *   git: (args: string[], opts: object) => string,
 *   subject: string,
 * }} opts
 * @returns {string} short HEAD SHA of the new commit
 */
export function commitDirtyPaths({ cwd, git, subject }) {
  git(['add', '-u'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['commit', '-m', subject], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return git(['rev-parse', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Files changed in `baseBranch...storyBranch`, bridging the local
 * `(args, opts)` git interface to the `gitSpawn` shape `diffNameOnly` takes.
 *
 * @param {{ cwd: string, baseBranch: string, storyBranch: string, git: Function }} opts
 * @returns {string[]}
 */
export function listChangedFiles({ cwd, baseBranch, storyBranch, git }) {
  const gitSpawn = (_cwd, ...args) => {
    try {
      const stdout = git(args, {
        cwd: _cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { status: 0, stdout: stdout ?? '', stderr: '' };
    } catch (err) {
      return {
        status: err.status ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
      };
    }
  };
  return diffNameOnly({
    range: `${baseBranch}...${storyBranch}`,
    cwd,
    gitSpawn,
  });
}

/**
 * Format the branch's changed files and fold any drift into one
 * `fix(story-close):` commit, logged at warn so it is visible in the close
 * transcript. Everything runs in `worktreePath` (default `cwd`), and the
 * commit is refused unless that tree is on `storyBranch` — otherwise a
 * mis-wired cwd could commit onto `main`. Refuses to absorb a dirty tree.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath?: string,
 *   storyId: number|string,
 *   baseBranch: string,
 *   storyBranch: string,
 *   config?: object,
 *   logger?: object,
 *   spawnSync?: typeof execFileSync,
 *   gitSync?: (args: string[], opts: object) => string,
 * }} opts
 * @returns {{
 *   ran: boolean,
 *   committed: boolean,
 *   sha?: string,
 *   modifiedPaths?: string[],
 *   reason?: string,
 * }}
 */
export function runScopedFormatAutofix({
  cwd,
  worktreePath,
  storyId,
  baseBranch,
  storyBranch,
  config,
  logger = DefaultLogger,
  spawnSync = execFileSync,
  gitSync,
} = {}) {
  if (!cwd) throw new Error('runScopedFormatAutofix: cwd is required');
  if (!baseBranch)
    throw new Error('runScopedFormatAutofix: baseBranch is required');
  if (!storyBranch)
    throw new Error('runScopedFormatAutofix: storyBranch is required');

  const workTree = worktreePath || cwd;

  const git = gitSync ?? ((args, opts) => spawnSync('git', args, opts));

  const { writeCmdString, writeCmd, writeArgs } = resolveFormatterCmd({
    commands: config?.project?.commands,
  });

  const changed = listChangedFiles({
    cwd: workTree,
    baseBranch,
    storyBranch,
    git,
  });
  if (changed.length === 0) {
    logger.info?.(
      `${SCOPED_TAG} skipped — no changed files between ${baseBranch} and ${storyBranch}.`,
    );
    return { ran: false, committed: false, reason: 'no-changed-files' };
  }

  const dirtyBefore = listDirtyPaths(workTree, git);
  if (dirtyBefore.length) {
    logger.info?.(
      `${SCOPED_TAG} skipped — working tree dirty before scoped autofix (${dirtyBefore.length} paths).`,
    );
    return { ran: false, committed: false, reason: 'dirty-tree' };
  }

  // A non-zero exit is tolerated: the downstream check gate is authoritative.
  try {
    spawnSync(writeCmd, [...writeArgs, ...changed], {
      cwd: workTree,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    logger.warn?.(
      `${SCOPED_TAG} \`${writeCmdString}\` on ${changed.length} changed file(s) exited non-zero (${err?.status ?? 'unknown'}); falling through to the format check gate.`,
    );
  }

  const dirtyAfter = listDirtyPaths(workTree, git);
  if (!dirtyAfter.length) {
    logger.info?.(
      `${SCOPED_TAG} no format drift on ${changed.length} changed file(s).`,
    );
    return { ran: true, committed: false };
  }

  const onBranch = currentBranch(workTree, git);
  if (onBranch !== storyBranch) {
    logger.warn?.(
      `${SCOPED_TAG} refusing to commit — worktree ${workTree} is on "${onBranch ?? 'unknown'}", expected "${storyBranch}". ` +
        `${dirtyAfter.length} format-drift path(s) left for the check gate.`,
    );
    return { ran: true, committed: false, reason: 'wrong-branch' };
  }

  const subject = `fix(story-close): auto-apply biome format in scoped lint (story #${storyId})`;
  const sha = commitDirtyPaths({ cwd: workTree, git, subject });

  logger.warn?.(
    `${SCOPED_TAG} auto-applied biome format to ${dirtyAfter.length} path(s) on story #${storyId}: ${dirtyAfter.join(', ')}; committed as ${sha}.`,
  );
  return { ran: true, committed: true, sha, modifiedPaths: dirtyAfter };
}
