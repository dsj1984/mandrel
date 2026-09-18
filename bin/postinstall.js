#!/usr/bin/env node
// bin/postinstall.js — best-effort `.agents/` materializer on install.

/**
 * Runs `mandrel sync` on install. Best-effort by contract: always exits 0 so
 * `--ignore-scripts`, sandboxed CI, or a copy error degrade to the
 * doctor-detected "not materialized" state instead of failing the install.
 * In the framework's own source checkout it no-ops, since `.agents/` there is
 * the committed product and a sync would clobber it.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from '../lib/cli/sync.js';

const PACKAGE_NAME = 'mandrel';

const HINT =
  'mandrel: could not materialize ./.agents/ during install — run `mandrel sync` to finish setup.\n';

/**
 * Two signals, both biased toward running the sync:
 * 1. A `node_modules` segment in this module's own path means a dependency
 *    install — never the source repo (reading the package's own
 *    `package.json` would always say `mandrel`).
 * 2. Otherwise compare the invoking root's `package.json#name` (`INIT_CWD`,
 *    or the module-relative repo root outside npm) to `mandrel`.
 * Any read/parse error returns `false`.
 *
 * @param {{ fs?: typeof nodeFs, initCwd?: string, moduleUrl?: string }} [opts]
 * @returns {boolean} `true` when running in the `mandrel` source repo.
 */
export function isSourceCheckout({
  fs = nodeFs,
  initCwd = process.env.INIT_CWD,
  moduleUrl = import.meta.url,
} = {}) {
  try {
    const here = path.dirname(fileURLToPath(moduleUrl));
    if (here.split(path.sep).includes('node_modules')) return false;

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
 * Both a non-zero `exit` from `runSync` and a thrown error become the exit-0
 * hint. The destination is `INIT_CWD` (the consumer root), because npm runs
 * lifecycle scripts with cwd set to `node_modules/mandrel` — syncing there
 * would copy the payload onto itself.
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
  // Expected no-op in the framework repo, so no hint.
  if (detectSource()) {
    exit(0);
    return { exitCode: 0, hinted: false, skipped: true };
  }

  let syncFailed = false;
  try {
    sync({
      cwd: () => initCwd || process.cwd(),
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

  exit(0);
  return { exitCode: 0, hinted: syncFailed, skipped: false };
}

// Only when run as the hook, not when imported by a test.
const invokedDirectly = process.argv[1]?.endsWith('postinstall.js');
if (invokedDirectly) {
  runPostinstall();
}
