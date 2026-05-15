/**
 * Tokenize an install-command string into a `{ bin, args }` argv pair
 * suitable for `spawnSync(bin, args, { shell: false })`. Closes the
 * CWE-78 argv-injection vector that `shell: true` opens when an
 * operator-supplied installCmd is re-parsed by the platform shell.
 *
 * Whitespace tokenization (no quote handling) is deliberate: the input
 * contract is a simple `binary arg arg …` form. Operators that need
 * quoted args can pass a `runInstall` override directly.
 *
 * On Windows, well-known package-manager binaries are resolved via their
 * `.cmd` shim because Node won't auto-resolve PATHEXT under
 * `shell: false`.
 */

const WINDOWS_SHIMMED_BINS = new Set(['npm', 'pnpm', 'yarn', 'npx']);

/**
 * @param {string} installCmd
 * @returns {{ bin: string, args: string[] }}
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
  let [bin, ...args] = tokens;
  if (process.platform === 'win32' && WINDOWS_SHIMMED_BINS.has(bin)) {
    bin = `${bin}.cmd`;
  }
  return { bin, args };
}
