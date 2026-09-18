/**
 * Error-envelope redactor (CWE-209): repo-relative paths, elided home dir,
 * scrubbed token-shaped strings. Dependency-free.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_CACHE = { value: null };

/**
 * Memoised — the redactor runs on the error-printing hot path.
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
 * Handles both Windows and POSIX path separators.
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
 * On with `--quiet-errors`, `AGENT_CLI_QUIET_ERRORS`, or a truthy `CI` —
 * CI logs are public on OSS forks; workstations stay verbose.
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
 * @param {unknown} err
 * @returns {string}
 */
export function formatCliError(err) {
  const body = err?.stack ?? err?.message ?? err;
  return parseQuietErrorsFlag() ? redactErrorMessage(body) : body;
}
