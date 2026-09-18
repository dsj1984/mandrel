/**
 * Spawn the operator's install command in argv form, removing the
 * single-string injection vector. Shell only on Windows (`.cmd` shims,
 * CVE-2024-27980). Whitespace tokenization with no quoting is the contract;
 * quoted args need a `runInstall` override.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';

/**
 * @param {string} installCmd
 * @returns {{ bin: string, args: string[], shell: boolean }}
 */
function parseInstallCmd(installCmd) {
  const tokens = String(installCmd ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new RangeError(
      'parseInstallCmd: install command must contain at least one token',
    );
  }
  const [bin, ...args] = tokens;
  return { bin, args, shell: process.platform === 'win32' };
}

/**
 * @param {string} installCmd
 * @param {string} cwd
 * @param {{ spawnSync?: typeof defaultSpawnSync }} [deps] — test seam
 * @returns {{ status: number, stderr: string }}
 */
export function runInstallCommand(installCmd, cwd, deps = {}) {
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const { bin, args, shell } = parseInstallCmd(installCmd);
  const r = spawnSync(bin, args, { cwd, stdio: 'inherit', shell });
  return {
    status: r.status ?? 1,
    stderr: r.stderr ? String(r.stderr) : '',
  };
}
