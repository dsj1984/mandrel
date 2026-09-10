/**
 * coverage-capture-usage.js — the `--help` spec for `coverage-capture.js`
 * (Story #5063).
 *
 * The delivery workflow invokes `coverage-capture.js` by name
 * (`helpers/deliver-story-reference.md` § Step 1), which brings it under the
 * workflow-invoked self-description contract enforced by
 * `tests/enforcement/workflow-script-help.test.js`. It failed that contract:
 * `--help` fell through to the capture path and spawned the whole coverage
 * suite instead of describing the script.
 *
 * The spec lives here rather than inline for the same reason
 * `coverage-capture-incremental.js` does — a same-file expansion of the CLI
 * shell costs maintainability index on a file already near its floor, and a
 * usage table is data, not decision logic.
 */

import { respondToHelp } from './cli-usage.js';

/**
 * Usage spec consumed by `cli-usage.js#respondToHelp`. `coverage-capture.js`
 * does not route through `runAsCli` (its synchronous main returns an exit
 * code that `process.exit` forwards), so the help short-circuit is wired by
 * hand rather than declared on a `runAsCli` call.
 *
 * @type {{ invocation: string, summary: string, flags: Array<[string, string]> }}
 */
const COVERAGE_CAPTURE_USAGE = {
  invocation:
    'node .agents/scripts/coverage-capture.js [--skip-when-no-crap-files] [--require-credited] [--ref <git-ref>] [--cwd <path>]',
  summary:
    'Ensure coverage/coverage-final.json is present and fresh before the CRAP gate fires, spawning `npm run test:coverage` only when it is stale. Writes a content-digest capture stamp that close-validation reads to skip a redundant re-run.',
  flags: [
    [
      '--skip-when-no-crap-files',
      'Exit 0 without capturing when no changed file under the CRAP target dirs differs from --ref.',
    ],
    [
      '--require-credited',
      'Refuse (exit 1) instead of spawning when no credited capture stamp covers this tree. Passed by the close gate when delivery.execution.requireCreditedCapture is set; a bare invocation always runs, so the deposit path stays open.',
    ],
    ['--ref <git-ref>', 'Git ref the changed-file set is computed against.'],
    ['--cwd <path>', 'Repository root the capture runs in.'],
  ],
};

/**
 * Answer `--help` / `-h` on stdout, returning whether the caller should stop.
 * Takes the full `process.argv`-shaped array so the CLI shell hands over its
 * own argv unchanged and the index arithmetic lives here rather than at the
 * call site.
 *
 * @param {string[]} argv Full `process.argv`-shaped array.
 * @param {{ write: (s: string) => void }} [out] Defaults to `process.stdout`.
 * @returns {boolean} `true` when help was printed and the run must not proceed.
 */
export function handleCoverageCaptureHelp(argv = [], out = process.stdout) {
  return respondToHelp(argv.slice(2), COVERAGE_CAPTURE_USAGE, out);
}
