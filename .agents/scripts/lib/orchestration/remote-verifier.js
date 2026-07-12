// .agents/scripts/lib/orchestration/remote-verifier.js
/**
 * remote-verifier.js — deterministic "is there a live, pushable remote?"
 * evidence for the delivery entry seams. Issue #4483.
 *
 * `/deliver` could silently shortcut the entire orchestration — building
 * the delivery inline and committing to local `main` without pushing —
 * when the driving agent *perceived* the environment had no live GitHub
 * remote. The judgment was vibes, not fact. This module gives the entry
 * seams (`epic-deliver-preflight.js`, `single-story-init.js`) a verified
 * probe result to record in their envelopes so the workflow can branch on
 * `remoteVerified: true|false` deterministically: use the remote, or
 * transition to `agent::blocked` quoting the probe output — never a
 * silent local build.
 *
 * Two probes, both bounded (a hung git spawn must not park the entry
 * seam — mirrors the `ghPrListHead` timeout contract in `finalizer.js`):
 *
 *   1. `git remote get-url origin`  — is an `origin` remote configured?
 *   2. `git ls-remote origin HEAD`  — is it reachable with current auth?
 *
 * `remoteVerified` is true only when BOTH succeed. The CLI callers do
 * NOT flip labels on a false result — the workflow owns the
 * `agent::blocked` transition (same division of labour as the preflight
 * breach handling).
 */

import { spawnSync } from 'node:child_process';

/**
 * Bounded timeout for each git probe. `ls-remote` is a network call;
 * SIGKILL at the bound so an unreachable or hanging remote degrades to a
 * deterministic `remoteVerified: false` instead of a stuck entry seam.
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
 * Probe the `origin` remote for existence + reachability.
 *
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
 * Probe whether a specific branch exists on `origin` — the deterministic
 * finalize backstop (issue #4483 fix direction 3): a delivery branch that
 * was never pushed MUST fail finalize with an explicit blocker rather
 * than let the run declare success.
 *
 * Distinct from `git-branch-lifecycle.js#branchExistsRemotely` in two
 * load-bearing ways: the spawn is bounded (timeout + SIGKILL, so a hung
 * remote cannot park the finalize seam) and the result carries the probe
 * detail for the blocker envelope instead of a bare boolean.
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
