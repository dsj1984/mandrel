// lib/cli/dispatch.js
/**
 * `mandrel dispatch` subcommand: the operator-facing face of
 * `.agents/scripts/dispatch.js`. Both call `runDispatch`, so they share one
 * envelope and one set of exit codes; this module only maps the code onto
 * the process.
 *
 * Injectable seams (used by tests): `exit` replaces setting
 * `process.exitCode`; every other key is passed to `runDispatch`.
 */

import { runDispatch } from '../../.agents/scripts/dispatch.js';

/**
 * @param {string[]} argv
 * @param {{ exit?: (code: number) => void } & Parameters<typeof runDispatch>[1]} [deps]
 * @returns {Promise<void>}
 */
export default async function run(argv, deps = {}) {
  const {
    exit = (code) => {
      process.exitCode = code;
    },
    ...rest
  } = deps;
  exit(await runDispatch(argv, rest));
}
