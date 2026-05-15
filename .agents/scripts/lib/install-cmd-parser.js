/**
 * Tokenize an install-command string into a `{ bin, args, shell }` triple
 * suitable for `spawnSync(bin, args, { shell, … })`. Closes the CWE-78
 * argv-injection vector that `shell: true` with a single concatenated
 * command string opens when operator-supplied installCmd is re-parsed
 * by the platform shell — by splitting the command at the boundary and
 * letting Node escape each arg individually.
 *
 * Whitespace tokenization (no quote handling) is deliberate: the input
 * contract is a simple `binary arg arg …` form. Operators that need
 * quoted args can pass a `runInstall` override directly.
 *
 * The `shell` flag is true on Windows because well-known package
 * managers ship as `.cmd` shims and Node 18.20+/20.10+/22+ refuses to
 * spawn `.cmd`/`.bat` files with `shell: false` (CVE-2024-27980). Argv
 * tokenization still removes the single-string injection vector even
 * when shell:true is required for binary resolution.
 */

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
