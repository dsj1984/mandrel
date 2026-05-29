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

/**
 * Framework runtime deps the consumer must have installed in
 * `node_modules/` before this script reaches the dynamic
 * `config-resolver` import. `ajv` is the sentinel — if it cannot
 * resolve, the operator skipped `/agents-bootstrap-project` (or its
 * Step 2c/2d dependency-install never ran). The list mirrors the floor
 * in `agents-bootstrap-project.md` Step 2c; keep them in sync.
 */
const REQUIRED_RUNTIME_DEPS = Object.freeze(['ajv']);

const RUNTIME_DEPS_HINT =
  'Run `/agents-bootstrap-project` (or `node .agents/scripts/agents-bootstrap-project.js` when present) to merge the framework runtime dependencies into your package.json and install them, then re-run this command.';

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
  if (compareSemver(version, MIN_GH_VERSION) < 0) {
    throw new GhVersionError(
      `gh ${version} is older than required ${MIN_GH_VERSION}. Upgrade with your package manager (e.g. \`brew upgrade gh\`, \`winget upgrade GitHub.cli\`, or see https://cli.github.com/) and re-run this command.`,
      { found: version, required: MIN_GH_VERSION },
    );
  }

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

  return { version };
}

/**
 * Preflight the framework's runtime dependencies before dynamic-importing
 * `config-resolver.js` (which transitively pulls in `ajv` via
 * `config-settings-schema.js`). A fresh consumer who skipped
 * `/agents-bootstrap-project` will not have `ajv` installed, and the
 * raw `ERR_MODULE_NOT_FOUND` from the dynamic import is opaque. This
 * preflight converts that into a {@link MissingRuntimeDepsError} that
 * names the missing packages and points the operator at the right
 * workflow.
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
