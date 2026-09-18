/**
 * The shared `--diff-scope <ref>` flag parser for the baseline-update CLIs:
 * one spelling, one error message. Scope resolution lives in
 * `refresh-service.js`.
 */

/**
 * Accepts `--diff-scope <ref>` and `--diff-scope=<ref>`; `null` when absent.
 * Throws a TypeError when the value is missing. Pure.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
export function parseDiffScopeFlag(argv = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--diff-scope') {
      const next = argv[i + 1];
      if (typeof next !== 'string' || next.length === 0) {
        throw new TypeError(
          '[diff-scope-cli] --diff-scope requires a non-empty <ref> argument',
        );
      }
      return next;
    }
    if (typeof tok === 'string' && tok.startsWith('--diff-scope=')) {
      const ref = tok.slice('--diff-scope='.length);
      if (ref.length === 0) {
        throw new TypeError(
          '[diff-scope-cli] --diff-scope= requires a non-empty <ref> value',
        );
      }
      return ref;
    }
  }
  return null;
}
