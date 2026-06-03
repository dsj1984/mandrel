#!/usr/bin/env node
// bin/postinstall.js — best-effort `.agents/` materializer on install.

/**
 * Published-package `postinstall` hook.
 *
 * Runs `mandrel sync` to materialize the package payload into the consumer's
 * `./.agents/` working copy. This hook is **best-effort by contract** (Tech
 * Spec #3459 "Postinstall safety", Feature #3461): it MUST exit 0 even when
 * the sync fails, so that `--ignore-scripts` installs, sandboxed CI, or a
 * transient copy error degrade to the `mandrel doctor`-detected
 * "not materialized" state rather than failing the consumer's install.
 *
 * On any failure it logs a single actionable hint — "run `mandrel sync`" —
 * and exits 0. It performs nothing beyond the local file copy that
 * `mandrel sync` itself does: no network, no shell, no writes outside
 * `./.agents/`.
 *
 * Injectable seams (used by bin/__tests__/postinstall.test.js):
 *   - `sync`      — replaces the real `runSync` from lib/cli/sync.js
 *   - `writeErr`  — replaces process.stderr.write
 *   - `exit`      — replaces process.exit
 */

import { runSync } from '../lib/cli/sync.js';

const HINT =
  'mandrel: could not materialize ./.agents/ during install — run `mandrel sync` to finish setup.\n';

/**
 * Run the materializer, swallowing any failure into an exit-0 hint.
 *
 * `runSync` calls its injected `exit` with a non-zero code when the package
 * is not resolvable (the common `--ignore-scripts`-adjacent failure). We
 * intercept that here instead of letting it propagate to `process.exit`,
 * and we also catch any thrown error (e.g. a mid-copy filesystem fault), so
 * the postinstall lifecycle can never fail the consumer's `npm install`.
 *
 * @param {{
 *   sync?: typeof runSync,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [opts]
 * @returns {{ exitCode: number, hinted: boolean }} Outcome (also returned for
 *   testability; the process always exits 0).
 */
export function runPostinstall({
  sync = runSync,
  writeErr = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
} = {}) {
  let syncFailed = false;
  try {
    // No argv is forwarded: the install-time materialization is a plain,
    // overwrite-in-place copy. The `mandrel sync` tokens in the package.json
    // `postinstall` string document intent (and are what the hint points
    // operators at); they are not flags this hook needs to honor.
    sync({
      // Best-effort: never let sync's own non-zero exit terminate the
      // install. Record the failure and fall through to the exit-0 hint.
      exit: (code) => {
        if (code !== 0) syncFailed = true;
      },
    });
  } catch {
    syncFailed = true;
  }

  if (syncFailed) {
    writeErr(HINT);
  }

  // Always succeed: the install must not fail on a best-effort sync.
  exit(0);
  return { exitCode: 0, hinted: syncFailed };
}

// Run when invoked directly as the postinstall hook (not when imported by a
// test). `process.argv[1]` is the resolved path to this file under npm.
const invokedDirectly = process.argv[1]?.endsWith('postinstall.js');
if (invokedDirectly) {
  runPostinstall();
}
