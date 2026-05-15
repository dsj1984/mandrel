/**
 * Tokenize + spawn the operator-supplied install command in argv form
 * (shell:true is only used on Windows because well-known package managers
 * ship as `.cmd` shims and Node 18.20+/20.10+/22+ refuses to spawn them
 * with shell:false under CVE-2024-27980). Tokenization removes the
 * single-string injection vector — args are escaped individually even
 * when shell:true is required for binary resolution.
 *
 * Whitespace tokenization (no quote handling) is deliberate: the input
 * contract is a simple `binary arg arg …` form. Operators that need
 * quoted args can pass a `runInstall` override directly.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';

/**
 * @param {string} installCmd
 * @returns {{ bin: string, args: string[], shell: boolean }}
 */
export function parseInstallCmd(installCmd) {
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
 * Default runInstall implementation. Tokenizes `installCmd`, then spawns
 * synchronously with the correct shell flag per platform.
 *
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
