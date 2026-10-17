/** Close-validation `project.commands.*` spawns and formatter file policy. */

import { execFileSync } from 'node:child_process';
import { diffNameOnly } from '../changed-files.js';
import {
  COMMANDS_DEFAULTS,
  resolveProjectCommand,
} from '../config/commands.js';

/** Derived from the write command so a Prettier repo is not told to run biome. */
export function buildFormatHint(writeCmd) {
  const cmd =
    writeCmd && writeCmd.trim().length > 0
      ? writeCmd
      : COMMANDS_DEFAULTS.formatWrite;
  return `Run \`${cmd}\` to auto-fix formatting drift.`;
}

/**
 * A disabled gate keeps the default argv as its (never-spawned) identity.
 *
 * @param {object | null | undefined} config
 * @param {keyof typeof COMMANDS_DEFAULTS} key
 */
export function resolveGateCommand(config, key) {
  const { raw, disabled, argv } = resolveProjectCommand(config, key);
  const [cmd, ...args] = disabled ? defaultArgv(key) : argv;
  return { cmd, args, raw, disabled };
}

/** @param {keyof typeof COMMANDS_DEFAULTS} key */
function defaultArgv(key) {
  return resolveProjectCommand(null, key).argv;
}

/**
 * The close `test` gate's command. Like every `project.commands.*` key it is a
 * single argv — the schema rejects `;`, `&&`, pipes and substitution.
 *
 * @param {{ project?: { commands?: object } } | null | undefined} config
 * @returns {string}
 */
export function resolveTestCommand(config) {
  return resolveProjectCommand(config, 'test').raw;
}

/** The one identity every `test` credit hashes. @param {object|null|undefined} config */
export function resolveTestGateArgv(config) {
  const { cmd, args } = resolveGateCommand(config, 'test');
  return { cmd, args };
}

/** @param {object|null|undefined} config */
export function resolveFormatWriteCommand(config) {
  return resolveProjectCommand(config, 'formatWrite').raw;
}

/** Only the default biome check gets a changed-file scope. */
export function isDefaultFormatCheck(formatCheckRaw) {
  return formatCheckRaw === COMMANDS_DEFAULTS.formatCheck;
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
