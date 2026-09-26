/** Close-validation gate list construction and parallel/serial partitioning. */

import { existsSync } from 'node:fs';

import { _internals as baselineReaderInternals } from '../baselines/reader.js';
import { getChangedFiles } from '../changed-files.js';
import { COVERAGE_GATE_DEFAULTS, getQuality } from '../config/quality.js';
import { filterFilesUnderTargets } from '../coverage-capture.js';
import { hasNpmScript, readPackageScripts } from '../npm-scripts.js';
import { KNOWN_KINDS } from '../orchestration/check-baselines/phases/parse-args.js';
import { predictsTestEvidenceCredit } from '../test-run-credit.js';
import {
  buildFormatHint,
  FORMAT_CHECK_FALLBACK,
  resolveFormatCheckCommand,
  resolveFormatWriteCommand,
  resolveLintCommand,
  resolveTypecheckCommand,
} from './commands.js';

/**
 * @typedef {Object} Gate
 * @property {string}   name
 * @property {string}   cmd
 * @property {string[]} args
 * @property {string}   [hint] - Remediation hint shown on failure.
 * @property {{ baseRef: string }} [changedFileScope]
 * @property {{ reason: string }} [skip] - Pre-decided skip: recorded, never spawned.
 * @property {Record<string, string>} [env] - Overlay merged over `process.env` for this gate's child only.
 * @property {(cmd: string, args: string[], opts: { cwd: string, gateName?: string, log?: (m: string) => void, signal?: AbortSignal, env?: Record<string, string> }) => Promise<{ status: number }> | { status: number }} [run]
 *   - In-process runner used instead of spawning `cmd`/`args`.
 */

const TYPECHECK_HINT =
  'TypeScript regression — fix type errors on the Story branch before retrying close. If the failure is a stale generated type (e.g. wrangler types), regenerate locally and commit before the close.';

function buildChangedFileScope(baseRef) {
  if (!baseRef) return null;
  return { baseRef };
}

/**
 * Pin the `check-baselines` compare base to `origin/<baseBranch>` via
 * `BASELINE_REF`, so drift outside the Story's diff is not a phantom
 * regression; matches the attribution and auto-refresh bases. `null` keeps
 * the gate's default ref.
 *
 * @param {string|undefined|null} baseBranch
 * @returns {{ BASELINE_REF: string } | null}
 */
function buildBaselinesGateEnv(baseBranch) {
  if (typeof baseBranch !== 'string' || baseBranch.length === 0) return null;
  return { BASELINE_REF: `origin/${baseBranch}` };
}

/**
 * Defaults to `true` (matches `CRAP_GATE_DEFAULTS.enabled`). Not routed
 * through `getQuality()`, which expects the unresolved `gates.crap.*` shape.
 *
 * @param {object|undefined|null} config - Canonical resolved config.
 * @returns {boolean}
 */
function isCrapGateEnabled(config) {
  if (!config || typeof config !== 'object') return true;
  const enabled = config?.delivery?.quality?.gates?.crap?.enabled;
  return typeof enabled === 'boolean' ? enabled : true;
}

/**
 * The plain `test` gate, unless coverage-capture will run the suite — every
 * close must keep exactly one working test gate.
 *
 * @param {boolean} coverageCaptureRunsSuite
 * @returns {Gate[]}
 */
function buildTestGateEntry(coverageCaptureRunsSuite) {
  if (coverageCaptureRunsSuite) return [];
  // `fullSuiteLock` serializes this suite behind the host lock; when
  // coverage-capture runs instead, `runCapture` takes the lock itself.
  return [{ name: 'test', cmd: 'npm', args: ['test'], fullSuiteLock: true }];
}

const CHECK_BASELINES_HINT =
  'Unified baselines gate breached. Inspect the JSON report (`node .agents/scripts/check-baselines.js`) to see which kind/component/axis fell below floor; remediate the underlying file(s) or — when the regression is intentional — refresh the relevant baseline through its per-kind update script and commit with a `baseline-refresh:` tagged subject.';

/**
 * Baselines gate names. `single` is the unsplit fail-closed fallback;
 * `independent` runs in the parallel partition, `coverage` stays serial
 * behind coverage-capture. Every name MUST be in the `gateName` enum of
 * `validation-evidence.schema.json`.
 */
export const BASELINES_GATE_NAMES = Object.freeze({
  single: 'check-baselines',
  independent: 'check-baselines-independent',
  coverage: 'check-baselines-coverage',
});

/** Kinds that read the coverage-capture artifact and so must wait for it. */
const COVERAGE_CONSUMING_KINDS = new Set(['coverage', 'crap']);

/**
 * Enabled baseline kinds, mirroring `selectEnabledGates` in check-baselines.
 * `null` means unresolvable; callers MUST fall back to the single unsplit gate.
 *
 * @param {object|undefined|null} config canonical resolved config
 * @returns {string[]|null}
 */
function enabledBaselineKinds(config) {
  try {
    const gates = getQuality(config)?.gates ?? {};
    return KNOWN_KINDS.filter((kind) => {
      const block = gates[kind];
      return block && typeof block === 'object' && block.enabled !== false;
    });
  } catch {
    return null;
  }
}

/**
 * `delivery.quality.requireBaselines: true` opts into fail-closed enforcement.
 *
 * @param {object|undefined|null} config
 * @returns {boolean}
 */
function baselinesRequiredByConfig(config) {
  return config?.delivery?.quality?.requireBaselines === true;
}

function toKindSet(presentBaselines) {
  if (presentBaselines instanceof Set) return presentBaselines;
  if (Array.isArray(presentBaselines)) return new Set(presentBaselines);
  return new Set();
}

/**
 * Decide whether to register `check-baselines`. Skip (with `reason`) only when
 * kinds are enabled, none has a committed `baselines/<kind>.json`, and
 * baselines are not required — the gate would otherwise fail deterministically.
 * Required-but-absent stays registered with a fix `hint`; no enabled kinds
 * registers (the gate exits a clean empty PASS).
 *
 * @param {{ config?: object, cwd?: string, enabledKinds?: string[]|null, presentBaselines?: string[]|Set<string> }} opts
 *   `enabledKinds: null` (unresolvable) reads as none — the fail-closed path.
 * @returns {{ register: boolean, reason?: string, hint?: string }}
 */
function probeBaselinesGate({
  config,
  cwd,
  enabledKinds,
  presentBaselines,
} = {}) {
  const enabled = enabledKinds ?? [];
  if (enabled.length === 0) {
    return { register: true };
  }
  const injected =
    presentBaselines != null ? toKindSet(presentBaselines) : null;
  const present = enabled.filter((kind) =>
    injected
      ? injected.has(kind)
      : existsSync(baselineReaderInternals.resolveBaselinePath(kind, { cwd })),
  );
  if (present.length > 0) return { register: true };
  if (baselinesRequiredByConfig(config)) {
    return {
      register: true,
      hint:
        `Baselines are required (delivery.quality.requireBaselines) but no committed baseline artifact was found for enabled kind(s): ${enabled.join(', ')}. ` +
        'Generate the baseline(s) with the per-kind update script (e.g. `npm run crap:update`, `npm run maintainability:update`) and commit them, or unset requireBaselines to skip the gate until baselines exist.',
    };
  }
  return {
    register: false,
    reason:
      `check-baselines skipped — enabled kind(s) ${enabled.join(', ')} have no committed baseline artifact under baselines/ ` +
      'and delivery.quality.requireBaselines is not set. Commit baseline artifacts (or set requireBaselines to enforce them) to activate the gate.',
  };
}

/**
 * Fan one registration decision, `BASELINE_REF` overlay and hint out across
 * the baselines entries, so no entry can miss one. Null/empty `kinds` yields
 * ONE unfiltered `single` entry (fail closed); otherwise the non-empty
 * buckets of the split pair, each pinned to its own `--gate` list.
 *
 * @param {{ decision: { register: boolean, hint?: string }, kinds: string[]|null, env: { BASELINE_REF: string }|null }} args
 * @returns {Gate[]}
 */
function buildBaselinesGateEntries({ decision, kinds, env }) {
  if (!decision.register) return [];
  const entry = (name, gateKinds) => ({
    name,
    cmd: 'node',
    args: [
      '.agents/scripts/check-baselines.js',
      ...(gateKinds ? ['--gate', gateKinds.join(',')] : []),
      '--format',
      'text',
    ],
    hint: decision.hint ?? CHECK_BASELINES_HINT,
    ...(env ? { env } : {}),
  });
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return [entry(BASELINES_GATE_NAMES.single, null)];
  }
  const independentKinds = kinds.filter(
    (k) => !COVERAGE_CONSUMING_KINDS.has(k),
  );
  const coverageKinds = kinds.filter((k) => COVERAGE_CONSUMING_KINDS.has(k));
  return [
    ...(independentKinds.length > 0
      ? [entry(BASELINES_GATE_NAMES.independent, independentKinds)]
      : []),
    ...(coverageKinds.length > 0
      ? [entry(BASELINES_GATE_NAMES.coverage, coverageKinds)]
      : []),
  ];
}

/**
 * Whitespace split; keeps an unconfigured consumer's `commandConfigHash` stable.
 *
 * @param {string} commandString
 * @returns {{ cmd: string, args: string[] }}
 */
function splitCommand(commandString) {
  const [cmd, ...args] = commandString.split(/\s+/).filter(Boolean);
  return { cmd, args };
}

/**
 * Will coverage-capture take its incremental skip (no changed file under
 * `crap.targetDirs`)? If so the close would otherwise have no test gate at all.
 * Every uncertainty resolves to `false`: a wrong `false` costs one redundant
 * capture, a wrong `true` runs the suite twice.
 *
 * @param {{
 *   config?: object,
 *   cwd?: string,
 *   baseBranch?: string,
 *   getChangedFilesImpl?: typeof getChangedFiles,
 * }} opts
 * @returns {boolean}
 */
function predictsIncrementalCaptureSkip({
  config,
  cwd,
  baseBranch,
  getChangedFilesImpl = getChangedFiles,
}) {
  // No cwd is the module-load `DEFAULT_GATES` case: never spawn git at import.
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  const { crap } = getQuality(config);
  if (crap?.incrementalCoverage?.skipWhenUnchanged !== true) return false;
  const ref = crap.incrementalCoverage.baseRef || baseBranch;
  if (typeof ref !== 'string' || ref.length === 0) return false;
  try {
    const changed = getChangedFilesImpl({ ref, cwd });
    // Non-array is "unknown", which `filterFilesUnderTargets` would flatten to
    // `[]` and misread as a skip.
    if (!Array.isArray(changed)) return false;
    return filterFilesUnderTargets(changed, crap.targetDirs).length === 0;
  } catch {
    return false;
  }
}

/**
 * Is the `test` gate already credited? Only consulted when coverage-capture is active.
 *
 * @param {{ coverageCaptureActive: boolean } & Parameters<typeof predictsTestEvidenceCredit>[0]} opts
 * @returns {boolean}
 */
function resolveTestCredited({ coverageCaptureActive, ...probe }) {
  return coverageCaptureActive && predictsTestEvidenceCredit(probe);
}

/**
 * Does coverage-capture run the suite (so the plain `test` gate is dropped)?
 *
 * @param {{ coverageCaptureActive: boolean, captureSkipPredicted: boolean, testCredited: boolean }} opts
 * @returns {boolean}
 */
function coverageCaptureRunsSuite({
  coverageCaptureActive,
  captureSkipPredicted,
  testCredited,
}) {
  return coverageCaptureActive && !captureSkipPredicted && !testCredited;
}

const COVERAGE_CAPTURE_ARGS = Object.freeze([
  '.agents/scripts/coverage-capture.js',
]);

/**
 * The `pre-push` hook's quality preview, split at close into its two halves.
 * The MI half needs no coverage artifact, so it fails in the parallel phase;
 * the CRAP half stays serial behind coverage-capture. Every name MUST be in
 * the `gateName` enum of `validation-evidence.schema.json`.
 */
const QUALITY_PREVIEW_GATE_NAMES = Object.freeze({
  maintainability: 'quality-preview-mi',
  crap: 'quality-preview-crap',
});

const QUALITY_PREVIEW_HINTS = Object.freeze({
  maintainability:
    'Maintainability preview failed — the per-file MI check the `pre-push` hook runs, scored against the base branch. Simplify the flagged file(s), then re-run close; this gate runs before coverage-capture, so no suite was spent.',
  crap: "CRAP preview failed — the per-file CRAP check the `pre-push` hook runs, scored against the base branch and the fresh coverage artifact. Reduce the flagged methods' complexity or cover them, then re-run close; a close that skipped this gate would have died at push instead.",
});

/**
 * Replays the `pre-push` quality preview as two single-half gates, so an MI
 * breach fails close before the suite runs and a CRAP breach fails it, not
 * the push. Registered exactly when coverage-capture is.
 *
 * @param {{ coverageCaptureActive: boolean, baseBranch?: string }} opts
 * @returns {{ maintainability: Gate[], crap: Gate[] }}
 */
function buildQualityPreviewGateEntries({ coverageCaptureActive, baseBranch }) {
  if (!coverageCaptureActive) return { maintainability: [], crap: [] };
  const ref = `origin/${baseBranch || 'main'}`;
  const entry = (half, only) => [
    {
      name: QUALITY_PREVIEW_GATE_NAMES[half],
      cmd: 'node',
      args: [
        '.agents/scripts/quality-preview.js',
        '--only',
        only,
        '--changed-since',
        ref,
      ],
      hint: QUALITY_PREVIEW_HINTS[half],
    },
  ];
  return {
    maintainability: entry('maintainability', 'mi'),
    crap: entry('crap', 'crap'),
  };
}

/**
 * Shown instead of a gate's own hint when it exits `COVERAGE_TIMEOUT_EXIT_CODE`
 * — a killed suite, not a failing one.
 */
export const GATE_TIMEOUT_HINT = `The gate outran the suite timeout (\`delivery.quality.gates.coverage.timeoutMs\`, default ${COVERAGE_GATE_DEFAULTS.timeoutMs} ms — raise it for a slow or shared host) and its process group was killed — no test verdict exists. This is usually host contention (sibling suites or a peer close sharing the machine), not a failing test: re-run close once the host is quieter.`;

/**
 * Build the close-validation gate list, cheapest fast-fail first: typecheck →
 * lint → [test] → format → [quality-preview-mi] → [coverage-capture →
 * quality-preview-crap] → check-baselines. Coverage-capture registers only when CRAP is enabled AND a
 * `test:coverage` script exists; it then carries test-failure signalling and
 * the plain `test` gate is dropped, so there is always exactly one test gate.
 *
 * @param {{ config?: object, baseBranch?: string, cwd?: string, packageScripts?: Record<string, string>, presentBaselines?: string[]|Set<string>, log?: (message: string) => void, getChangedFilesImpl?: typeof getChangedFiles }} [opts]
 *   `cwd` is where the `package.json` and baseline-presence probes read;
 *   `packageScripts` / `presentBaselines` inject those probes (tests).
 * @returns {Gate[]}
 */
export function buildDefaultGates({
  config,
  baseBranch,
  cwd,
  packageScripts,
  presentBaselines,
  log,
  getChangedFilesImpl,
  storyId,
  evidenceCwd,
  gitSpawnImpl,
  shouldSkipImpl,
} = {}) {
  const scripts = packageScripts ?? readPackageScripts(cwd);
  const coverageCaptureActive =
    isCrapGateEnabled(config) && hasNpmScript(scripts, 'test:coverage');
  // A credited bare `npm test` registers the plain `test` gate beside the
  // capture so the credit is reported, never re-spent.
  const testCredited = resolveTestCredited({
    coverageCaptureActive,
    storyId,
    cwd,
    evidenceCwd,
    gitSpawnImpl,
    shouldSkipImpl,
    log,
  });
  // A predicted incremental skip registers the capture as a pre-decided skip
  // and brings the plain `test` gate back.
  const captureSkipPredicted =
    coverageCaptureActive &&
    predictsIncrementalCaptureSkip({
      config,
      cwd,
      baseBranch,
      ...(getChangedFilesImpl ? { getChangedFilesImpl } : {}),
    });
  if (captureSkipPredicted) {
    log?.(
      '[close-validation] coverage-capture will take the incremental skip (no changed file under the CRAP target dirs) — registering the plain `test` gate so this close still runs the suite.',
    );
  }
  const typecheck = splitCommand(resolveTypecheckCommand(config));
  const lint = splitCommand(resolveLintCommand(config));
  const formatCheckString = resolveFormatCheckCommand(config);
  const format = splitCommand(formatCheckString);
  const formatWriteString = resolveFormatWriteCommand(config);
  const formatChangedFileScope =
    formatCheckString === FORMAT_CHECK_FALLBACK
      ? buildChangedFileScope(baseBranch)
      : null;
  const baselinesGateEnv = buildBaselinesGateEnv(baseBranch);
  const baselineKinds = enabledBaselineKinds(config);
  const baselinesDecision = probeBaselinesGate({
    config,
    cwd,
    enabledKinds: baselineKinds,
    presentBaselines,
  });
  const qualityPreview = buildQualityPreviewGateEntries({
    coverageCaptureActive,
    baseBranch,
  });
  if (!baselinesDecision.register && baselinesDecision.reason) {
    log?.(`[close-validation] ${baselinesDecision.reason}`);
  }
  return [
    {
      name: 'typecheck',
      cmd: typecheck.cmd,
      args: typecheck.args,
      hint: TYPECHECK_HINT,
    },
    // Gate names stay generic though commands resolve from config, so the
    // log line, evidence keyspace and partition membership never shift.
    { name: 'lint', cmd: lint.cmd, args: lint.args },
    ...buildTestGateEntry(
      coverageCaptureRunsSuite({
        coverageCaptureActive,
        captureSkipPredicted,
        testCredited,
      }),
    ),
    {
      name: 'format',
      cmd: format.cmd,
      args: format.args,
      hint: buildFormatHint(formatWriteString),
      ...(formatChangedFileScope
        ? { changedFileScope: formatChangedFileScope }
        : {}),
    },
    ...qualityPreview.maintainability,
    ...(coverageCaptureActive
      ? [
          {
            name: 'coverage-capture',
            cmd: 'node',
            args: [...COVERAGE_CAPTURE_ARGS],
            hint: 'Coverage capture failed — `npm run test:coverage` exited non-zero. Fix failing tests or coverage-threshold breaches, then re-run close.',
            ...(captureSkipPredicted
              ? { skip: { reason: 'incremental-no-crap-changes' } }
              : {}),
          },
        ]
      : []),
    ...qualityPreview.crap,
    ...buildBaselinesGateEntries({
      decision: baselinesDecision,
      kinds: baselineKinds,
      env: baselinesGateEnv,
    }),
  ];
}

/**
 * Config-less gate list; callers holding a config should use `buildDefaultGates({ config })`.
 *
 * @type {Gate[]}
 */
export const DEFAULT_GATES = buildDefaultGates();

/**
 * Gates that are read-only against the working tree and share no ports, so
 * they may run concurrently.
 */
const INDEPENDENT_GATE_NAMES = new Set([
  'lint',
  'format',
  'typecheck',
  BASELINES_GATE_NAMES.independent,
  QUALITY_PREVIEW_GATE_NAMES.maintainability,
]);

/**
 * Order is preserved within each bucket.
 *
 * @param {Gate[]} gates
 * @returns {{ independent: Gate[], serial: Gate[] }}
 */
export function partitionGates(gates) {
  const independent = [];
  const serial = [];
  for (const gate of gates) {
    if (INDEPENDENT_GATE_NAMES.has(gate.name)) independent.push(gate);
    else serial.push(gate);
  }
  return { independent, serial };
}
