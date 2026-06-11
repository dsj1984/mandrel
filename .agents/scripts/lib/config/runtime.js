/**
 * Runtime-environment resolution helpers (Epic #773 Story 6 — split out of
 * config-resolver.js). Reads `process.env` to determine worktree-isolation
 * state, the per-process session id, and the canonical working path the
 * agent should `cd` into for a given Story.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const SESSION_ID_LENGTH = 12;
const SESSION_ID_ALLOWED_CHAR_RE = /[^a-z0-9]/g;

/**
 * Resolve whether worktree isolation is enabled for this process, with strict
 * environment-variable precedence that outranks the committed config value.
 *
 * Precedence:
 *   1. `env.AP_WORKTREE_ENABLED === 'true'`  → true   (explicit operator override)
 *   2. `env.AP_WORKTREE_ENABLED === 'false'` → false  (explicit operator override)
 *   3. `env.CLAUDE_CODE_REMOTE === 'true'`   → false  (web session auto-detect)
 *   4. else                                  → Boolean(config.delivery.worktreeIsolation.enabled)
 *
 * String matching on `AP_WORKTREE_ENABLED` is deliberate: `""`, `"0"`, or any
 * other truthy-ish shell expansion must not flip the flag.
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
 * Resolve the absolute working path the agent should `cd` into for a given
 * Story. When worktree isolation is on, returns the per-story worktree path
 * (`<repoRoot>/<wtRoot>/story-<id>`). When off, returns the repo root so
 * init, close, and recovery converge on a single canonical path with no
 * undefined-path access on the off-branch.
 *
 * Pure helper — no fs / git side effects. Path-traversal containment for
 * `worktreeRoot` is enforced earlier by `validateOrchestrationConfig`.
 *
 * @param {object} opts
 * @param {boolean} opts.worktreeEnabled
 * @param {string} opts.repoRoot          Absolute path to the main checkout.
 * @param {number|string} [opts.storyId]  Required when `worktreeEnabled` is true.
 * @param {string} [opts.worktreeRoot]    Worktree root relative to repoRoot. Defaults to `.worktrees`.
 * @returns {string} Absolute path the agent should work from.
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
  // Caller is responsible for passing an already-absolute repoRoot (every
  // production caller threads `path.resolve(...)` upstream). We do not
  // re-resolve here so unit-test fixtures that pass sentinel paths like
  // `/repo` keep their semantics on Windows.
  if (!worktreeEnabled) return repoRoot;
  if (storyId == null) {
    throw new Error(
      'resolveWorkingPath: storyId is required when worktreeEnabled is true',
    );
  }
  return path.join(repoRoot, worktreeRoot, `story-${storyId}`);
}

/**
 * One-shot environment-aware runtime resolution. Returns the trio of runtime
 * signals consumed across `/deliver`: whether worktree isolation is on
 * for this process, the session id for claim labels, and whether we're in a
 * Claude Code web session. Each signal also records its **source** so the
 * `story-init` startup log can name why the value is what it is.
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
 * Resolve the per-process session-id used for claim labels and structured
 * comments. Prefers the Anthropic-provided `CLAUDE_CODE_REMOTE_SESSION_ID`
 * (sanitised and truncated) and falls back to a locally-generated short id
 * derived from hostname + pid + random entropy.
 *
 * Sanitisation for the remote id:
 *   1. Lower-case.
 *   2. Strip every character outside `[a-z0-9]`.
 *   3. Truncate to {@link SESSION_ID_LENGTH} (12) chars.
 *   4. If the sanitised result is empty, fall back to the locally-generated id
 *      — an all-symbol remote id is not a usable label suffix.
 *
 * The return value is always a string of 1..12 chars matching `[a-z0-9]+`,
 * suitable for inclusion in log lines and any future label suffixes without
 * further escaping. See tech spec #670 § Security — Env-var injection.
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
  // Layout: 2 host chars + 2 pid chars + 8 random hex chars = 12 chars. The
  // random suffix is load-bearing for uniqueness; host/pid hints are
  // operator-friendly context, not identifiers.
  const host = (os.hostname() || 'h')
    .toLowerCase()
    .replace(SESSION_ID_ALLOWED_CHAR_RE, '')
    .slice(0, 2)
    .padEnd(2, '0');
  const pid = String(process.pid)
    .replace(SESSION_ID_ALLOWED_CHAR_RE, '')
    .slice(-2)
    .padStart(2, '0');
  const rand = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  return `${host}${pid}${rand}`.slice(0, SESSION_ID_LENGTH);
}
