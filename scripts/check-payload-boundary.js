#!/usr/bin/env node

/**
 * CLI: payload-boundary gate (Story #5381).
 *
 * Fails when a top-level `.agents/scripts/*.js` CLI is named by no consumer
 * surface, or when any file under `.agents/` imports a module outside
 * `.agents/`. The rules and the surface definition live in
 * `lib/payload-boundary.js`; this file is the argv shell. Contributor-only
 * itself, so it lives in `scripts/` and never ships. Runs inside
 * `npm run lint` via `run-lint.js`.
 */

import path from 'node:path';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import {
  checkPayloadBoundary,
  renderPayloadBoundaryReport,
} from './lib/payload-boundary.js';

const HELP = {
  invocation: 'node scripts/check-payload-boundary.js [--cwd <dir>]',
  summary:
    'Keep contributor tooling out of the .agents payload: every top-level .agents/scripts CLI must be named by a consumer surface, and nothing under .agents/ may import from outside it.',
  flags: [['--cwd <dir>', 'Repository root to check. Default: process.cwd().']],
  notes: [
    'Exit codes:\n  0  clean\n  1  an unnamed CLI or an escaping import; each is printed',
  ],
};

/**
 * @param {string[]} argv
 * @returns {{ cwd: string }}
 */
export function parseArgs(argv) {
  const at = argv.indexOf('--cwd');
  return { cwd: path.resolve(at === -1 ? process.cwd() : argv[at + 1]) };
}

runAsCli(
  import.meta.url,
  async () => {
    const { cwd } = parseArgs(process.argv.slice(2));
    const report = checkPayloadBoundary({ repoRoot: cwd });
    process.stdout.write(renderPayloadBoundaryReport(report));
    if (report.unnamed.length > 0 || report.escapes.length > 0) {
      process.exitCode = 1;
    }
  },
  { source: 'payload-boundary', usage: HELP },
);
