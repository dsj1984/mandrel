/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { gateBase, SAFE_STRING } from './shared.js';

/**
 * The single home of the coverage capture literals: the script the coverage
 * gate's capture runs, the consumer-owned `affected` variant, and the
 * artifact path. Every other site imports these, never re-types them.
 */
export const COVERAGE_CAPTURE_DEFAULTS = Object.freeze({
  captureScript: 'test:coverage',
  affectedCaptureScript: 'test:coverage:affected',
  coveragePath: 'coverage/coverage-final.json',
});

/** Injected when a declared gate omits a workspace key (usually `'*'`). */
const DEFAULT_COVERAGE_FLOORS = Object.freeze({
  '*': Object.freeze({ lines: 90, branches: 85, functions: 90 }),
});

export const COVERAGE_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  baselinePath: 'baselines/coverage.json',
  tolerance: Object.freeze({ kind: 'absolute', value: 0 }),
  floors: DEFAULT_COVERAGE_FLOORS,
  coveragePath: COVERAGE_CAPTURE_DEFAULTS.coveragePath,
  captureScript: COVERAGE_CAPTURE_DEFAULTS.captureScript,
  // `affected` runs the consumer's affected capture script instead.
  captureScope: 'full',
  // On expiry `runCapture` exits 124 so callers can tell a hang from a failure.
  timeoutMs: 600_000,
});

/** Schema bounds on `coverage.timeoutMs`: one minute to two hours. */
export const COVERAGE_TIMEOUT_BOUNDS = Object.freeze({
  min: 60_000,
  max: 7_200_000,
});

export const COVERAGE_GATE = {
  type: 'object',
  description:
    'Line/branch/function coverage ratchet, read from the Istanbul JSON summary the project test run emits.',
  properties: {
    ...gateBase({
      enabled: COVERAGE_GATE_DEFAULTS.enabled,
      baselinePath: COVERAGE_GATE_DEFAULTS.baselinePath,
      tolerance: COVERAGE_GATE_DEFAULTS.tolerance,
      floors: COVERAGE_GATE_DEFAULTS.floors,
    }),
    coveragePath: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Repo-relative path to the Istanbul `coverage-final.json` the capture step writes and the gate reads. The capture contract: `captureScript` MUST write Istanbul per-file JSON (the `json` reporter) here — the coverage and CRAP refreshes both read it. A `json-summary` (`coverage-summary.json`) alone cannot feed them, so a green capture that leaves no file here fails and a full-scope refresh refuses to run. Its capture stamp sits beside it (`.capture-stamp.<file>.json`), so another artifact may share its directory.',
      default: COVERAGE_GATE_DEFAULTS.coveragePath,
    },
    captureScript: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9@:._/-]+$',
      description: `\`package.json\` script (never a shell command) the coverage gate's capture runs, spawned as \`<pm> run <script>\` under the detected package manager (npm, pnpm, yarn or bun). Close registers the coverage-capture gate when the coverage or CRAP gate is enabled and this script exists; the full-suite lock's workload identity and \`mandrel doctor\`'s \`test-credit-path\` check follow it. Default \`${COVERAGE_CAPTURE_DEFAULTS.captureScript}\`.`,
      default: COVERAGE_GATE_DEFAULTS.captureScript,
    },
    captureScope: {
      type: 'string',
      enum: ['full', 'affected'],
      description:
        `What coverage-capture runs. \`full\` (default) runs \`captureScript\`. \`affected\` runs the consumer-owned \`${COVERAGE_CAPTURE_DEFAULTS.affectedCaptureScript}\` script` +
        ' with the base ref in `MANDREL_COVERAGE_BASE_REF`, merges its rows over the prior artifact and stamps it `affected`; baseline rows the scoped run did not measure are treated as unmeasured, never removed. Falls back to `full` with a warning when the script is absent. Meant for consumers whose CI already enforces coverage on the full suite.',
      default: COVERAGE_GATE_DEFAULTS.captureScope,
    },
    timeoutMs: {
      type: 'integer',
      minimum: COVERAGE_TIMEOUT_BOUNDS.min,
      maximum: COVERAGE_TIMEOUT_BOUNDS.max,
      description:
        'Kill bound (ms) for one full-suite run — the coverage capture, the close-validation full-suite gate and the full-suite lock-wait budget all read it. The clock starts at spawn, never while queued on the host lock; a suite that signals `MANDREL_SUITE_READY_FILE` gets a fresh bound for its test phase, so worst-case wall is lock wait + 2 × timeoutMs. On expiry the run exits 124 so callers can tell a hang from a failure.',
      default: COVERAGE_GATE_DEFAULTS.timeoutMs,
    },
  },
  additionalProperties: false,
};
