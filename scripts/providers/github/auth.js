/**
 * GitHub Provider — token resolution.
 *
 * Hierarchy: GITHUB_TOKEN / GH_TOKEN env → `gh auth token` CLI fallback
 * → throws with an instructive error. `execSync` is indirected through a
 * holder so tests can swap it.
 *
 * Extracted from `../github.js` in Story #1846 / Task #1855 — see that
 * Story for the broader split rationale.
 */

import { execSync as defaultExecSync } from 'node:child_process';

export const execSyncHolder = { impl: defaultExecSync };

export function __setExecSyncForTests(fn) {
  execSyncHolder.impl = fn ?? defaultExecSync;
}

/* node:coverage ignore next */
export function readGhCliToken() {
  try {
    const t = execSyncHolder
      .impl('gh auth token', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      .trim();
    return t || null;
  } catch {
    // gh CLI not installed or not authenticated.
    return null;
  }
}

const TOKEN_MISSING_ERROR = [
  '[GitHubProvider] Authentication Failed: No GitHub token found.',
  '',
  'To resolve this, choose one of the following:',
  '  A. (CI/CD / Agent Script) Set the GITHUB_TOKEN or GH_TOKEN environment variable.',
  '  B. (Local) Run `gh auth login` to authenticate the GitHub CLI.',
  '',
  'See .agents/README.md#github-authentication for details.',
].join('\n');

/* node:coverage ignore next */
function readEnvToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

/* node:coverage ignore next */
function memoizeEnvToken(token) {
  if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = token;
}

/* node:coverage ignore next */
export function resolveToken() {
  const envToken = readEnvToken();
  if (envToken) return envToken;
  const ghToken = readGhCliToken();
  if (!ghToken) throw new Error(TOKEN_MISSING_ERROR);
  memoizeEnvToken(ghToken);
  return ghToken;
}
