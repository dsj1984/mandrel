import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TEST_TEMP_ROOT_ENV } from './config/temp-paths.js';
import { reapOnExit } from './test-temp.js';

/** Per-process memo: one scratch tree per runner process. */
let _createdScratchDir = null;

/** Test-only: clear the scratch memo. */
export function _clearTestScratchTempRootCache() {
  _createdScratchDir = null;
}

/**
 * Per-process scratch tempRoot keeping tests out of real `temp/` telemetry.
 * An inherited absolute root is reused; only the minting process reaps it.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv=process.env]
 * @param {{ mkdtemp?: typeof mkdtempSync, onExit?: (fn: () => void) => void }} [deps]
 * @returns {string} absolute scratch tempRoot
 */
export function ensureTestScratchTempRoot(
  baseEnv = process.env,
  { mkdtemp = mkdtempSync, onExit } = {},
) {
  const existing = baseEnv?.[TEST_TEMP_ROOT_ENV];
  if (
    typeof existing === 'string' &&
    existing.length > 0 &&
    path.isAbsolute(existing)
  ) {
    return existing;
  }
  if (_createdScratchDir === null) {
    _createdScratchDir = mkdtemp(path.join(os.tmpdir(), 'mandrel-test-temp-')); // test-temp-allow: children inherit this path, so it lives outside the suite root.
    reapOnExit(_createdScratchDir, onExit ? { onExit } : {});
  }
  return _createdScratchDir;
}

/**
 * Env bag for test child processes:
 *
 *   - `NOTIFICATION_WEBHOOK_URL` is deleted (unless
 *     `MANDREL_ALLOW_TEST_WEBHOOKS=1`) so no test POSTs to a live endpoint;
 *   - `NODE_ENV` defaults to `test`;
 *   - every `GIT_*` is dropped: inside a git hook `GIT_DIR` points at the
 *     shared gitdir, and a fixture's `git init` there writes `core.bare=true`
 *     into the main checkout, breaking every worktree;
 *   - `MANDREL_TEST_TEMP_ROOT` points at the per-process scratch root.
 *
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function buildWebhookSafeTestEnv(baseEnv = process.env) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([k]) => !k.startsWith('GIT_')),
  );
  env.NODE_ENV = baseEnv.NODE_ENV ?? 'test';
  if (env.MANDREL_ALLOW_TEST_WEBHOOKS !== '1') {
    delete env.NOTIFICATION_WEBHOOK_URL;
  }
  env[TEST_TEMP_ROOT_ENV] = ensureTestScratchTempRoot(baseEnv);
  return env;
}
