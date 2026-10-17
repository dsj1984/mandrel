/**
 * GitHub Provider — token resolution: GITHUB_TOKEN / GH_TOKEN env →
 * `gh auth token` → classified throw (`gh-token-diagnostics.js`). The
 * `execFileSync`-shaped runner sits behind a holder so tests can swap it.
 */

import { execFileSync as defaultExecSync } from 'node:child_process';
import {
  describeTokenFailure,
  runGhAuthToken,
  TOKEN_SOURCE_ENV,
} from './gh-token-diagnostics.js';

export const execSyncHolder = { impl: defaultExecSync };

export function __setExecSyncForTests(fn) {
  execSyncHolder.impl = fn ?? defaultExecSync;
}

/* node:coverage ignore next */
export function readGhCliToken() {
  return runGhAuthToken(execSyncHolder.impl);
}

/* node:coverage ignore next */
function readEnvToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

/* node:coverage ignore next */
function memoizeEnvToken(token) {
  process.env.GITHUB_TOKEN = token;
  process.env[TOKEN_SOURCE_ENV] = 'gh-cli';
}

/* node:coverage ignore next */
export function resolveToken() {
  const envToken = readEnvToken();
  if (envToken) return envToken;
  const result = readGhCliToken();
  if (!result.token) throw new Error(describeTokenFailure(result));
  memoizeEnvToken(result.token);
  return result.token;
}
