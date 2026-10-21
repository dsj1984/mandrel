// lib/cli/doctor-checks/spawn.js — Shared async spawn wrapper for the doctor checks.

import { execFile } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }>}
 */
export function spawn(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', ...opts },
      (err, stdout, stderr) => {
        const status = err ? (Number.isInteger(err.code) ? err.code : null) : 0;
        resolve({
          status,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: status === null ? err : undefined,
        });
      },
    );
  });
}

/** One doctor run's runner: identical `cmd + args` probes share one spawn. */
export function createRunner(run = spawn) {
  const spawned = new Map();
  return (cmd, args, opts) => {
    const key = JSON.stringify([cmd, args]);
    if (!spawned.has(key)) spawned.set(key, run(cmd, args, opts));
    return spawned.get(key);
  };
}
