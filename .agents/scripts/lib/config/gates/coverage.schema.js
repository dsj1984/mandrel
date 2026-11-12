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
  // What a capture script's over-budget exit (76) means to handoff and close.
  onOverBudget: 'block',
  // `ci` makes CI the coverage and CRAP ratchet of record (a host setting).
  suiteOfRecord: 'local',
  // The consumer's CI check that runs `coverage-ratchet.js`.
  ciRatchetCheck: null,
  // Consumer-declared paths that feed no test; no built-in entries.
  nonInputGlobs: Object.freeze([]),
  captureHandlesConfigChanges: false,
  // 0 keeps the own-fix delta refresh off; N caps its own part.
  ownFixDeltaMaxFiles: 0,
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
    onOverBudget: {
      type: 'string',
      enum: ['block', 'defer-to-ci'],
      description:
        "What handoff and close do when the capture script — or the `test` command (`project.commands.test`, or `testChanged` on the skip branch and the delta re-credit) — exits 76: the consumer-declared signal that the selected slice is over this host's budget and no test ran. `block` (default) stops the handoff (`blocked`) and fails close, naming this key. `defer-to-ci` settles the coverage gate as deferred to CI: no artifact is written or stamped and no credit is recorded, the coverage-reading gates (CRAP preview, coverage and CRAP baselines) are skipped, and handoff and close proceed — the terminal envelope and the PR body say coverage was deferred. Set it only when the consumer's CI runs the deferred suite with a coverage floor. A timeout (124) is never deferred, under either value.",
      default: COVERAGE_GATE_DEFAULTS.onOverBudget,
    },
    suiteOfRecord: {
      type: 'string',
      enum: ['local', 'ci'],
      description:
        "Where the coverage capture runs. `local` (default) changes nothing. `ci` — meant for a small host's `.agentrc.local.json` — makes CI the coverage and CRAP ratchet of record: handoff and close settle the coverage gate as deferred (reason `suite-of-record-ci`) without spawning the capture, the PR body carries the `Coverage-deferred:` key line, and confirm-merge waits for `ciRatchetCheck` to go green. When `project.commands.testChanged` is set, the handoff first runs it as a changed-tests guard. Requires `ciRatchetCheck`; without it handoff blocks and close fails.",
      default: COVERAGE_GATE_DEFAULTS.suiteOfRecord,
    },
    ciRatchetCheck: {
      type: ['string', 'null'],
      minLength: 1,
      description:
        "Name of the consumer's CI check (check-run or status context) that runs `coverage-ratchet.js` on a deferred PR. Required by `suiteOfRecord: ci`; when set, confirm-merge holds `agent::done` on a PR carrying the `Coverage-deferred:` key line until this check is green on the PR head. Default `null`.",
      default: null,
    },
    nonInputGlobs: {
      type: 'array',
      items: { ...SAFE_STRING, minLength: 1 },
      description:
        "Repo-relative picomatch globs naming paths no test reads. A matching path is dropped from both sides of the coverage delta-refresh overlap check and from the re-measured set — a delta of only matching, baseline and coverage-directory paths restamps without a run — and from the overlap check of close's `test` delta re-credit (its incoming count and emptiness test are unchanged). It never changes the suite-input filter, the tree digest or stamp freshness. Default `[]`: nothing is built in, so Markdown counts as an input unless declared here.",
      default: [],
    },
    captureHandlesConfigChanges: {
      type: 'boolean',
      description:
        "Declares that the affected capture script, given `MANDREL_COVERAGE_BASE_REF`, widens its own selection when a coverage-determining config file (`package.json`, a lockfile, `tsconfig*.json`, a test-runner config) changes. When `true`, such a file in the coverage delta no longer refuses the delta refresh. Close's `test` delta re-credit refuses on a config file under either value. Default `false`.",
      default: COVERAGE_GATE_DEFAULTS.captureHandlesConfigChanges,
    },
    ownFixDeltaMaxFiles: {
      type: 'integer',
      minimum: 0,
      maximum: 50,
      description:
        "Opt-in own-fix delta refresh for `captureScope: affected`. `0` (default) keeps it off. `N >= 1` lets a delta that today's rule refuses for a Story overlap or a config file be re-measured as a delta when it splits, along HEAD's first-parent chain, into base-sync merges that pass today's rule and the Story's own non-merge commits touching at most `N` suite-input files, with no config file, no deleted or renamed suite input and no test file: a changed test moves the rows of sources mandrel cannot name, so it refuses the split. A red capture keeps the last green stamp for this split alone. Rows outside the delta can go stale in either direction; validate against full captures before raising it. `10` is a reasonable start.",
      default: COVERAGE_GATE_DEFAULTS.ownFixDeltaMaxFiles,
    },
  },
  additionalProperties: false,
};
