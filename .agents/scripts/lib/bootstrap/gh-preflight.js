/** Provider-agnostic `gh` CLI and runtime-dependency preflight. */

import { spawnSync } from 'node:child_process';
import {
  GhAuthError,
  GhNotInstalledError,
  GhVersionError,
  MissingRuntimeDepsError,
} from '../errors/index.js';

/** Older releases miss flags the `gh` shim relies on; bumping is operator-visible. */
export const MIN_GH_VERSION = '2.40.0';

const GH_INSTALL_HINT =
  'Install gh: https://cli.github.com/ — then re-run this command.';
const GH_AUTH_HINT =
  'Run `gh auth login` (choose GitHub.com → HTTPS → login with a web browser), then re-run this command.';
const GH_PROJECT_SCOPE_NOTE =
  'token lacks the "project" scope — skipping GitHub Projects V2 board provisioning (matches the runtime `resolveProject` graceful path). To enable board provisioning, run `gh auth refresh -s project` (re-auth in the browser when prompted) and re-run this command.';
const GH_SCOPES_UNREADABLE_NOTE =
  'token scopes not reported by `gh auth status` (fine-grained PAT?) — skipping the classic project-scope assertion. If Projects V2 provisioning later fails, grant the Projects permission (fine-grained) or run `gh auth refresh -s project` (classic).';

/** `ajv` is the sentinel for installed framework runtime deps. */
const REQUIRED_RUNTIME_DEPS = Object.freeze(['ajv']);

const RUNTIME_DEPS_HINT =
  'Run `mandrel init` (for a fresh project) or `npm install mandrel` (for an existing one) to install the framework runtime dependencies, then re-run this command.';

/**
 * Raw `spawnSync`, not the `gh-exec` facade: these probes decide whether the
 * facade (which assumes an authenticated `gh`) is usable at all.
 *
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string,
 *             error?: NodeJS.ErrnoException }}
 */
function defaultGhRunner(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

/**
 * @param {string} stdout
 * @returns {string|null}
 */
export function parseGhVersion(stdout) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout || '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Missing or non-numeric segments compare as 0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const pa = String(a)
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Throws a typed `GhNotInstalledError`, `GhVersionError` or `GhAuthError`.
 *
 * @param {{ runner?: (args: string[]) => {
 *   status: number|null, stdout: string, stderr: string,
 *   error?: NodeJS.ErrnoException
 * } }} [opts]
 * @returns {Promise<{ version: string }>}
 */
export async function preflightGh(opts = {}) {
  const runner = opts.runner ?? defaultGhRunner;
  const version = resolveGhVersion(runner);
  assertGhVersionFloor(version);
  assertGhAuth(runner);
  return { version };
}

/**
 * Every "not installed correctly" shape throws {@link GhNotInstalledError}.
 *
 * @param {(args: string[]) => object} runner
 * @returns {string}
 */
function resolveGhVersion(runner) {
  const versionResult = runner(['--version']);
  if (versionResult.error?.code === 'ENOENT') {
    throw new GhNotInstalledError(
      `gh CLI not found on PATH. ${GH_INSTALL_HINT}`,
    );
  }
  if (versionResult.status !== 0) {
    const stderrSnippet = (versionResult.stderr || '').trim().slice(0, 200);
    throw new GhNotInstalledError(
      `gh --version failed (exit ${versionResult.status}): ${stderrSnippet}. ${GH_INSTALL_HINT}`,
    );
  }
  const version = parseGhVersion(versionResult.stdout);
  if (!version) {
    throw new GhNotInstalledError(
      `Could not parse gh version from output: ${(versionResult.stdout || '').slice(0, 200)}. ${GH_INSTALL_HINT}`,
    );
  }
  return version;
}

/**
 * @param {string} version
 */
function assertGhVersionFloor(version) {
  if (compareSemver(version, MIN_GH_VERSION) < 0) {
    throw new GhVersionError(
      `gh ${version} is older than required ${MIN_GH_VERSION}. Upgrade with your package manager (e.g. \`brew upgrade gh\`, \`winget upgrade GitHub.cli\`, or see https://cli.github.com/) and re-run this command.`,
      { found: version, required: MIN_GH_VERSION },
    );
  }
}

/**
 * @param {(args: string[]) => object} runner
 */
function assertGhAuth(runner) {
  const authResult = runner(['auth', 'status']);
  if (authResult.error?.code === 'ENOENT') {
    // PATH race after `--version` passed.
    throw new GhNotInstalledError(
      `gh CLI disappeared between version and auth check. ${GH_INSTALL_HINT}`,
    );
  }
  if (authResult.status !== 0) {
    throw new GhAuthError(
      `gh auth status failed: not logged in. ${GH_AUTH_HINT}`,
    );
  }
}

/**
 * Check the token's `project` scope (the `Token scopes:` line may be on
 * stdout or stderr). Never fails: an unreadable or `project`-less line passes
 * with a warning `detail`, matching `resolveProject`'s skip-the-board path.
 *
 * @param {{ runner?: (args: string[]) => {
 *   status: number|null, stdout: string, stderr: string,
 *   error?: NodeJS.ErrnoException
 * } }} [opts]
 * @returns {Promise<{ name: string, ok: boolean, remedy?: string,
 *   detail?: string }>}
 */
export async function checkProjectScopes(opts = {}) {
  const runner = opts.runner ?? defaultGhRunner;
  const result = runner(['auth', 'status']);
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  return classifyProjectScopes(/Token scopes:([^\n]*)/i.exec(text));
}

/**
 * @param {RegExpExecArray|null} scopeLine
 * @returns {{ name: string, ok: boolean, remedy?: string, detail?: string }}
 */
function classifyProjectScopes(scopeLine) {
  if (!scopeLine) {
    return {
      name: 'GitHub Projects V2 access',
      ok: true,
      detail: GH_SCOPES_UNREADABLE_NOTE,
    };
  }
  if (/\bproject\b/i.test(scopeLine[1])) {
    return { name: 'GitHub Projects V2 access', ok: true };
  }
  return {
    name: 'GitHub Projects V2 access',
    ok: true,
    detail: GH_PROJECT_SCOPE_NOTE,
  };
}

/**
 * Turn the opaque `ERR_MODULE_NOT_FOUND` of the later `config-resolver`
 * import into a {@link MissingRuntimeDepsError} naming the remedy.
 *
 * @param {{ resolver?: (specifier: string) => string | Promise<string> }} [opts]
 * @returns {Promise<void>}
 */
export async function preflightRuntimeDeps(opts = {}) {
  const resolver =
    opts.resolver ?? ((specifier) => import.meta.resolve(specifier));
  const missing = [];
  for (const specifier of REQUIRED_RUNTIME_DEPS) {
    try {
      await resolver(specifier);
    } catch {
      missing.push(specifier);
    }
  }
  if (missing.length > 0) {
    throw new MissingRuntimeDepsError(
      `Framework runtime dependencies missing from node_modules/: ${missing.join(', ')}. ${RUNTIME_DEPS_HINT}`,
      { missing },
    );
  }
}
