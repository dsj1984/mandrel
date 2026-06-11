/**
 * worktree/lifecycle/force-drain.js
 *
 * Stage 3 of the Windows worktree reap fallback: when Stage 2
 * (`drainPendingCleanup`) repeatedly fails to clear an entry because some
 * process is still holding handles inside the worktree, this module
 * enumerates the holding processes via PowerShell `Get-CimInstance
 * Win32_Process`, terminates them with `taskkill /T /F`, and re-runs the
 * Stage 2 drain.
 *
 * Detection is best-effort: it matches process `ExecutablePath` and
 * `CommandLine` against the worktree path. Kernel-held locks (Windows
 * Search indexer, AV scanners) won't show up — those entries stay in the
 * manifest and surface again on the next sweep, by which time the
 * indexer/AV has usually moved on.
 *
 * Non-Windows: this module is a no-op (`findHoldersInPath` returns `[]`),
 * so calling `forceDrainPendingCleanup` is safe everywhere — it just
 * degrades to the standard drain.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { NOOP_LOGGER } from '../../Logger.js';
import { drainPendingCleanup, readManifest } from './pending-cleanup.js';

/** Initial wait after `taskkill` before retrying `drainPendingCleanup`. */
const SETTLE_MS = 1500;
/** If entries remain stuck after the first post-kill drain, wait again and drain once more. */
const POST_KILL_RETRY_SETTLE_MS = 800;

/**
 * @param {Awaited<ReturnType<typeof drainPendingCleanup>>} prev
 * @param {Awaited<ReturnType<typeof drainPendingCleanup>>} next
 */
function mergeDrainPasses(prev, next) {
  const drainedSet = new Set([...prev.drained, ...next.drained]);
  const drainedDetails = [
    ...prev.drainedDetails,
    ...next.drainedDetails.filter(
      (d) => !prev.drainedDetails.some((f) => f.storyId === d.storyId),
    ),
  ];
  return {
    drained: [...drainedSet],
    drainedDetails,
    persistent: next.persistent,
    persistentDetails: next.persistentDetails,
    stillPending: next.stillPending,
    stillPendingDetails: next.stillPendingDetails,
  };
}

/**
 * Enumerate Windows processes whose ExecutablePath or CommandLine is rooted
 * inside `wtPath`. On non-Windows, returns `[]`. Any PowerShell failure
 * (timeout, parse error, exit !=0) also returns `[]` — this is best-effort
 * escalation, never a hard error path.
 *
 * @param {string} wtPath Absolute path to the worktree directory.
 * @param {object} [opts]
 * @param {Function} [opts.spawn] Injection point for tests (default `spawnSync`).
 * @param {string} [opts.platform] Override `process.platform` for tests.
 * @returns {Array<{pid:number, name:string, path?:string, commandLine?:string}>}
 */
export function findHoldersInPath(wtPath, opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return [];
  if (!wtPath) return [];

  const normalized = path.resolve(wtPath);
  // Single-quote escape for PowerShell: double any embedded single quote.
  const psNeedle = normalized.replace(/'/g, "''");

  const script = [
    `$needle = '${psNeedle}'`,
    `$wild = $needle + '*'`,
    `$wildAny = '*' + $needle + '*'`,
    `Get-CimInstance Win32_Process |`,
    `  Where-Object {`,
    `    ($_.ExecutablePath -and $_.ExecutablePath -like $wild) -or`,
    `    ($_.CommandLine -and $_.CommandLine -like $wildAny)`,
    `  } |`,
    `  Select-Object ProcessId, Name, ExecutablePath, CommandLine |`,
    `  ConvertTo-Json -Compress -Depth 2`,
  ].join('\n');

  let res;
  try {
    res = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch {
    return [];
  }
  if (!res || res.status !== 0 || !res.stdout) return [];

  const raw = String(res.stdout).trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((p) => p && typeof p.ProcessId === 'number' && p.ProcessId > 0)
    .map((p) => ({
      pid: p.ProcessId,
      name: typeof p.Name === 'string' ? p.Name : '?',
      path: typeof p.ExecutablePath === 'string' ? p.ExecutablePath : undefined,
      commandLine:
        typeof p.CommandLine === 'string' ? p.CommandLine : undefined,
    }));
}

/**
 * Pure: compute the set of pids that must never be killed — `selfPid` plus
 * its full ancestor chain — from a process table of `{ pid, ppid }` rows.
 * Cycle-guarded (a corrupt/raced table cannot loop forever). `selfPid` is
 * always included even when the table is empty or missing its row, so the
 * guard fails safe.
 *
 * @param {number} selfPid
 * @param {Array<{ pid: number, ppid?: number }>} table
 * @returns {Set<number>}
 */
export function computeProtectedPids(selfPid, table) {
  const protectedPids = new Set([selfPid]);
  if (!Array.isArray(table) || table.length === 0) return protectedPids;
  const parentOf = new Map();
  for (const row of table) {
    if (row && typeof row.pid === 'number' && typeof row.ppid === 'number') {
      parentOf.set(row.pid, row.ppid);
    }
  }
  let cursor = selfPid;
  while (parentOf.has(cursor)) {
    const ppid = parentOf.get(cursor);
    if (protectedPids.has(ppid)) break; // cycle guard
    protectedPids.add(ppid);
    cursor = ppid;
  }
  return protectedPids;
}

/**
 * Enumerate the full Windows process table as `{ pid, ppid }` rows so the
 * kill set can exclude the invoking shell / orchestrator ancestry.
 * Best-effort: any failure returns `[]` (callers still protect `selfPid`).
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawn] Injection point for tests (default `spawnSync`).
 * @param {string} [opts.platform] Override `process.platform` for tests.
 * @returns {Array<{ pid: number, ppid: number }>}
 */
export function fetchProcessTable(opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return [];

  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress';
  let res;
  try {
    res = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch {
    return [];
  }
  if (!res || res.status !== 0 || !res.stdout) return [];
  let parsed;
  try {
    parsed = JSON.parse(String(res.stdout).trim());
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((p) => p && typeof p.ProcessId === 'number')
    .map((p) => ({
      pid: p.ProcessId,
      ppid: typeof p.ParentProcessId === 'number' ? p.ParentProcessId : -1,
    }));
}

/**
 * `taskkill /T /F /PID <pid>` for each holder. Returns the pids reported
 * as terminated. Per-pid failures are logged but do not throw — caller
 * decides whether the partial kill is enough to retry.
 *
 * Self-preservation (Story #4018): holders are matched by command-line
 * substring, which can select the invoking shell or the orchestrator's own
 * ancestor chain (any ancestor whose command line mentions the worktree
 * path). Before any `taskkill /T /F`, the kill set excludes `selfPid` and
 * its full ancestor chain — `/T` on an ancestor would kill this process too.
 */
export function terminateHolders(holders, opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  const platform = opts.platform ?? process.platform;
  const logger = opts.logger ?? NOOP_LOGGER;
  if (platform !== 'win32') return [];
  if (!Array.isArray(holders) || holders.length === 0) return [];

  const selfPid = opts.selfPid ?? process.pid;
  const protectedPids =
    opts.protectedPids ??
    computeProtectedPids(selfPid, fetchProcessTable({ spawn, platform }));

  const killed = [];
  for (const h of holders) {
    if (!h || typeof h.pid !== 'number') continue;
    if (protectedPids.has(h.pid)) {
      logger.warn(
        `force-drain: skipping pid=${h.pid} name=${h.name ?? '?'} — self/ancestor of this process (never killed)`,
      );
      continue;
    }
    let res;
    try {
      res = spawn('taskkill.exe', ['/T', '/F', '/PID', String(h.pid)], {
        encoding: 'utf8',
        timeout: 10_000,
      });
    } catch (err) {
      logger.warn(
        `force-drain: taskkill spawn failed pid=${h.pid}: ${err.message}`,
      );
      continue;
    }
    if (res && res.status === 0) {
      killed.push(h.pid);
      logger.warn(
        `force-drain: terminated pid=${h.pid} name=${h.name} path=${h.path ?? '?'}`,
      );
    } else {
      const stderr = (res?.stderr || res?.stdout || '').toString().trim();
      logger.warn(
        `force-drain: taskkill pid=${h.pid} failed: ${stderr || 'unknown'}`,
      );
    }
  }
  return killed;
}

/**
 * Drain the pending-cleanup manifest with escalation. Runs the standard
 * `drainPendingCleanup` first; for any entry left in `stillPending` or
 * `persistent`, enumerates handle-holders inside the worktree path,
 * terminates them, and re-drains.
 *
 * Result extends the standard drain shape with:
 *   - `escalated`:  storyIds where holders were detected AND killed.
 *   - `killedPids`: { [storyId]: number[] } pids terminated per entry.
 *   - `noHolders`:  storyIds whose lock could not be attributed to a
 *                   user-mode process (likely indexer/AV/kernel).
 *
 * Escalation is gated on `escalate: true` (default); pass `false` to
 * mirror the legacy `drainPendingCleanup` behaviour exactly.
 */
export async function forceDrainPendingCleanup({
  repoRoot,
  worktreeRoot,
  git,
  fsRm,
  logger = NOOP_LOGGER,
  findHolders = findHoldersInPath,
  killHolders = terminateHolders,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  escalate = true,
} = {}) {
  const first = await drainPendingCleanup({
    repoRoot,
    worktreeRoot,
    git,
    fsRm,
    logger,
  });

  const empty = { escalated: [], killedPids: {}, noHolders: [] };
  if (!escalate) return { ...first, ...empty };

  const stuck = [...first.stillPending, ...first.persistent];
  if (stuck.length === 0) return { ...first, ...empty };

  const escalated = [];
  const killedPids = {};
  const noHolders = [];
  const stuckSet = new Set(stuck);
  const entries = readManifest(worktreeRoot).filter((e) =>
    stuckSet.has(e.storyId),
  );

  for (const entry of entries) {
    const holders = findHolders(entry.path);
    if (holders.length === 0) {
      logger.warn(
        `force-drain: no user-mode holders for storyId=${entry.storyId} path=${entry.path} ` +
          `(likely Search indexer / AV / kernel handle — will retry next sweep)`,
      );
      noHolders.push(entry.storyId);
      continue;
    }
    logger.warn(
      `force-drain: escalating storyId=${entry.storyId} — ${holders.length} holder(s) detected`,
    );
    const killed = killHolders(holders, { logger });
    if (killed.length === 0) continue;
    killedPids[entry.storyId] = killed;
    escalated.push(entry.storyId);
  }

  if (escalated.length === 0) {
    return { ...first, escalated, killedPids, noHolders };
  }

  await sleep(SETTLE_MS);

  let followUp = await drainPendingCleanup({
    repoRoot,
    worktreeRoot,
    git,
    fsRm,
    logger,
  });

  const stuckAfter =
    followUp.stillPending.length + followUp.persistent.length > 0;
  if (stuckAfter) {
    await sleep(POST_KILL_RETRY_SETTLE_MS);
    const third = await drainPendingCleanup({
      repoRoot,
      worktreeRoot,
      git,
      fsRm,
      logger,
    });
    followUp = mergeDrainPasses(followUp, third);
  }

  const drainedSet = new Set([...first.drained, ...followUp.drained]);
  const drainedDetails = [
    ...first.drainedDetails,
    ...followUp.drainedDetails.filter(
      (d) => !first.drainedDetails.some((f) => f.storyId === d.storyId),
    ),
  ];
  return {
    drained: [...drainedSet],
    drainedDetails,
    persistent: followUp.persistent,
    persistentDetails: followUp.persistentDetails,
    stillPending: followUp.stillPending,
    stillPendingDetails: followUp.stillPendingDetails,
    escalated,
    killedPids,
    noHolders,
  };
}
