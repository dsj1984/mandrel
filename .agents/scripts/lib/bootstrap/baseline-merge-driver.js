/**
 * Register the `baselines/*.json` merge driver. The `.gitattributes` line is
 * tracked; the `git config` driver command is per clone, so a fresh clone
 * silently falls back to text merge — hence the doctor check. Owning both
 * halves here keeps installer and doctor agreeing on the command.
 *
 * @module lib/bootstrap/baseline-merge-driver
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnCapture } from '../child-exec.js';

const BASELINE_MERGE_DRIVER_NAME = 'mandrel-baseline';

const BASELINE_MERGE_ATTRIBUTE = `baselines/*.json merge=${BASELINE_MERGE_DRIVER_NAME}`;

export const BASELINE_MERGE_DRIVER_CONFIG_KEY = `merge.${BASELINE_MERGE_DRIVER_NAME}.driver`;

/** Relative: git runs the driver from the worktree root, in every worktree. */
const DRIVER_SCRIPT = '.agents/scripts/merge-baseline.js';

/** In the order the driver's argv expects. */
const DRIVER_PLACEHOLDERS = '%O %A %B %P';

/**
 * The node path is absolute and quoted: git's shell may lack the nvm/volta
 * `PATH` shim (GUI clients, launchd), and a driver that cannot start just
 * leaves the file conflicted. Quoting covers paths with spaces.
 *
 * @param {string} [execPath] Absolute path to the node binary.
 * @returns {string}
 */
function buildBaselineMergeDriverCommand(execPath = process.execPath) {
  return `"${execPath}" ${DRIVER_SCRIPT} ${DRIVER_PLACEHOLDERS}`;
}

const BASELINE_MERGE_DRIVER_COMMAND = buildBaselineMergeDriverCommand();

/** Single-quoted: the command carries double quotes around the node path. */
export const BASELINE_MERGE_DRIVER_REMEDY = `git config ${BASELINE_MERGE_DRIVER_CONFIG_KEY} '${BASELINE_MERGE_DRIVER_COMMAND}'`;

/**
 * Split a driver command into file + argv, dropping git placeholders, so the
 * doctor can actually run it (an nvm bump leaves a set-but-broken key).
 * Tokenised rather than shelled: executing per-clone config through a shell
 * would be arbitrary command execution. Only double quotes are honoured.
 *
 * @param {string|null|undefined} command
 * @returns {{ file: string, args: string[] }|null} null when there is no
 *   runnable first token.
 */
export function parseBaselineMergeDriverCommand(command) {
  const tokens = String(command ?? '').match(/"[^"]*"|\S+/g) ?? [];
  const cleaned = tokens
    .map((token) =>
      token.startsWith('"') && token.endsWith('"') && token.length >= 2
        ? token.slice(1, -1)
        : token,
    )
    .filter((token) => token.length > 0 && !/^%[A-Za-z]$/.test(token));
  if (cleaned.length === 0) return null;
  const [file, ...args] = cleaned;
  return { file, args };
}

/**
 * Comment lines do not count.
 *
 * @param {string|null|undefined} gitattributes
 * @returns {boolean}
 */
function declaresBaselineMergeDriver(gitattributes) {
  return String(gitattributes ?? '')
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return false;
      return trimmed.includes(`merge=${BASELINE_MERGE_DRIVER_NAME}`);
    });
}

/**
 * Is the driver declared by the project and registered in this clone? Not
 * declared (or unreadable `.gitattributes`) means the project never opted in
 * and callers stay silent; declared with an empty command is the silent
 * text-merge fallback callers must flag.
 *
 * @param {{
 *   projectRoot: string,
 *   fsImpl?: typeof fs,
 *   runGit: (args: string[]) => { status?: number|null, stdout?: unknown },
 * }} ctx
 * @returns {{ declared: boolean, command: string }}
 */
export function probeBaselineMergeDriver({ projectRoot, fsImpl = fs, runGit }) {
  let attributes = '';
  try {
    attributes = fsImpl.readFileSync(
      path.join(projectRoot, '.gitattributes'),
      'utf8',
    );
  } catch {
    attributes = '';
  }
  if (!declaresBaselineMergeDriver(attributes)) {
    return { declared: false, command: '' };
  }
  const configured = runGit([
    'config',
    '--get',
    BASELINE_MERGE_DRIVER_CONFIG_KEY,
  ]);
  const command =
    configured?.status === 0 ? String(configured.stdout ?? '').trim() : '';
  return { declared: true, command };
}

/**
 * Add the attribute line, preserving every existing line verbatim.
 *
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {{ action: 'created'|'appended'|'already-present', path: string }}
 */
function ensureGitattributesLine(projectRoot, fsImpl = fs) {
  const target = path.join(projectRoot, '.gitattributes');
  if (!fsImpl.existsSync(target)) {
    fsImpl.writeFileSync(target, `${BASELINE_MERGE_ATTRIBUTE}\n`, 'utf8');
    return { action: 'created', path: target };
  }
  const existing = fsImpl.readFileSync(target, 'utf8');
  if (declaresBaselineMergeDriver(existing)) {
    return { action: 'already-present', path: target };
  }
  // A file not ending in a newline would otherwise glue our line onto the
  // last existing one, silently rewriting it.
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fsImpl.writeFileSync(
    target,
    `${existing}${separator}${BASELINE_MERGE_ATTRIBUTE}\n`,
    'utf8',
  );
  return { action: 'appended', path: target };
}

/**
 * @param {string} projectRoot
 * @param {typeof spawnCapture} [spawnImpl]
 * @returns {{ action: 'set'|'already-present'|'not-a-repo'|'failed' }}
 */
function ensureDriverGitConfig(projectRoot, spawnImpl = spawnCapture) {
  const opts = {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
    shell: false,
  };
  const inRepo = spawnImpl('git', ['rev-parse', '--git-dir'], opts);
  if ((inRepo?.status ?? 1) !== 0) return { action: 'not-a-repo' };

  const current = spawnImpl(
    'git',
    ['config', '--local', '--get', BASELINE_MERGE_DRIVER_CONFIG_KEY],
    opts,
  );
  if (
    (current?.status ?? 1) === 0 &&
    String(current.stdout ?? '').trim() === BASELINE_MERGE_DRIVER_COMMAND
  ) {
    return { action: 'already-present' };
  }

  const set = spawnImpl(
    'git',
    [
      'config',
      '--local',
      BASELINE_MERGE_DRIVER_CONFIG_KEY,
      BASELINE_MERGE_DRIVER_COMMAND,
    ],
    opts,
  );
  spawnImpl(
    'git',
    [
      'config',
      '--local',
      `merge.${BASELINE_MERGE_DRIVER_NAME}.name`,
      'mandrel baseline merge by row identity',
    ],
    opts,
  );
  return { action: (set?.status ?? 1) === 0 ? 'set' : 'failed' };
}

/**
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {{ action: 'already-present'|'absent', path: string }}
 */
function probeGitattributesLine(projectRoot, fsImpl) {
  const target = path.join(projectRoot, '.gitattributes');
  let existing = '';
  try {
    existing = fsImpl.readFileSync(target, 'utf8');
  } catch {
    existing = '';
  }
  return {
    action: declaresBaselineMergeDriver(existing)
      ? 'already-present'
      : 'absent',
    path: target,
  };
}

/**
 * Idempotent install. Full mode (init/prepare) writes the attribute and the
 * config key. `configOnly` (consumer `sync`) writes only the per-clone key,
 * and only when the project already declares the attribute — `sync` is not
 * an opt-in to the quality surface.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {boolean} [ctx.configOnly]
 * @param {typeof spawnCapture} [ctx.spawnImpl]
 * @param {typeof fs} [ctx.fsImpl]
 * @returns {{
 *   action: 'already-present'|'updated'|'skipped',
 *   attributes: string,
 *   config: string,
 *   path: string,
 *   line: string,
 *   command: string,
 * }}
 */
export function ensureBaselineMergeDriver(ctx) {
  const fsImpl = ctx.fsImpl ?? fs;
  const attributes = ctx.configOnly
    ? probeGitattributesLine(ctx.projectRoot, fsImpl)
    : ensureGitattributesLine(ctx.projectRoot, fsImpl);
  const base = {
    attributes: attributes.action,
    path: attributes.path,
    line: BASELINE_MERGE_ATTRIBUTE,
    command: BASELINE_MERGE_DRIVER_COMMAND,
  };
  if (attributes.action === 'absent') {
    return { ...base, action: 'skipped', config: 'skipped' };
  }
  const config = ensureDriverGitConfig(ctx.projectRoot, ctx.spawnImpl);
  const settled =
    attributes.action === 'already-present' &&
    (config.action === 'already-present' || config.action === 'not-a-repo');
  return {
    ...base,
    action: settled ? 'already-present' : 'updated',
    config: config.action,
  };
}
