/**
 * CLI bootstrap helpers shared by every entry-point script under .agents/scripts.
 *
 * Before this module, 15 entry points each reimplemented the same main-guard
 * and error-handling boilerplate:
 *
 *   if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
 *     main().catch((err) => { ... Logger.fatal / console.error ... });
 *   }
 *
 * `runAsCli` centralises that pattern. Callers pass `import.meta.url`, a main
 * function, and an options bag for customising the error prefix, exit code,
 * or a fully-custom onError handler for scripts with non-standard failure
 * behaviour.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { respondToHelp } from './cli-usage.js';
import { formatCliError } from './error-redactor.js';
import { flushStdio } from './stdio-flush.js';

/**
 * Is the current module being executed directly as a CLI (as opposed to
 * imported by another module)?
 *
 * @param {string} importMetaUrl The caller's `import.meta.url`.
 * @returns {boolean}
 */
export function isDirectInvocation(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(importMetaUrl) === path.resolve(entry);
}

/**
 * Await `main` and set `process.exitCode` — never `process.exit()`, which
 * truncates stdout still queued behind a full pipe buffer.
 *
 * @param {() => Promise<unknown>} main
 * @param {{ source: string, exitCode: number, onError?: (err: Error) => void,
 *   propagateExitCode: boolean, errorPrefix?: string }} settings
 * @returns {Promise<void>}
 */
async function settleCli(main, settings) {
  const { source, exitCode, onError, propagateExitCode, errorPrefix } =
    settings;
  try {
    const code = await main();
    if (propagateExitCode) process.exitCode = code ?? 0;
  } catch (err) {
    if (typeof onError === 'function') {
      onError(err);
    } else {
      const prefix = errorPrefix ?? `[${source}] Fatal error`;
      console.error(`${prefix}: ${formatCliError(err)}`);
      process.exitCode = exitCode;
    }
  }
  await flushStdio();
}

/**
 * Run `main` as the CLI entry point for the caller's module. No-op when the
 * module is imported rather than invoked directly. Promise rejection from
 * `main` is funnelled through either the caller-supplied `onError` callback
 * or the default handler (prefixed stderr line + `process.exitCode`).
 *
 * A `usage` option makes the script self-describing: when the argv carries
 * `--help` / `-h`, the rendered usage block goes to stdout and `main` is
 * **never invoked**. That ordering is the whole point — it makes "`--help`
 * performs no GitHub write, acquires no lease, and mutates no working tree"
 * structurally true for every adopting script, rather than something each
 * `main` has to remember to check before its first side effect.
 *
 * @param {string} importMetaUrl        Caller's `import.meta.url`.
 * @param {() => Promise<unknown>} main The CLI's main function.
 * @param {object} [options]
 * @param {string} [options.source='CLI']           Prefix used in the default error message.
 * @param {number} [options.exitCode=1]             Exit code used by the default error handler.
 * @param {(err: Error) => void} [options.onError]  Full override of the error handler.
 * @param {boolean} [options.propagateExitCode=false] Adopt `main`'s resolved
 *   value as the process exit code.
 * @param {string} [options.errorPrefix]            Overrides the `[source] Fatal error` prefix.
 * @param {object|string} [options.usage]           Usage spec (or pre-rendered
 *   text) printed for `--help`; see `lib/cli-usage.js`.
 */
export function runAsCli(importMetaUrl, main, options = {}) {
  if (!isDirectInvocation(importMetaUrl)) return;
  const {
    source = 'CLI',
    exitCode = 1,
    onError,
    propagateExitCode = false,
    errorPrefix,
    usage,
  } = options;
  if (usage && respondToHelp(process.argv.slice(2), usage)) return;
  void settleCli(main, {
    source,
    exitCode,
    onError,
    propagateExitCode,
    errorPrefix,
  });
}
