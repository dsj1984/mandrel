/** Env-derived runtime state: worktree isolation, session id, working path. */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const SESSION_ID_LENGTH = 12;
const SESSION_ID_ALLOWED_CHAR_RE = /[^a-z0-9]/g;

/**
 * Exact-string env matching is deliberate: `""` or `"0"` must not flip it.
 *
 * @param {{ config?: { delivery?: { worktreeIsolation?: { enabled?: boolean } } | null } }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function resolveWorktreeEnabled(opts = {}, env = process.env) {
  if (env.AP_WORKTREE_ENABLED === 'true') return true;
  if (env.AP_WORKTREE_ENABLED === 'false') return false;
  if (env.CLAUDE_CODE_REMOTE === 'true') return false;
  return Boolean(opts.config?.delivery?.worktreeIsolation?.enabled);
}

/**
 * Pure. `worktreeRoot` containment is enforced by `validateOrchestrationConfig`.
 *
 * @param {object} opts
 * @param {boolean} opts.worktreeEnabled
 * @param {string} opts.repoRoot — absolute.
 * @param {number|string} [opts.storyId] — required when `worktreeEnabled`.
 * @param {string} [opts.worktreeRoot]
 * @returns {string}
 */
export function resolveWorkingPath({
  worktreeEnabled,
  repoRoot,
  storyId,
  worktreeRoot = '.worktrees',
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('resolveWorkingPath: repoRoot is required');
  }
  // Not re-resolved, so sentinel paths like `/repo` survive on Windows.
  if (!worktreeEnabled) return repoRoot;
  if (storyId == null) {
    throw new Error(
      'resolveWorkingPath: storyId is required when worktreeEnabled is true',
    );
  }
  return path.join(repoRoot, worktreeRoot, `story-${storyId}`);
}

/**
 * Each signal carries its source so the startup log can explain it.
 *
 * @param {{ config?: object }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   worktreeEnabled: boolean,
 *   worktreeEnabledSource: 'env-override' | 'remote-auto' | 'config',
 *   sessionId: string,
 *   sessionIdSource: 'remote' | 'local',
 *   isRemote: boolean,
 * }}
 */
export function resolveRuntime(opts = {}, env = process.env) {
  const worktreeEnabled = resolveWorktreeEnabled(opts, env);
  const worktreeEnabledSource =
    env.AP_WORKTREE_ENABLED === 'true' || env.AP_WORKTREE_ENABLED === 'false'
      ? 'env-override'
      : env.CLAUDE_CODE_REMOTE === 'true'
        ? 'remote-auto'
        : 'config';

  const remoteId = env.CLAUDE_CODE_REMOTE_SESSION_ID;
  const remoteUsable =
    typeof remoteId === 'string' &&
    remoteId.toLowerCase().replace(SESSION_ID_ALLOWED_CHAR_RE, '').length > 0;
  const sessionId = resolveSessionId(env);
  const sessionIdSource = remoteUsable ? 'remote' : 'local';

  return {
    worktreeEnabled,
    worktreeEnabledSource,
    sessionId,
    sessionIdSource,
    isRemote: env.CLAUDE_CODE_REMOTE === 'true',
  };
}

/**
 * Always 1..12 chars of `[a-z0-9]`, safe in labels and logs unescaped (env
 * injection guard). A remote id that sanitises to empty falls back to local.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveSessionId(env = process.env) {
  const remote = env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (typeof remote === 'string' && remote.length > 0) {
    const sanitised = remote
      .toLowerCase()
      .replace(SESSION_ID_ALLOWED_CHAR_RE, '')
      .slice(0, SESSION_ID_LENGTH);
    if (sanitised.length > 0) return sanitised;
  }
  return generateLocalSessionId();
}

function generateLocalSessionId() {
  // 2 host + 2 pid + 8 random hex; only the random part guarantees uniqueness.
  const host = (os.hostname() || 'h')
    .toLowerCase()
    .replace(SESSION_ID_ALLOWED_CHAR_RE, '')
    .slice(0, 2)
    .padEnd(2, '0');
  const pid = String(process.pid)
    .replace(SESSION_ID_ALLOWED_CHAR_RE, '')
    .slice(-2)
    .padStart(2, '0');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${host}${pid}${rand}`.slice(0, SESSION_ID_LENGTH);
}
