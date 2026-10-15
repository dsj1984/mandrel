/**
 * Classified `gh auth token` results and their refusal text. A failure is
 * never collapsed to "no token": only a confirmed not-logged-in result
 * carries the `gh auth login` remedy, and a sandbox/network fault says
 * credentials were not assessed. No diagnostic here ever carries a token.
 */

import {
  isTransportFailure,
  sandboxDenialCode,
  TRANSPORT_REMEDY,
} from '../../lib/gh-transport.js';

/**
 * Set beside a memoised `GITHUB_TOKEN` so this process and its children can
 * tell a token copied out of the `gh` store from one an operator exported.
 */
export const TOKEN_SOURCE_ENV = 'MANDREL_GH_TOKEN_SOURCE';

const TOKEN_SHAPE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g;

/**
 * Masks anything token-shaped so `gh` stderr can ride a diagnostic.
 *
 * @param {unknown} text
 * @returns {string}
 */
function redactTokens(text) {
  return String(text ?? '').replace(TOKEN_SHAPE, '[redacted]');
}

/**
 * Last non-empty stderr line (or the message), redacted.
 *
 * @param {any} err
 * @returns {string}
 */
export function failureDetail(err) {
  const lines = String(err?.stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return redactTokens(lines.at(-1) ?? err?.message ?? 'unknown error');
}

const NOT_INSTALLED_RE = /command not found|: not found|is not recognized/i;
const NOT_LOGGED_IN_RE =
  /not logged in|no oauth token|gh auth login|http 401|bad credentials|authentication required/i;

function isNotInstalled(err) {
  return (
    err?.code === 'ENOENT' ||
    err?.status === 127 ||
    NOT_INSTALLED_RE.test(`${err?.stderr ?? ''}\n${err?.message ?? ''}`)
  );
}

function isTimeoutOrDenied(err) {
  return (
    err?.code === 'ETIMEDOUT' ||
    err?.signal === 'SIGTERM' ||
    sandboxDenialCode(err) !== null
  );
}

/**
 * @param {any} err  the `execSync` failure
 * @returns {'not-installed'|'transport'|'auth-rejected'|'unknown'}
 */
function classifyGhTokenFailure(err) {
  if (isNotInstalled(err)) return 'not-installed';
  if (isTimeoutOrDenied(err) || isTransportFailure(err)) return 'transport';
  if (NOT_LOGGED_IN_RE.test(`${err?.stderr ?? ''}\n${err?.message ?? ''}`)) {
    return 'auth-rejected';
  }
  return 'unknown';
}

/**
 * @typedef {{ token: string|null,
 *   verdict: 'ok'|'not-installed'|'transport'|'auth-rejected'|'unknown',
 *   detail: string|null }} GhTokenResult
 */

/**
 * Runs `gh auth token` through `execImpl` and classifies the outcome.
 *
 * @param {Function} execImpl  `execSync`-shaped
 * @returns {GhTokenResult}
 */
export function runGhAuthToken(execImpl) {
  try {
    const out = execImpl('gh auth token', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const token = String(out ?? '').trim();
    if (token) return { token, verdict: 'ok', detail: null };
    return {
      token: null,
      verdict: 'auth-rejected',
      detail: 'gh auth token printed no token',
    };
  } catch (err) {
    return {
      token: null,
      verdict: classifyGhTokenFailure(err),
      detail: failureDetail(err),
    };
  }
}

function configDirNote() {
  const dir = process.env.GH_CONFIG_DIR;
  return dir ? ` (GH_CONFIG_DIR=${dir})` : '';
}

const FAILURE_LINES = {
  'not-installed': () => [
    '[GitHubProvider] Authentication Failed: the GitHub CLI (`gh`) is not installed or not on PATH.',
    '',
    'Install `gh`, or set the GITHUB_TOKEN or GH_TOKEN environment variable.',
  ],
  transport: () => [
    `[GitHubProvider] GitHub CLI unreachable: \`gh auth token\` could not run${configDirNote()} — a sandbox or network fault, not an authentication failure.`,
    '',
    `Remedy: ${TRANSPORT_REMEDY}.`,
  ],
  unknown: () => [
    `[GitHubProvider] \`gh auth token\` failed for an unrecognised reason${configDirNote()}; credentials were not confirmed missing.`,
    '',
    'Run `gh auth status` to see what gh reports, or set GITHUB_TOKEN / GH_TOKEN.',
  ],
  'auth-rejected': () => [
    `[GitHubProvider] Authentication Failed: No GitHub token found${configDirNote()}.`,
    '',
    'To resolve this, choose one of the following:',
    '  A. (CI/CD / Agent Script) Set the GITHUB_TOKEN or GH_TOKEN environment variable.',
    '  B. (Local) Run `gh auth login` to authenticate the GitHub CLI.',
  ],
};

/**
 * The refusal text for a failed `gh auth token`, by verdict.
 *
 * @param {{ verdict: string, detail: string|null }} result
 * @returns {string}
 */
export function describeTokenFailure({ verdict, detail }) {
  const lines = (FAILURE_LINES[verdict] ?? FAILURE_LINES['auth-rejected'])();
  if (detail) lines.push(`gh said: ${detail}`);
  lines.push('', 'See .agents/README.md#github-authentication for details.');
  return lines.join('\n');
}

/**
 * Where this process's GitHub identity comes from: `env` for an operator- or
 * CI-exported token, `gh-cli` for the `gh` credential store (including a
 * token memoised out of it).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'env'|'gh-cli'}
 */
export function resolveTokenSource(env = process.env) {
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) return 'gh-cli';
  if (env[TOKEN_SOURCE_ENV] === 'gh-cli' && !env.GH_TOKEN) return 'gh-cli';
  return 'env';
}
