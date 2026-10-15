// lib/cli/doctor-checks/spawn.js — Shared `spawnSync` wrapper for the doctor checks.

import { spawnSync } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }}
 */
export function spawn(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    error: r.error,
  };
}
