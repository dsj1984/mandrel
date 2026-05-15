/**
 * Story #1651 (CWE-209): error-envelope redactor for CLI scripts.
 *
 * Rewrites absolute filesystem paths to repo-relative form, elides
 * `$HOME` / `$USERPROFILE` segments outside the repo, and scrubs
 * token-shaped substrings before error envelopes hit the public CI log.
 *
 * Pure and dependency-free so callers (tests, ad-hoc loggers, the
 * runAsCli default handler) can reuse it without standing up the rest
 * of the cli-utils harness.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_CACHE = { value: null };

/**
 * Resolve the repository root the redactor rewrites against. The
 * heuristic walks up from this file's directory; consumers may override
 * via the `repoRoot` option on `redactErrorMessage`. The result is
 * memoised because the redactor runs in the hot path of error-printing.
 *
 * @returns {string}
 */
export function resolveRepoRoot() {
  if (REPO_ROOT_CACHE.value) return REPO_ROOT_CACHE.value;
  // This file: .agents/scripts/lib/error-redactor.js → repo root is 3 up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  REPO_ROOT_CACHE.value = path.resolve(here, '..', '..', '..');
  return REPO_ROOT_CACHE.value;
}

const TOKEN_SHAPED = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|[A-Fa-f0-9]{32,})\b/g;

/**
 * Normalise both Windows-style and POSIX-style absolute paths in
 * `message` to repo-relative form, elide `$HOME` / `$USERPROFILE`
 * outside the repo, and scrub token-shaped substrings (`ghp_*`,
 * `gho_*`, `ghs_*`, `ghu_*`, `ghr_*`, 32+ hex chars).
 *
 * @param {string|undefined} message
 * @param {object} [options]
 * @param {string} [options.repoRoot]  Override the auto-resolved repo root.
 * @param {string} [options.home]      Override the home directory.
 * @returns {string}
 */
export function redactErrorMessage(message, options = {}) {
  if (typeof message !== 'string' || message.length === 0) {
    return message ?? '';
  }
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const home =
    options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? null;

  let out = message;

  for (const variant of pathVariants(repoRoot)) {
    out = out.split(`${variant}\\`).join('');
    out = out.split(`${variant}/`).join('');
    out = out.split(variant).join('<repo>');
  }

  if (home) {
    for (const variant of pathVariants(home)) {
      out = out.split(`${variant}\\`).join('~\\');
      out = out.split(`${variant}/`).join('~/');
      out = out.split(variant).join('~');
    }
  }

  return out.replace(TOKEN_SHAPED, '[REDACTED]');
}

function pathVariants(p) {
  if (!p) return [];
  const back = p.replace(/\//g, '\\');
  const forward = p.replace(/\\/g, '/');
  return back === forward ? [back] : [back, forward];
}

/**
 * Determine whether error-message redaction is enabled for this process.
 *
 * Precedence (any one is enough to opt in):
 *   1. Explicit `--quiet-errors` flag in `argv`.
 *   2. `AGENT_CLI_QUIET_ERRORS=1` (or `true`) in `env`.
 *   3. `CI=true` (or any other truthy non-empty value) in `env`.
 *
 * Operator workstations stay verbose by default; CI runs (where logs
 * are public on OSS forks) get redaction automatically.
 *
 * @param {string[]} [argv]      Defaults to `process.argv.slice(2)`.
 * @param {NodeJS.ProcessEnv} [env]  Defaults to `process.env`.
 * @returns {boolean}
 */
export function parseQuietErrorsFlag(argv, env) {
  const _argv = argv ?? process.argv.slice(2);
  const _env = env ?? process.env;
  if (_argv.includes('--quiet-errors')) return true;
  if (isTruthyEnv(_env.AGENT_CLI_QUIET_ERRORS)) return true;
  if (isTruthyEnv(_env.CI)) return true;
  return false;
}

function isTruthyEnv(value) {
  if (!value) return false;
  if (value === '0') return false;
  if (value.toLowerCase() === 'false') return false;
  return true;
}

/**
 * Format a thrown error for stderr, applying redaction when
 * `parseQuietErrorsFlag()` says we should. Extracted from `runAsCli` so
 * the cli-utils default error handler stays a single expression and the
 * redaction logic lives next to the redactor itself.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function formatCliError(err) {
  const body = err?.stack ?? err?.message ?? err;
  return parseQuietErrorsFlag() ? redactErrorMessage(body) : body;
}
