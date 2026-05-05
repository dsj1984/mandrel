/**
 * GitHub auth — token resolution.
 *
 * Hierarchy:
 *   1. Explicit GITHUB_TOKEN or GH_TOKEN env var (CI/CD / Manual).
 *   2. `gh auth token` CLI fallback (Local development).
 *   3. Throws with an instructive error.
 *
 * Test seam: `execSync` is indirected through a mutable holder so tests can
 * swap it via `__setExecSyncForTests`. Production always uses the real impl.
 */

import { execSync as defaultExecSync } from 'node:child_process';

const execSyncHolder = { impl: defaultExecSync };

export function __setExecSyncForTests(fn) {
  execSyncHolder.impl = fn ?? defaultExecSync;
}

/* node:coverage ignore next */
export function resolveToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) return token;

  try {
    const ghToken = execSyncHolder
      .impl('gh auth token', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      .trim();
    if (ghToken) {
      // Memoize across subsequent provider constructions. Only set when
      // unset — never overwrite an operator-supplied token (Tech Spec #555,
      // Security & Privacy — Token memoization).
      if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = ghToken;
      return ghToken;
    }
  } catch {
    // gh CLI not installed or not authenticated
  }

  const errorMsg = [
    '[GitHubProvider] Authentication Failed: No GitHub token found.',
    '',
    'To resolve this, choose one of the following:',
    '  A. (CI/CD / Agent Script) Set the GITHUB_TOKEN or GH_TOKEN environment variable.',
    '  B. (Local) Run `gh auth login` to authenticate the GitHub CLI.',
    '',
    'See .agents/scripts/lib/orchestration/README.md#authentication for details.',
  ].join('\n');

  throw new Error(errorMsg);
}
