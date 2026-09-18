/** Close-validation `project.commands.*` resolution and formatter file policy. */

import { execFileSync } from 'node:child_process';
import { diffNameOnly } from '../changed-files.js';
import { getCommands } from '../config/commands.js';

/** The typecheck and lint gates are mandatory, so they carry their own fallbacks. */
const TYPECHECK_FALLBACK = 'npm run typecheck';

/**
 * Must stay byte-identical: `commandConfigHash` covers it, and drift would
 * invalidate every recorded lint evidence record.
 */
const LINT_FALLBACK = 'npm run lint';

export const FORMAT_CHECK_FALLBACK = 'npx biome format .';

const FORMAT_WRITE_FALLBACK = 'npx biome format --write .';

/** Derived from the write command so a Prettier repo is not told to run biome. */
export function buildFormatHint(writeCmd) {
  const cmd =
    writeCmd && writeCmd.trim().length > 0 ? writeCmd : FORMAT_WRITE_FALLBACK;
  return `Run \`${cmd}\` to auto-fix formatting drift.`;
}

/**
 * Falls back on a missing/empty value or malformed config.
 *
 * @param {{ project?: { commands?: object } } | null | undefined} config
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function resolveCommandWithFallback(config, key, fallback) {
  try {
    const cmds = getCommands(config);
    const value = cmds[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  } catch {
    // Malformed config — use the fallback.
  }
  return fallback;
}

/**
 * @param {{ project?: { commands?: object } } | null | undefined} config
 * @returns {string}
 */
export function resolveTypecheckCommand(config) {
  return resolveCommandWithFallback(config, 'typecheck', TYPECHECK_FALLBACK);
}

/**
 * A consumer may point this at its hooks' scoped lint; CI keeps whole-repo drift.
 *
 * @param {{ project?: { commands?: object } } | null | undefined} config
 * @returns {string}
 */
export function resolveLintCommand(config) {
  return resolveCommandWithFallback(config, 'lint', LINT_FALLBACK);
}

/**
 * @param {{ project?: { commands?: object } } | null | undefined} config
 * @returns {string}
 */
export function resolveFormatCheckCommand(config) {
  return resolveCommandWithFallback(
    config,
    'formatCheck',
    FORMAT_CHECK_FALLBACK,
  );
}

/**
 * @param {{ project?: { commands?: object } } | null | undefined} config
 * @returns {string}
 */
export function resolveFormatWriteCommand(config) {
  return resolveCommandWithFallback(
    config,
    'formatWrite',
    FORMAT_WRITE_FALLBACK,
  );
}

/**
 * Story-diff scope for the format gate: run against `.` inside
 * `.worktrees/story-*`, a consumer's `.worktrees` ignore glob excludes everything.
 *
 * @param {{ cwd: string, baseRef: string }} opts
 * @returns {string[]}
 */
export function listChangedFilesForFormatGate({ cwd, baseRef }) {
  if (!cwd) throw new Error('listChangedFilesForFormatGate: cwd is required');
  if (!baseRef)
    throw new Error('listChangedFilesForFormatGate: baseRef is required');
  const gitSpawn = (_cwd, ...args) => {
    try {
      const stdout = execFileSync('git', args, {
        cwd: _cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        status: err.status ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
      };
    }
  };
  return diffNameOnly({ baseRef, cwd, gitSpawn });
}

/**
 * What biome formats. Handing biome only ineligible paths exits 1 ("No files
 * were processed"). Only the default biome command gets a changed-file scope.
 */
const FORMATTER_ELIGIBLE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'css',
]);

/**
 * @param {string} filePath - Repo-relative.
 * @returns {boolean}
 */
export function isFormatterEligible(filePath) {
  if (typeof filePath !== 'string') return false;
  const lastSlash = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\'),
  );
  const base = filePath.slice(lastSlash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return FORMATTER_ELIGIBLE_EXTENSIONS.has(ext);
}
