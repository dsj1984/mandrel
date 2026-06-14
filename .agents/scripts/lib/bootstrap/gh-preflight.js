/**
 * bootstrap/gh-preflight — `gh` CLI + runtime-dependency preflight
 *
 * Provider-agnostic preflight helpers extracted from
 * `agents-bootstrap-github.js` (Story #3349). Holds the version-comparison
 * arithmetic (`parseGhVersion` / `compareSemver`), the `gh` CLI probe
 * (`preflightGh`), and the runtime-dependency probe (`preflightRuntimeDeps`).
 * Keeping these free of any provider coupling lets the bootstrap orchestrator
 * stay focused on sequencing.
 */

import { spawnSync } from 'node:child_process';
import {
  GhAuthError,
  GhNotInstalledError,
  GhVersionError,
  MissingRuntimeDepsError,
} from '../errors/index.js';

/**
 * Minimum `gh` version the bootstrap supports. Set conservatively per
 * Tech Spec #1350 ("Risks & Mitigations → `gh` version skew"): older
 * releases miss flags the eventual `gh-exec` shim relies on. Bumping this
 * is a deliberate, operator-visible change — keep it tracked here.
 */
export const MIN_GH_VERSION = '2.40.0';

const GH_INSTALL_HINT =
  'Install gh: https://cli.github.com/ — then re-run this command.';
const GH_AUTH_HINT =
  'Run `gh auth login` (choose GitHub.com → HTTPS → login with a web browser), then re-run this command.';
const GH_PROJECT_SCOPE_NOTE =
  'token lacks the "project" scope — skipping GitHub Projects V2 board provisioning (matches the runtime `resolveProject` graceful path). To enable board provisioning, run `gh auth refresh -s project` (re-auth in the browser when prompted) and re-run this command.';
const GH_SCOPES_UNREADABLE_NOTE =
  'token scopes not reported by `gh auth status` (fine-grained PAT?) — skipping the classic project-scope assertion. If Projects V2 provisioning later fails, grant the Projects permission (fine-grained) or run `gh auth refresh -s project` (classic).';

/**
 * Framework runtime deps the consumer must have installed in
 * `node_modules/` before this script reaches the dynamic
 * `config-resolver` import. `ajv` is the sentinel — if it cannot
 * resolve, the framework runtime dependencies are not installed.
 */
const REQUIRED_RUNTIME_DEPS = Object.freeze(['ajv']);

const RUNTIME_DEPS_HINT =
  'Run `mandrel init` (for a fresh project) or `npm install mandrel` (for an existing one) to install the framework runtime dependencies, then re-run this command.';

/**
 * Default runner: synchronously execs `gh <args>` and returns
 * `{ status, stdout, stderr, error }`. Extracted so the preflight tests
 * can inject a stub without spawning a real child process. Forerunner of
 * the `lib/gh-exec.js` shim described in Tech Spec #1350; once that
 * lands, this helper deletes and the preflight calls `gh.exec(...)`.
 *
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string,
 *             error?: NodeJS.ErrnoException }}
 */
// Story #2990: this preflight runner intentionally stays on raw
// `spawnSync('gh', …)` (not the `lib/gh-exec.js` facade) because it
// runs *before* auth is resolved — `gh --version` and `gh auth status`
// are the very probes that decide whether the facade can be used at
// all. Routing through the provider layer would create a circular
// dependency: the facade assumes a working, authenticated `gh`.
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
 * Parse the first `MAJOR.MINOR.PATCH` triple out of `gh --version` stdout.
 * Returns `null` when the shape is unrecognized so callers can decide
 * whether to surface an error or proceed.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
export function parseGhVersion(stdout) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout || '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Numeric comparison of two `MAJOR.MINOR.PATCH` strings.
 * Returns negative if `a < b`, positive if `a > b`, zero if equal.
 * Missing segments are treated as `0`. Non-numeric segments compare as 0.
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
 * Preflight the `gh` CLI before any provider call. Three failure modes,
 * each surfaced as a typed error so callers (CLI `main`, future
 * orchestrators, tests) can `instanceof`-match without parsing strings:
 *
 *   - {@link GhNotInstalledError} — `gh` not on PATH (ENOENT) or the
 *     `--version` invocation reported a non-zero exit suggesting the
 *     binary is missing/broken.
 *   - {@link GhVersionError} — `gh` is present but older than
 *     {@link MIN_GH_VERSION}; carries `{ found, required }` for the
 *     CLI to render an upgrade hint.
 *   - {@link GhAuthError} — `gh auth status` exited non-zero, meaning
 *     no host is logged in.
 *
 * On success returns `{ version }` so the caller can log the resolved
 * version. The `runner` seam defaults to a real `spawnSync('gh', …)`;
 * tests inject a stub returning the canonical
 * `{ status, stdout, stderr, error }` shape.
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
 * Resolve the installed `gh` version via `gh --version`, throwing
 * {@link GhNotInstalledError} for every "not installed correctly" shape
 * (ENOENT, non-zero exit, unparseable output).
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
    // Non-ENOENT failure of `gh --version` is treated as "not installed
    // correctly" — same remediation, same exit semantics.
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
 * Enforce the {@link MIN_GH_VERSION} floor, throwing {@link GhVersionError}
 * with `{ found, required }` when the installed version is older.
 *
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
 * Assert `gh auth status` reports a logged-in host, throwing
 * {@link GhAuthError} (or {@link GhNotInstalledError} on a PATH race).
 *
 * @param {(args: string[]) => object} runner
 */
function assertGhAuth(runner) {
  const authResult = runner(['auth', 'status']);
  if (authResult.error?.code === 'ENOENT') {
    // Defensive — `gh --version` already passed, so ENOENT here would be a
    // PATH race. Treat the same as not-installed.
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
 * Check that the authenticated `gh` token carries the `project` scope, which
 * the bootstrap needs to read and modify GitHub Projects V2. Parses the
 * `Token scopes:` line from `gh auth status` (some gh versions print it to
 * stderr, others to stdout — we scan both) and looks for a `project` scope.
 *
 * Returns a check record `{ name, ok, remedy?, detail? }` rather than
 * throwing, so the preflight aggregator can surface it alongside the other
 * checks. An unreadable scopes line — the normal case for fine-grained PATs
 * and for `gh` builds that omit it — PASSES with a warning `detail` (Story
 * #3690). A present-but-`project`-less scopes line — the normal case for a
 * vanilla `gh auth login` token — also PASSES with a warning `detail`
 * (Story #3893, Finding A.5): the bootstrap's runtime `resolveProject`
 * already degrades to warn-and-skip-board for exactly this condition, so
 * failing the preflight closed was stricter than the code it guards and
 * created a guaranteed first-run → browser → re-run loop. The check never
 * fails the gate on the project scope; the warning `detail` carries the
 * `gh auth refresh -s project` remediation for operators who want boards.
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
 * Map a (possibly absent) `Token scopes:` match onto the check record.
 * Pure — exported only through {@link checkProjectScopes}.
 *
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
 * Preflight the framework's runtime dependencies before dynamic-importing
 * `config-resolver.js` (which transitively pulls in `ajv` via
 * `config-settings-schema.js`). A consumer who has not installed the
 * framework runtime deps will not have `ajv` available, and the raw
 * `ERR_MODULE_NOT_FOUND` from the dynamic import is opaque. This
 * preflight converts that into a {@link MissingRuntimeDepsError} that
 * names the missing packages and points the operator at the correct
 * remediation (`mandrel init` / `npm install mandrel`).
 *
 * The `resolver` seam lets tests inject a stub without touching the real
 * module graph; production uses `import.meta.resolve(specifier)`.
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
