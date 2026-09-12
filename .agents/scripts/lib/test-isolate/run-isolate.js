/**
 * lib/test-isolate/run-isolate.js — the `test-isolate` orchestration.
 *
 * Story #5316: moved out of `.agents/scripts/test-isolate.js` (CRAP 56 at
 * cyclomatic 7, 0% coverage) so it can be driven from a test. The CLI shell
 * that remains does nothing but call this and translate the exit code.
 *
 * `resolveFiles` and `diagnose` are named seams defaulting to the real
 * implementations, per [`rules/test-seams.md`](../../../rules/test-seams.md):
 * a unit test substitutes them rather than running real suites in child
 * processes, and the production caller passes neither.
 */

import { parseIsolateArgv } from './cli-options.js';
import { resolveTestFiles as defaultResolveTestFiles } from './list-files.js';
import { createProgressLogger } from './progress-log.js';
import { renderReport } from './render-report.js';
import { diagnoseIsolation as defaultDiagnoseIsolation } from './runner.js';

/**
 * The report shape returned when no file matched the pattern — a real report
 * with nothing in it, so callers never branch on null.
 *
 * @returns {import('./runner.js').IsolateReport}
 */
function emptyReport() {
  return {
    pattern: null,
    files: [],
    isolated: [],
    suite: [],
    flippers: [],
    bisections: [],
    envMutators: [],
    durationMs: 0,
  };
}

/**
 * Run the isolation diagnosis end to end.
 *
 * Exit code is 1 when the run found anything worth an operator's attention —
 * a flipper OR an env mutator — and 0 otherwise. An empty match set is not a
 * failure: nothing was asked of the suite, so nothing can be wrong with it.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {string} [opts.repoRoot]
 * @param {(line: string) => void} [opts.onLog]
 * @param {(args: {pattern: string|undefined, repoRoot: string}) => string[]} [opts.resolveFiles]
 * @param {(args: object) => Promise<import('./runner.js').IsolateReport>} [opts.diagnose]
 * @returns {Promise<{ exitCode: number, report: import('./runner.js').IsolateReport }>}
 */
export async function runTestIsolate({
  argv = [],
  repoRoot,
  onLog = (s) => process.stdout.write(`${s}\n`),
  resolveFiles = defaultResolveTestFiles,
  diagnose = defaultDiagnoseIsolation,
} = {}) {
  const options = parseIsolateArgv(argv);
  const files = resolveFiles({ pattern: options.pattern, repoRoot });
  if (files.length === 0) {
    onLog(
      `[test-isolate] no test files matched pattern: ${options.pattern ?? '<default>'}`,
    );
    return { exitCode: 0, report: emptyReport() };
  }

  if (!options.quiet) {
    onLog(`[test-isolate] scanning ${files.length} file(s)...`);
  }
  const report = await diagnose({
    repoRoot,
    files,
    workers: options.workers,
    suiteConcurrency: options.suiteConcurrency,
    maxBisectDepth: options.maxBisectDepth,
    maxBisectTargets: options.maxBisectTargets,
    onProgress: options.quiet ? undefined : createProgressLogger(onLog),
  });

  onLog(options.json ? JSON.stringify(report, null, 2) : renderReport(report));

  const clean = report.flippers.length === 0 && report.envMutators.length === 0;
  return { exitCode: clean ? 0 : 1, report };
}
