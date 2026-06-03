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
 * **Source-checkout guard (Story #3489).** In the Mandrel framework repo
 * itself, `./.agents/` is not a regenerated working copy — it *is* the
 * committed product, and `mandrel sync` would clobber that source of truth
 * with a copy of `node_modules/@mandrelai/agents/.agents/`. Today the repo
 * `.npmrc` (`ignore-scripts=true`) masks this, but a contributor running
 * `npm install --ignore-scripts=false` (or a tool that re-enables scripts)
 * would overwrite the source tree. To make the guard intrinsic rather than
 * config-dependent, the hook detects the source checkout — the repo whose
 * root `package.json#name` is `@mandrelai/agents` — and no-ops (exit 0)
 * without invoking the materializer. Consumer installs (where the package is
 * a dependency under a differently-named root `package.json`) are unaffected
 * and still materialize `.agents/` as before.
 *
 * Injectable seams (used by tests/cli/postinstall.test.js):
 *   - `sync`             — replaces the real `runSync` from lib/cli/sync.js
 *   - `isSourceCheckout` — replaces the source-checkout detector
 *   - `writeErr`         — replaces process.stderr.write
 *   - `exit`             — replaces process.exit
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from '../lib/cli/sync.js';

const PACKAGE_NAME = '@mandrelai/agents';

const HINT =
  'mandrel: could not materialize ./.agents/ during install — run `mandrel sync` to finish setup.\n';

/**
 * Detect whether this hook is running inside the Mandrel framework source
 * checkout (as opposed to a consumer project that depends on the package).
 *
 * The signal is the **repo-root** `package.json#name`: in the source repo it
 * is `@mandrelai/agents`; in a consumer project it is the consumer's own
 * package name (and `@mandrelai/agents` lives under `node_modules/` instead).
 * We resolve the root from this module's own location (`bin/postinstall.js`
 * sits one directory below the repo root), not from `process.cwd()`, so the
 * detection is stable regardless of where npm invokes the hook from.
 *
 * Fails safe: any read/parse error returns `false` (treat as a consumer
 * install and let the best-effort sync run), so a malformed or missing
 * `package.json` never strands a consumer without their `.agents/` payload.
 *
 * @param {{ fs?: typeof nodeFs, moduleUrl?: string }} [opts]
 * @returns {boolean} `true` when running in the `@mandrelai/agents` source repo.
 */
export function isSourceCheckout({
  fs = nodeFs,
  moduleUrl = import.meta.url,
} = {}) {
  try {
    const here = path.dirname(fileURLToPath(moduleUrl));
    const pkgPath = path.join(here, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg?.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Run the materializer, swallowing any failure into an exit-0 hint.
 *
 * When invoked inside the framework source checkout the hook short-circuits
 * to a clean exit 0 *before* touching the materializer (Story #3489), so the
 * committed `.agents/` source is never overwritten — even under
 * `--ignore-scripts=false`.
 *
 * `runSync` calls its injected `exit` with a non-zero code when the package
 * is not resolvable (the common `--ignore-scripts`-adjacent failure). We
 * intercept that here instead of letting it propagate to `process.exit`,
 * and we also catch any thrown error (e.g. a mid-copy filesystem fault), so
 * the postinstall lifecycle can never fail the consumer's `npm install`.
 *
 * @param {{
 *   sync?: typeof runSync,
 *   isSourceCheckout?: typeof isSourceCheckout,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [opts]
 * @returns {{ exitCode: number, hinted: boolean, skipped: boolean }} Outcome
 *   (also returned for testability; the process always exits 0).
 */
export function runPostinstall({
  sync = runSync,
  isSourceCheckout: detectSource = isSourceCheckout,
  writeErr = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
} = {}) {
  // Source-checkout guard (Story #3489): never materialize over the
  // framework's own committed `.agents/` source. No hint — this is the
  // expected, correct no-op in the framework repo, not a degraded state.
  if (detectSource()) {
    exit(0);
    return { exitCode: 0, hinted: false, skipped: true };
  }

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
  return { exitCode: 0, hinted: syncFailed, skipped: false };
}

// Run when invoked directly as the postinstall hook (not when imported by a
// test). `process.argv[1]` is the resolved path to this file under npm.
const invokedDirectly = process.argv[1]?.endsWith('postinstall.js');
if (invokedDirectly) {
  runPostinstall();
}
