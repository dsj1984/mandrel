/**
 * `tests/helpers/run-projection.js` — run a projection module's `sync*`
 * function in process and report it in the shape the old spawned-CLI tests
 * asserted on (`{ status, stdout, stderr }`): every log line, then the
 * `N file(s) synced` summary the CLI prints, lands in `stdout`; a thrown
 * error lands in `stderr` with `status: 1`.
 */

/**
 * @template {object} T
 * @param {(opts: T & { log: (line: string) => void }) => { written: string[], total: number }} sync
 * @param {T} opts
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runProjection(sync, opts) {
  const lines = [];
  try {
    const { written, total } = sync({
      ...opts,
      log: (line) => lines.push(line),
    });
    lines.push(`✔ ${written.length} file(s) synced, ${total} total`);
    return { status: 0, stdout: lines.join('\n'), stderr: '' };
  } catch (err) {
    return { status: 1, stdout: lines.join('\n'), stderr: err.message };
  }
}
