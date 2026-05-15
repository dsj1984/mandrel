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
import { formatCliError } from './error-redactor.js';

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
 * Run `main` as the CLI entry point for the caller's module. No-op when the
 * module is imported rather than invoked directly. Promise rejection from
 * `main` is funnelled through either the caller-supplied `onError` callback
 * or the default handler (prefixed stderr line + `process.exit(exitCode)`).
 *
 * @param {string} importMetaUrl        Caller's `import.meta.url`.
 * @param {() => Promise<unknown>} main The CLI's main function.
 * @param {object} [options]
 * @param {string} [options.source='CLI']           Prefix used in the default error message.
 * @param {number} [options.exitCode=1]             Exit code used by the default error handler.
 * @param {(err: Error) => void} [options.onError]  Full override of the error handler.
 */
export function runAsCli(importMetaUrl, main, options = {}) {
  if (!isDirectInvocation(importMetaUrl)) return;
  const {
    source = 'CLI',
    exitCode = 1,
    onError,
    propagateExitCode = false,
    errorPrefix,
  } = options;
  const promise = main();
  if (propagateExitCode) {
    promise.then((code) => process.exit(code ?? 0));
  }
  promise.catch((err) => {
    if (typeof onError === 'function') {
      onError(err);
      return;
    }
    const prefix = errorPrefix ?? `[${source}] Fatal error`;
    console.error(`${prefix}: ${formatCliError(err)}`);
    process.exit(exitCode);
  });
}
