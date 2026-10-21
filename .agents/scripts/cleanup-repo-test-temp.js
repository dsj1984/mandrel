#!/usr/bin/env node
/* node:coverage ignore file -- posttest housekeeping CLI; deletes only the reserved test-id band and runs outside the suite */

/**
 * Removes **test-reserved** per-Epic trees under `<repo>/temp/epic-<id>/` after
 * test runs. Only Epic IDs in the band declared by `lib/reserved-test-ids.js`
 * are deleted (999000–999999). Real Epic scratch (e.g. `temp/epic-1143/`) is
 * never touched.
 *
 * Keeps sibling dirs like `temp/epic-runner-logs/`, loose files, and
 * `temp/epic-<id>/` when `<id>` is outside that reserved band.
 *
 * Opt out:
 *   MANDREL_SKIP_POSTTEST_TEMP_CLEANUP=1
 *
 * Verbose line to stderr when something was removed:
 *   MANDREL_VERBOSE_TEST_TEMP_CLEANUP=1
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runAsCli } from './lib/cli-utils.js';
import { isReservedTestId } from './lib/reserved-test-ids.js';

const EPIC_TEMP_DIR = /^epic-(\d+)$/;

function isReservedTestEpicTempDirName(name) {
  const match = EPIC_TEMP_DIR.exec(name);
  return match !== null && isReservedTestId(Number(match[1]));
}

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot=process.cwd()]
 * @returns {{ skipped: boolean, removed: string[] }}
 */
export function cleanupRepoTestTempArtifacts({
  repoRoot = process.cwd(),
} = {}) {
  if (process.env.MANDREL_SKIP_POSTTEST_TEMP_CLEANUP === '1') {
    return { skipped: true, removed: [] };
  }

  const tempDir = path.join(repoRoot, 'temp');
  if (!existsSync(tempDir)) {
    return { skipped: false, removed: [] };
  }

  /** @type {string[]} */
  const removed = [];
  for (const ent of readdirSync(tempDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !isReservedTestEpicTempDirName(ent.name))
      continue;
    const full = path.join(tempDir, ent.name);
    rmSync(full, { recursive: true, force: true });
    removed.push(ent.name);
  }

  if (
    removed.length > 0 &&
    process.env.MANDREL_VERBOSE_TEST_TEMP_CLEANUP === '1'
  ) {
    const names = removed.slice().sort().join(', ');
    process.stderr.write(
      `[cleanup-repo-test-temp] removed ${removed.length} epic dir(s): ${names}\n`,
    );
  }

  return { skipped: false, removed };
}

runAsCli(import.meta.url, async () => {
  cleanupRepoTestTempArtifacts();
});
