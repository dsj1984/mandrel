#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * test-isolate — diagnose test-pollution cascades.
 *
 * Runs the matching test files individually (`--test-concurrency=1`,
 * one process per file), then again as a single suite under default
 * concurrency. Files that pass alone but fail in the suite are
 * **flippers**. For each flipper the script binary-bisects the
 * remaining files to surface the smallest reproducing subset (the
 * polluter suspect set).
 *
 * Files whose process exited with leftover `process.env` mutations are
 * called out so an operator can spot global-state leaks at a glance —
 * even when the failure cascade hasn't yet manifested. See
 * `lib/test-isolate/env-snapshot-loader.js`.
 *
 * Usage:
 *
 *   node .agents/scripts/test-isolate.js                   # all tests
 *   node .agents/scripts/test-isolate.js 'tests/lib/**'    # glob subset
 *   node .agents/scripts/test-isolate.js tests/foo.test.js # single file
 *
 * Output: human-readable text by default; pass `--json` for the raw
 * report envelope.
 *
 * **Shell only (Story #5316).** Nothing imports this file, so nothing here is
 * reachable from a test — which is why every function it used to hold scored
 * the CRAP formula's untested maximum. Argv parsing, report rendering,
 * progress logging and the run orchestration now live under
 * `lib/test-isolate/`, beside the `list-files` / `parse-tap` / `runner`
 * modules that were always there. Keep this file a shell: anything with a
 * branch in it belongs next door, where a test can reach it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsCli } from './lib/cli-utils.js';
import { runTestIsolate } from './lib/test-isolate/run-isolate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

runAsCli(
  import.meta.url,
  async () => {
    const { exitCode } = await runTestIsolate({
      argv: process.argv.slice(2),
      repoRoot: ROOT,
    });
    if (exitCode !== 0) process.exit(exitCode);
  },
  { source: 'test-isolate' },
);
