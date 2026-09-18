/**
 * Stage 3 of the reap fallback (Windows): find user-mode processes holding a
 * stuck worktree, `taskkill /T /F` them, and re-drain. Kernel-held locks
 * (indexer, AV) are invisible and wait for the next sweep. A no-op drain
 * elsewhere.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { NOOP_LOGGER } from '../../Logger.js';
import { drainPendingCleanup, readManifest } from './pending-cleanup.js';

const SETTLE_MS = 1500;
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
 * Windows processes whose executable or command line references `wtPath`.
 * Best-effort: any failure, or non-Windows, returns `[]`.
 *
 * @param {string} wtPath
 * @param {object} [opts]
 * @param {Function} [opts.spawn]
 * @param {string} [opts.platform]
 * @returns {Array<{pid:number, name:string, path?:string, commandLine?:string}>}
 */
export function findHoldersInPath(wtPath, opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return [];
  if (!wtPath) return [];

  const normalized = path.resolve(wtPath);
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
 * Pids never to kill: `selfPid` (always, even with an empty table) plus its
 * ancestor chain. Cycle-guarded.
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
 * Windows process table as `{ pid, ppid }`; `[]` on any failure.
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawn]
 * @param {string} [opts.platform]
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
 * `taskkill /T /F` each holder; returns killed pids, never throws. Excludes
 * self and ancestors: a command-line match can select the invoking shell, and
 * `/T` on an ancestor would kill this process too.
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
 * Drain, then for still-stuck entries kill their holders and re-drain. Adds
 * `escalated`, `killedPids` and `noHolders` (no user-mode holder found) to the
 * drain result; `escalate: false` is a plain drain.
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
