/**
 * close-validation/commands.js — Command resolution + formatter file policy.
 *
 * Owns the `project.commands.*` resolution helpers used by the close-
 * validation gates (typecheck / formatCheck / formatWrite), the Story-diff
 * changed-file listing for the format gate, and the formatter
 * file-eligibility policy (Story #3410).
 */

import { execFileSync } from 'node:child_process';
import { diffNameOnly } from '../changed-files.js';
import { getCommands } from '../config/commands.js';

/**
 * Fallback typecheck command — the gate is mandatory by design (Epic-branch
 * type regressions surface in the next Story's pre-push otherwise).
 */
const TYPECHECK_FALLBACK = 'npm run typecheck';

/** Default formatter command when `project.commands.formatCheck` is unset. */
export const FORMAT_CHECK_FALLBACK = 'npx biome format .';

/** Default formatter command in write mode. */
const FORMAT_WRITE_FALLBACK = 'npx biome format --write .';

/**
 * Build the format-gate hint dynamically from the resolved write command so
 * a Prettier-only repo gets `prettier --write` in its hint, not biome.
 */
export function buildFormatHint(writeCmd) {
  const cmd =
    writeCmd && writeCmd.trim().length > 0 ? writeCmd : FORMAT_WRITE_FALLBACK;
  return `Run \`${cmd}\` to auto-fix formatting drift.`;
}

/**
 * Resolve a string `project.commands.<key>` with a fallback when the
 * value is missing, empty, or the resolver throws on malformed config.
 * Shared engine behind the three resolveX command helpers.
 *
 * @param {{ project?: { commands?: object } } | null | undefined} config
 *   Canonical resolved config (or a bare `{ project: { commands } }` bag).
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function resolveCommandWithFallback(config, key, fallback) {
  try {
    // `getCommands` reads `config.project.commands` from the canonical
    // resolved config.
    const cmds = getCommands(config);
    const value = cmds[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  } catch {
    // Malformed config — fall through to the framework default.
  }
  return fallback;
}

/**
 * Resolve the typecheck command. Reads `project.commands.typecheck`;
 * falls back to `npm run typecheck`. The framework-wide
 * `COMMANDS_DEFAULTS.typecheck` is `null` but this gate is mandatory, so
 * we apply the fallback here. Exported for testing.
 *
 * @param {{ project?: { commands?: object } } | null | undefined} config
 * @returns {string}
 */
export function resolveTypecheckCommand(config) {
  return resolveCommandWithFallback(config, 'typecheck', TYPECHECK_FALLBACK);
}

/**
 * Resolve the format-check command. Reads `project.commands.formatCheck`;
 * falls back to `npx biome format .` so existing repos keep working byte-
 * for-byte. Exported for testing.
 *
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
 * Resolve the format-write command used by story-close format-autofix (and
 * surfaced in the format-gate hint). Reads `project.commands.formatWrite`;
 * falls back to `npx biome format --write .`. Exported for testing.
 *
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
 * Compute the Story-diff file scope for formatter gates. The default Biome
 * formatter used to run against `.` from inside `.worktrees/story-*`, which
 * lets consumer ignore globs that exclude `.worktrees` self-exclude the whole
 * run. Scoping to changed paths keeps verification real without depending on
 * how consumers spell root ignore patterns.
 *
 * @param {{ cwd: string, baseRef: string }} opts
 * @returns {string[]}
 */
export function listChangedFilesForFormatGate({ cwd, baseRef }) {
  if (!cwd) throw new Error('listChangedFilesForFormatGate: cwd is required');
  if (!baseRef)
    throw new Error('listChangedFilesForFormatGate: baseRef is required');
  // Bridge execFileSync into the gitSpawn(cwd, ...args) contract so
  // diffNameOnly owns the stdout → path-list conversion.
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
 * File extensions Biome's formatter can process. Used to filter the
 * changed-file scope down to the formatter-eligible subset (Story #3410):
 * passing only ineligible paths (e.g. a docs-only Story whose diff is all
 * markdown) makes `biome format <files>` report "No files were processed"
 * and exit 1, failing the gate for a Story that has nothing to format.
 *
 * The set mirrors Biome's handled languages (JS/TS family + JSON + CSS).
 * Markdown, YAML, and other unhandled types are intentionally absent — the
 * default formatter is biome, so the scope is keyed to what biome formats.
 * Consumers who swap the formatter via `project.commands.formatCheck`
 * do not get `changedFileScope` at all (see `buildDefaultGates`), so this
 * filter only ever runs against the default biome command.
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
 * Whether a changed path is eligible for the default (biome) formatter,
 * decided purely by file extension. Pure function — no I/O. Exported for
 * unit coverage (Story #3410).
 *
 * @param {string} filePath - A repo-relative path (forward-slash normalized).
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
  // No extension (dotfile-only or extensionless) → not formatter-eligible.
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return FORMATTER_ELIGIBLE_EXTENSIONS.has(ext);
}
