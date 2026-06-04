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
 * **Source-checkout guard (Story #3489, fixed in #3580).** In the Mandrel
 * framework repo itself, `./.agents/` is not a regenerated working copy — it
 * *is* the committed product, and `mandrel sync` would clobber that source of
 * truth with a copy of `node_modules/@mandrelai/agents/.agents/`. Today the
 * repo `.npmrc` (`ignore-scripts=true`) masks this, but a contributor running
 * `npm install --ignore-scripts=false` (or a tool that re-enables scripts)
 * would overwrite the source tree. To make the guard intrinsic rather than
 * config-dependent, the hook detects the source checkout and no-ops (exit 0)
 * without invoking the materializer. Consumer installs (where the package is
 * a dependency under `node_modules/`) are unaffected and still materialize
 * `.agents/` as before — see `isSourceCheckout` for the two signals used to
 * tell them apart.
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
 * Two complementary, fail-safe signals — both biased toward running the sync
 * (the safe default for a consumer) — tell the two cases apart:
 *
 * 1. **`node_modules` path guard (primary).** When the package is installed as
 *    a dependency this module lives at
 *    `<consumer>/node_modules/@mandrelai/agents/bin/postinstall.js`, so its own
 *    resolved path contains a `node_modules` segment. That is true *by
 *    construction* for every dependency install and needs no env var, so a
 *    `node_modules` ancestor is treated as an unambiguous consumer install →
 *    return `false` (run the sync). This is the signal the original guard
 *    (Story #3489) was missing: it resolved the package's **own**
 *    `package.json` (always named `@mandrelai/agents`) instead of the consumer
 *    root, so it misfired on every consumer install and skipped the sync
 *    (Story #3580).
 *
 * 2. **`INIT_CWD`-rooted name check (source-repo signal).** Outside
 *    `node_modules`, resolve the **invoking project root** and compare its
 *    `package.json#name` to `@mandrelai/agents`. npm sets `INIT_CWD` to the
 *    directory where `npm install` was invoked — the framework repo root when
 *    a contributor installs the framework itself. When `INIT_CWD` is unset
 *    (e.g. the hook is run directly via `node`, outside npm), fall back to the
 *    module-relative repo root (`bin/postinstall.js` sits one directory below
 *    it), which still resolves to the source repo's own `package.json`.
 *
 * Fails safe: any read/parse error returns `false` (treat as a consumer
 * install and let the best-effort sync run), so a malformed or missing
 * `package.json` never strands a consumer without their `.agents/` payload.
 *
 * @param {{ fs?: typeof nodeFs, initCwd?: string, moduleUrl?: string }} [opts]
 * @returns {boolean} `true` when running in the `@mandrelai/agents` source repo.
 */
export function isSourceCheckout({
  fs = nodeFs,
  initCwd = process.env.INIT_CWD,
  moduleUrl = import.meta.url,
} = {}) {
  try {
    const here = path.dirname(fileURLToPath(moduleUrl));
    // Installed as a dependency → unambiguously a consumer install, regardless
    // of what any package.json#name says. Run the sync.
    if (here.split(path.sep).includes('node_modules')) return false;

    // Source checkout: resolve the invoking project root (the dir where
    // `npm install` ran) and compare its package name. Fall back to the
    // module-relative repo root when npm did not set INIT_CWD.
    const root = initCwd || path.join(here, '..');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
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
 * **Destination root (Story #3584).** `runSync` derives its destination from
 * `process.cwd()`, but npm runs a dependency's lifecycle scripts with cwd set
 * to the **package's own directory** (`node_modules/@mandrelai/agents`), not
 * the consumer project root. Left unset, the materializer would copy
 * `.agents/` back onto the package's own payload and the consumer's project
 * root would get nothing. We pass `runSync` a `cwd` resolving to `INIT_CWD` —
 * the directory where `npm install` was invoked (the consumer root) — falling
 * back to `process.cwd()` only when the hook runs outside npm (`INIT_CWD`
 * unset). This is scoped to the postinstall path: the manual `mandrel sync` /
 * `mandrel update` paths already run from the project root and keep
 * `runSync`'s default `process.cwd()` behaviour.
 *
 * @param {{
 *   sync?: typeof runSync,
 *   isSourceCheckout?: typeof isSourceCheckout,
 *   initCwd?: string,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [opts]
 * @returns {{ exitCode: number, hinted: boolean, skipped: boolean }} Outcome
 *   (also returned for testability; the process always exits 0).
 */
export function runPostinstall({
  sync = runSync,
  isSourceCheckout: detectSource = isSourceCheckout,
  initCwd = process.env.INIT_CWD,
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
      // Resolve the destination from INIT_CWD (the consumer project root,
      // where `npm install` ran), not the package dir npm makes cwd during
      // the postinstall lifecycle (Story #3584). Fall back to process.cwd()
      // outside npm, when INIT_CWD is unset.
      cwd: () => initCwd || process.cwd(),
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
