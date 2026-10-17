/**
 * `--help` spec for `coverage-capture.js`, which must answer `--help` without
 * spawning the suite.
 */

import { respondToHelp } from './cli-usage.js';

/**
 * Wired by hand: `coverage-capture.js` does not route through `runAsCli`.
 *
 * @type {{ invocation: string, summary: string, flags: Array<[string, string]> }}
 */
const COVERAGE_CAPTURE_USAGE = {
  invocation:
    'node .agents/scripts/coverage-capture.js [--skip-when-no-crap-files] [--require-credited] [--ref <git-ref>] [--cwd <path>]',
  summary:
    'Ensure the coverage artifact (delivery.quality.gates.coverage.coveragePath) is present and fresh before the coverage and CRAP gates fire, spawning `<pm> run <delivery.quality.gates.coverage.captureScript>` under the detected package manager only when it is stale (the affected capture script, with the base ref in MANDREL_COVERAGE_BASE_REF, under delivery.quality.gates.coverage.captureScope="affected"). Writes a content-digest capture stamp beside the artifact that close-validation reads to skip a redundant re-run. When delivery.quality.gates.crap.coveragePath names its own artifact, that artifact is then refreshed full-scope with `<pm> run <delivery.quality.gates.crap.captureScript>` and stamped beside itself.',
  flags: [
    [
      '--skip-when-no-crap-files',
      'Exit 0 without capturing when no changed file under the CRAP target dirs differs from --ref.',
    ],
    [
      '--require-credited',
      'Refuse (exit 1) instead of spawning when no credited capture stamp covers this tree. An operator opt-in for one invocation; a bare invocation always runs, so the deposit path stays open.',
    ],
    [
      '--ref <git-ref>',
      'Git ref the changed-file set is computed against. Passing it wins over delivery.quality.gates.crap.incrementalCoverage.baseRef, so a caller that anchors another gate on the same ref gets one scope for both.',
    ],
    ['--cwd <path>', 'Repository root the capture runs in.'],
  ],
};

/**
 * @param {string[]} argv Full `process.argv`-shaped array.
 * @param {{ write: (s: string) => void }} [out] Defaults to `process.stdout`.
 * @returns {boolean} `true` when help was printed and the run must not proceed.
 */
export function handleCoverageCaptureHelp(argv = [], out = process.stdout) {
  return respondToHelp(argv.slice(2), COVERAGE_CAPTURE_USAGE, out);
}
