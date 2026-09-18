// .agents/scripts/lib/orchestration/remote-verifier.js
/**
 * remote-verifier.js — verified "is there a live, pushable remote?" evidence
 * for the delivery entry seams, so the workflow branches on
 * `remoteVerified` (use the remote, or block quoting the probe) instead of an
 * agent's perception — never a silent local build.
 *
 * `remoteVerified` requires both `git remote get-url origin` and
 * `git ls-remote origin HEAD` to succeed. Callers flip no labels; the
 * workflow owns the `agent::blocked` transition.
 */

import { spawnSync } from 'node:child_process';

/**
 * Per-probe bound, SIGKILLed, so a hanging remote degrades to
 * `remoteVerified: false` instead of parking the entry seam.
 */
export const REMOTE_PROBE_TIMEOUT_MS = 30_000;

function runProbe({ args, cwd, spawnFn, timeoutMs }) {
  const result = spawnFn('git', args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  return {
    args: ['git', ...args].join(' '),
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/**
 * @param {{
 *   cwd?: string,
 *   spawnFn?: typeof spawnSync,
 *   timeoutMs?: number,
 * }} [opts]
 * @returns {{
 *   remoteVerified: boolean,
 *   remoteUrl: string|null,
 *   detail: string,
 *   probes: {
 *     getUrl: { args: string, status: number, stdout: string, stderr: string },
 *     lsRemote: { args: string, status: number, stdout: string, stderr: string }|null,
 *   },
 * }}
 */
export function verifyRemote({
  cwd = process.cwd(),
  spawnFn = spawnSync,
  timeoutMs = REMOTE_PROBE_TIMEOUT_MS,
} = {}) {
  const getUrl = runProbe({
    args: ['remote', 'get-url', 'origin'],
    cwd,
    spawnFn,
    timeoutMs,
  });
  if (getUrl.status !== 0) {
    return {
      remoteVerified: false,
      remoteUrl: null,
      detail: `no 'origin' remote configured — \`${getUrl.args}\` exited ${getUrl.status}: ${getUrl.stderr || '(no stderr)'}`,
      probes: { getUrl, lsRemote: null },
    };
  }
  const remoteUrl = getUrl.stdout;

  const lsRemote = runProbe({
    args: ['ls-remote', 'origin', 'HEAD'],
    cwd,
    spawnFn,
    timeoutMs,
  });
  if (lsRemote.status !== 0 || lsRemote.stdout.length === 0) {
    return {
      remoteVerified: false,
      remoteUrl,
      detail: `'origin' (${remoteUrl}) is unreachable — \`${lsRemote.args}\` exited ${lsRemote.status}: ${lsRemote.stderr || '(empty ls-remote output)'}`,
      probes: { getUrl, lsRemote },
    };
  }

  return {
    remoteVerified: true,
    remoteUrl,
    detail: `origin verified (${remoteUrl}); ls-remote HEAD → ${lsRemote.stdout.split(/\s+/)[0]}`,
    probes: { getUrl, lsRemote },
  };
}

/**
 * Finalize backstop: a never-pushed delivery branch must fail with a blocker,
 * not declare success. Unlike `branchExistsRemotely`, the spawn is bounded
 * and the result carries probe detail for the blocker envelope.
 *
 * @param {{
 *   branch: string,
 *   cwd?: string,
 *   spawnFn?: typeof spawnSync,
 *   timeoutMs?: number,
 * }} opts
 * @returns {{ exists: boolean, detail: string }}
 */
export function probeRemoteBranch({
  branch,
  cwd = process.cwd(),
  spawnFn = spawnSync,
  timeoutMs = REMOTE_PROBE_TIMEOUT_MS,
}) {
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new TypeError('probeRemoteBranch: branch must be a non-empty string');
  }
  const probe = runProbe({
    args: ['ls-remote', '--heads', 'origin', branch],
    cwd,
    spawnFn,
    timeoutMs,
  });
  if (probe.status !== 0) {
    return {
      exists: false,
      detail: `\`${probe.args}\` exited ${probe.status}: ${probe.stderr || '(no stderr)'}`,
    };
  }
  if (probe.stdout.length === 0) {
    return {
      exists: false,
      detail: `\`${probe.args}\` found no ref — ${branch} was never pushed to origin`,
    };
  }
  return {
    exists: true,
    detail: `${branch} on origin at ${probe.stdout.split(/\s+/)[0]}`,
  };
}
