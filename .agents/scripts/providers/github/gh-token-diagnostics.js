/** Classified `gh auth token` results; only a confirmed not-logged-in result says `gh auth login`. */

import {
  isTransportFailure,
  sandboxDenialCode,
  TRANSPORT_REMEDY,
} from '../../lib/gh-transport.js';

/** Marks a memoised `GITHUB_TOKEN` as copied out of the `gh` store. */
export const TOKEN_SOURCE_ENV = 'MANDREL_GH_TOKEN_SOURCE';

const TOKEN_SHAPE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g;

function redactTokens(text) {
  return String(text ?? '').replace(TOKEN_SHAPE, '[redacted]');
}

/** Last stderr line (or the message), redacted. */
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

/** @returns {GhTokenResult} */
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

export function describeTokenFailure({ verdict, detail }) {
  const lines = (FAILURE_LINES[verdict] ?? FAILURE_LINES['auth-rejected'])();
  if (detail) lines.push(`gh said: ${detail}`);
  lines.push('', 'See .agents/README.md#github-authentication for details.');
  return lines.join('\n');
}

/** `env` for an exported token, `gh-cli` for the gh store (or a token memoised from it). */
export function resolveTokenSource(env = process.env) {
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) return 'gh-cli';
  if (env[TOKEN_SOURCE_ENV] === 'gh-cli' && !env.GH_TOKEN) return 'gh-cli';
  return 'env';
}
