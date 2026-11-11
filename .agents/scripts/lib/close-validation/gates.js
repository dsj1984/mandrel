/** Close-validation gate list construction and parallel/serial partitioning. */

import { existsSync } from 'node:fs';

import { _internals as baselineReaderInternals } from '../baselines/reader.js';
import {
  getChangedFiles,
  remoteBaseRef,
  resolveCaptureBaseRef,
} from '../changed-files.js';
import {
  COVERAGE_GATE_DEFAULTS,
  getQuality,
  resolveQuality,
} from '../config/quality.js';
import { filterFilesUnderTargets } from '../coverage-capture.js';
import {
  isCaptureActive,
  primaryCaptureSource,
} from '../coverage-capture-passes.js';
import { hasNpmScript, readPackageScripts } from '../npm-scripts.js';
import { KNOWN_KINDS } from '../orchestration/check-baselines/phases/parse-args.js';
import { predictsTestEvidenceCredit } from '../test-run-credit.js';
import {
  buildFormatHint,
  isDefaultFormatCheck,
  resolveFormatWriteCommand,
  resolveGateCommand,
} from './commands.js';
import { closeTestGate, closeTestScope } from './skip-branch-test.js';

/**
 * @typedef {Object} Gate
 * @property {string}   name
 * @property {string}   cmd
 * @property {string[]} args
 * @property {string}   [hint] - Remediation hint shown on failure.
 * @property {{ baseRef: string }} [changedFileScope]
 * @property {{ reason: string }} [skip] - Pre-decided skip: recorded, never spawned.
 * @property {Record<string, string>} [env] - Overlay merged over `process.env` for this gate's child only.
 * @property {boolean} [lockEventChannel] - The child reports on close's lock-event channel.
 * @property {boolean} [deferOnOverBudget] - An exit 76 defers to CI instead of failing.
 * @property {{ ciRatchetCheck: string|null }} [suiteOfRecordCi] - Deferred to CI without spawning; fails when no check is declared.
 * @property {boolean} [readsCoverageArtifact] - Skipped once a suite gate deferred.
 * @property {{ reason: string, checks: string[] }} [ciDeferred] - Deferred to the named CI checks without spawning.
 * @property {{ cmd: string, args: string[] }} [evidenceIdentity] - Evidence argv, if not the spawned one.
 * @property {{ scope: 'delta', since: string }} [evidenceNote]
 * @property {string} [label]
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
 * regression; matches the attribution and auto-refresh bases. A skipped
 * base sync passes the merge-base as `baselineRef`: the branch lacks main's
 * later baseline moves. `null` keeps the gate's default ref.
 *
 * @param {string|undefined|null} baseBranch
 * @param {string} [baselineRef]
 * @returns {{ BASELINE_REF: string } | null}
 */
function buildBaselinesGateEnv(baseBranch, baselineRef) {
  if (baselineRef) return { BASELINE_REF: baselineRef };
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
export function isCrapGateEnabled(config) {
  if (!config || typeof config !== 'object') return true;
  const enabled = config?.delivery?.quality?.gates?.crap?.enabled;
  return typeof enabled === 'boolean' ? enabled : true;
}

/**
 * Resolves only the two gates capture reads, so a broken sibling gate block
 * is left to the baselines partition's own fail-closed path.
 *
 * @param {object|undefined|null} config - Canonical resolved config.
 */
function captureQuality(config) {
  const gates = config?.delivery?.quality?.gates ?? {};
  const { crap, coverage } = gates;
  return resolveQuality({ gates: { crap, coverage } });
}

/**
 * What a suite's over-budget exit (76) — the capture's or `test`'s — means here and in the handoff.
 *
 * @param {object|undefined|null} config - Canonical resolved config.
 * @returns {'block'|'defer-to-ci'}
 */
export function overBudgetPolicy(config) {
  return captureQuality(config).coverage.onOverBudget;
}

/** @param {object|undefined|null} config @returns {{ deferOnOverBudget?: true }} */
function overBudgetFlag(config) {
  return overBudgetPolicy(config) === 'defer-to-ci'
    ? { deferOnOverBudget: true }
    : {};
}

/**
 * Is CI the suite of record here? Under it the capture is deferred before
 * anything spawns, and `ciRatchetCheck` names the CI check that ratchets.
 *
 * @param {object|undefined|null} config - Canonical resolved config.
 * @returns {{ ci: boolean, ciRatchetCheck: string|null }}
 */
export function suiteOfRecord(config) {
  const { suiteOfRecord: posture, ciRatchetCheck } =
    captureQuality(config).coverage;
  return { ci: posture === 'ci', ciRatchetCheck };
}

/** @param {object|undefined|null} config @returns {{ suiteOfRecordCi?: { ciRatchetCheck: string|null } }} */
function suiteOfRecordFlag(config) {
  const { ci, ciRatchetCheck } = suiteOfRecord(config);
  return ci ? { suiteOfRecordCi: { ciRatchetCheck } } : {};
}

/** Shown when `suiteOfRecord: "ci"` has no ratchet check to hand the ratchet to. */
export const CI_RATCHET_UNDECLARED_HINT =
  '`delivery.quality.gates.coverage.suiteOfRecord: "ci"` defers the coverage capture to CI, but `delivery.quality.gates.coverage.ciRatchetCheck` is unset, so nothing would ratchet coverage or CRAP. Name the CI check that runs `coverage-ratchet.js`, or set `suiteOfRecord` back to `"local"`.';

/** Skip reason for a gate that would read the artifact a deferral never wrote. */
export const COVERAGE_DEFERRED_SKIP_REASON = 'coverage-deferred-ci';

/** Shown when a suite gate (the capture or `test`) exits 76 and the policy blocks. */
export const OVER_BUDGET_BLOCK_HINT =
  'The suite declared its slice over this host\'s budget (exit 76) and ran no tests. Run the delivery on a larger host, or — when CI runs the suite with a coverage floor — set `delivery.quality.gates.coverage.onOverBudget: "defer-to-ci"`.';

/**
 * Coverage-capture registers when the coverage or CRAP gate is on AND the
 * primary capture script exists (the coverage gate's `captureScript`, or an
 * own CRAP source's); {@link resolveCreditedDepositor} builds on it.
 *
 * @param {object|undefined|null} config - Canonical resolved config.
 * @param {Record<string, string>|null|undefined} scripts - `package.json` scripts.
 * @returns {boolean}
 */
function isCoverageCaptureActive(config, scripts) {
  const { crap, coverage } = captureQuality(config);
  return isCaptureActive({
    crap,
    coverage,
    scripts,
    hasNpmScriptImpl: hasNpmScript,
  });
}

/**
 * The plain `test` gate, unless coverage-capture will run the suite — every
 * close must keep exactly one working test gate. Its argv is
 * `project.commands.test` (default `npm test`); after a base move close's
 * phase may swap it for the delta re-credit (`test-delta.js`), which runs
 * `testChanged` keyed on `MANDREL_CHANGED_SINCE`.
 *
 * @param {boolean} coverageCaptureRunsSuite
 * @param {object|undefined|null} config - Canonical resolved config.
 * @returns {Gate[]}
 */
function buildTestGateEntry(coverageCaptureRunsSuite, config, scope) {
  if (coverageCaptureRunsSuite) return [];
  // `fullSuiteLock` serializes this suite behind the host lock; when
  // coverage-capture runs instead, `runCapture` takes the lock itself.
  return [{ ...closeTestGate(config, scope), ...overBudgetFlag(config) }];
}

const CHECK_BASELINES_HINT =
  'Unified baselines gate breached. Inspect the JSON report (`node .agents/scripts/check-baselines.js`) to see which kind/component/axis fell below floor; remediate the underlying file(s) or — when the regression is intentional — refresh the relevant baseline through its per-kind update script and commit with a `baseline-refresh:` tagged subject.';

/**
 * A failed gate whose hint quotes the baselines rows it printed; unchanged
 * (its fixed hint) when none was retained.
 *
 * @param {Gate} gate
 * @param {string[]} [rows]
 * @returns {Gate}
 */
export function withFailureRows(gate, rows) {
  if (!rows?.length) return gate;
  const hint = `Baselines gate failed: ${rows.join('; ')} — full report: node .agents/scripts/check-baselines.js --format json`;
  return { ...gate, hint };
}

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
/**
 * The unsplit gate (`null` kinds) scores every kind, coverage ones included.
 *
 * @param {string[]|null} gateKinds
 * @returns {{ readsCoverageArtifact?: true }}
 */
function coverageReaderFlag(gateKinds) {
  const reads =
    gateKinds === null ||
    gateKinds.some((k) => COVERAGE_CONSUMING_KINDS.has(k));
  return reads ? { readsCoverageArtifact: true } : {};
}

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
    // A registration hint stays as-is; the fixed hint yields to quoted rows.
    retainFailureRows: !decision.hint,
    ...(env ? { env } : {}),
    ...coverageReaderFlag(gateKinds),
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
 * The pre-decided skip an explicit `project.commands.<key>: null` registers.
 *
 * @param {{ disabled: boolean }} command
 * @param {string} gateName
 * @returns {{ skip?: { reason: string } }}
 */
function disabledSkip(command, gateName) {
  return command.disabled ? { skip: { reason: `${gateName}-disabled` } } : {};
}

/**
 * Will coverage-capture take its incremental skip (no changed file under
 * `crap.targetDirs`)? If so the close would otherwise have no test gate at all.
 * Every uncertainty resolves to `false`: a wrong `false` costs one redundant
 * capture, a wrong `true` runs the suite twice. The ref comes from the
 * capture's own resolver, so the prediction and the capture score one set.
 *
 * @param {{
 *   config?: object,
 *   cwd?: string,
 *   baseBranch?: string,
 *   getChangedFilesImpl?: typeof getChangedFiles,
 *   resolveBaseRefImpl?: typeof resolveCaptureBaseRef,
 * }} opts
 * @returns {boolean}
 */
function predictsIncrementalCaptureSkip({
  config,
  cwd,
  baseBranch,
  getChangedFilesImpl = getChangedFiles,
  resolveBaseRefImpl = resolveCaptureBaseRef,
}) {
  // No cwd is the module-load `DEFAULT_GATES` case: never spawn git at import.
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  const { crap } = getQuality(config);
  if (crap?.incrementalCoverage?.skipWhenUnchanged !== true) return false;
  try {
    const { ref } = resolveBaseRefImpl({ crap, ref: null, baseBranch, cwd });
    const changed = getChangedFilesImpl({ ref, cwd });
    // Non-array is "unknown", which `filterFilesUnderTargets` would flatten to
    // `[]` and misread as a skip.
    if (!Array.isArray(changed)) return false;
    return filterFilesUnderTargets(changed, crap.targetDirs).length === 0;
  } catch {
    return false;
  }
}

/** Capture-active and not skipping → the capture deposits; else `test`. */
function depositorShape(active, skipBranch) {
  const depositor = active && !skipBranch ? 'coverage-capture' : 'test';
  return { depositor, skipBranch };
}

/**
 * The credited-run depositor, shared by close and `story-handoff.js`: a
 * predicted incremental skip runs no suite, so it is never the depositor.
 * `skipBranch` tells that `test` depositor apart from an inactive capture's.
 *
 * @param {{
 *   config?: object,
 *   scripts?: Record<string, string>|null,
 *   cwd?: string,
 *   baseBranch?: string,
 *   getChangedFilesImpl?: typeof getChangedFiles,
 *   resolveBaseRefImpl?: typeof resolveCaptureBaseRef,
 * }} opts
 * @returns {{ depositor: 'coverage-capture'|'test', skipBranch: boolean }}
 */
export function resolveCreditedDepositor({
  config,
  scripts,
  cwd,
  baseBranch,
  getChangedFilesImpl,
  resolveBaseRefImpl,
}) {
  const active = isCoverageCaptureActive(config, scripts);
  const skipBranch =
    active &&
    predictsIncrementalCaptureSkip({
      config,
      cwd,
      baseBranch,
      ...(getChangedFilesImpl ? { getChangedFilesImpl } : {}),
      resolveBaseRefImpl,
    });
  return depositorShape(active, skipBranch);
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

/**
 * Names every suite the capture can run: under `captureScope: "affected"` a
 * red may come from a delta refresh the base-sync triggered, not the Story;
 * an own CRAP source's script is named beside the coverage gate's.
 *
 * @param {object|undefined|null} config - Canonical resolved config.
 * @returns {string}
 */
function coverageCaptureHint(config) {
  const { crap, coverage } = captureQuality(config);
  const primary = primaryCaptureSource({ crap, coverage });
  const crapScript =
    primary.captureScript === coverage.captureScript
      ? ''
      : `, the CRAP gate's own \`${primary.captureScript}\` (\`gates.crap.captureScript\`)`;
  return `Coverage capture failed — its suite run (the \`${coverage.captureScript}\` script, \`gates.coverage.captureScript\`${crapScript}, or the affected capture script under \`captureScope: "affected"\`, including a delta refresh keyed on the stamped commit after a base-sync) exited non-zero. The coverage-capture log names which ran; fix the failing tests or coverage-threshold breaches, then re-run close.`;
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
export const QUALITY_PREVIEW_GATE_NAMES = Object.freeze({
  maintainability: 'quality-preview-mi',
  crap: 'quality-preview-crap',
});

/** The CRAP half reads the coverage artifact; the MI half does not. */
const PREVIEW_ARTIFACT_FLAGS = Object.freeze({
  maintainability: {},
  crap: { readsCoverageArtifact: true },
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
  const ref = remoteBaseRef(baseBranch || 'main');
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
      ...PREVIEW_ARTIFACT_FLAGS[half],
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
 * quality-preview-crap] → check-baselines. Coverage-capture registers only when the coverage or CRAP gate is
 * enabled AND its capture script (`gates.coverage.captureScript`) exists; it then carries test-failure signalling and
 * the plain `test` gate is dropped, so there is always exactly one test gate.
 *
 * @param {{ config?: object, baseBranch?: string, baselineRef?: string, cwd?: string, packageScripts?: Record<string, string>, presentBaselines?: string[]|Set<string>, log?: (message: string) => void, getChangedFilesImpl?: typeof getChangedFiles, resolveBaseRefImpl?: typeof resolveCaptureBaseRef }} [opts]
 *   `cwd` is where the `package.json` and baseline-presence probes read;
 *   `packageScripts` / `presentBaselines` inject those probes (tests).
 * @returns {Gate[]}
 */
export function buildDefaultGates({
  config,
  baseBranch,
  baselineRef,
  cwd,
  packageScripts,
  presentBaselines,
  log,
  getChangedFilesImpl,
  resolveBaseRefImpl,
  storyId,
  evidenceCwd,
  gitSpawnImpl,
  shouldSkipImpl,
} = {}) {
  const scripts = packageScripts ?? readPackageScripts(cwd);
  const coverageCaptureActive = isCoverageCaptureActive(config, scripts);
  // A credited `project.commands.test` run registers the plain `test` gate beside the
  // capture so the credit is reported, never re-spent.
  const testCredited = resolveTestCredited({
    coverageCaptureActive,
    config,
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
    resolveCreditedDepositor({
      config,
      scripts,
      cwd,
      baseBranch,
      getChangedFilesImpl,
      resolveBaseRefImpl,
    }).skipBranch;
  const testScope = closeTestScope({
    skipBranch: captureSkipPredicted,
    config,
    cwd,
    baseBranch,
    gitSpawnImpl,
    log,
  });
  const typecheck = resolveGateCommand(config, 'typecheck');
  const lint = resolveGateCommand(config, 'lint');
  const format = resolveGateCommand(config, 'formatCheck');
  const formatWriteString = resolveFormatWriteCommand(config);
  const formatChangedFileScope = isDefaultFormatCheck(format.raw)
    ? buildChangedFileScope(baseBranch)
    : null;
  const baselinesGateEnv = buildBaselinesGateEnv(baseBranch, baselineRef);
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
      ...disabledSkip(typecheck, 'typecheck'),
    },
    // Gate names stay generic though commands resolve from config, so the
    // log line, evidence keyspace and partition membership never shift.
    {
      name: 'lint',
      cmd: lint.cmd,
      args: lint.args,
      ...disabledSkip(lint, 'lint'),
    },
    ...buildTestGateEntry(
      coverageCaptureRunsSuite({
        coverageCaptureActive,
        captureSkipPredicted,
        testCredited,
      }),
      config,
      testScope,
    ),
    {
      name: 'format',
      cmd: format.cmd,
      args: format.args,
      hint: buildFormatHint(formatWriteString),
      ...disabledSkip(format, 'format'),
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
            hint: coverageCaptureHint(config),
            lockEventChannel: true,
            ...overBudgetFlag(config),
            ...(captureSkipPredicted
              ? { skip: { reason: 'incremental-no-crap-changes' } }
              : suiteOfRecordFlag(config)),
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
 * Does close run this gate in its concurrent bucket?
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isIndependentGate(name) {
  return INDEPENDENT_GATE_NAMES.has(name);
}

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
    // A `ciDeferred` gate is settled up front by the serial loop.
    if (isIndependentGate(gate.name) && !gate.ciDeferred)
      independent.push(gate);
    else serial.push(gate);
  }
  return { independent, serial };
}
