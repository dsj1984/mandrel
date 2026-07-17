/**
 * close-validation/gates.js — Gate construction and partitioning.
 *
 * Owns the canonical close-validation gate list (`buildDefaultGates` /
 * `DEFAULT_GATES`) and the parallel-vs-serial partitioning used by the
 * runner (`INDEPENDENT_GATE_NAMES` / `partitionGates`).
 */

import { existsSync } from 'node:fs';

import { _internals as baselineReaderInternals } from '../baselines/reader.js';
import { getQuality } from '../config/quality.js';
import { hasNpmScript, readPackageScripts } from '../npm-scripts.js';
import { KNOWN_KINDS } from '../orchestration/check-baselines/phases/parse-args.js';
import {
  buildFormatHint,
  FORMAT_CHECK_FALLBACK,
  resolveFormatCheckCommand,
  resolveFormatWriteCommand,
  resolveTypecheckCommand,
} from './commands.js';

/**
 * @typedef {Object} Gate
 * @property {string}   name  - Short label used in progress logs.
 * @property {string}   cmd   - Executable to run.
 * @property {string[]} args  - Arguments passed to `cmd`.
 * @property {string}   [hint] - Remediation hint shown on failure.
 * @property {{ baseRef: string }} [changedFileScope] - Optional Story-diff scope.
 * @property {Record<string, string>} [env] - Optional per-gate environment
 *   overlay. Merged over `process.env` for this gate's spawned child only.
 *   Used to thread the epic baseRef into the `check-baselines` gate via
 *   `BASELINE_REF` (Story #3890) so baseline regressions compare against the
 *   epic integration branch rather than `origin/main`.
 * @property {(cmd: string, args: string[], opts: { cwd: string, gateName?: string, log?: (m: string) => void, signal?: AbortSignal, env?: Record<string, string> }) => Promise<{ status: number }> | { status: number }} [run]
 *   - Optional in-process runner. Story #1973: when present, the gate
 *     executes via this callable instead of spawning `cmd`/`args` through
 *     the default runner — used for per-kind baseline gates that import
 *     `compare(head, base)` directly.
 */

const TYPECHECK_HINT =
  'TypeScript regression — fix type errors on the Story branch before retrying close. If the failure is a stale generated type (e.g. wrangler types), regenerate locally and commit before the close.';

function buildChangedFileScope(baseRef) {
  if (!baseRef) return null;
  return { baseRef };
}

/**
 * Derive the per-gate `env` overlay that pins the `check-baselines`
 * regression-compare base to the close run's integration branch
 * (Story #3890).
 *
 * The baselines gate resolves its compare ref through `resolveScope`,
 * whose environment layer reads `BASELINE_REF`. Threading
 * `origin/<baseBranch>` here makes the gate diff head against the epic
 * integration branch instead of the framework-default `origin/main`, so
 * drift that already landed on `main` but is outside the Story's own diff
 * does not surface as a phantom regression. The same convention
 * (`origin/<baseBranch>`) is used by the baseline-attribution and
 * auto-refresh paths, keeping read/compare bases aligned.
 *
 * Returns `null` when no integration branch is supplied (the gate then
 * keeps its existing default-ref / consumer-config behaviour untouched).
 *
 * @param {string|undefined|null} baseBranch
 * @returns {{ BASELINE_REF: string } | null}
 */
function buildBaselinesGateEnv(baseBranch) {
  if (typeof baseBranch !== 'string' || baseBranch.length === 0) return null;
  return { BASELINE_REF: `origin/${baseBranch}` };
}

/**
 * Resolve whether the CRAP gate is enabled. When enabled, the close-
 * validation graph drops the standalone `test` gate because coverage-
 * capture already runs the suite under c8 instrumentation (Story #1798).
 *
 * Reads the single canonical shape `delivery.quality.gates.crap.enabled`
 * from the resolved config. Defaults to `true` so an omitted setting
 * matches `CRAP_GATE_DEFAULTS.enabled`. We deliberately do NOT round-trip
 * through `getQuality()` here because that resolver expects the unresolved
 * `gates.crap.*` shape.
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
 * The gates run in the Story worktree, whose `package.json` is the committed
 * one the consumer ships — the presence of a `test:coverage` script is a
 * committed fact, so probing at the gate cwd is authoritative. See
 * `lib/npm-scripts.js` for the shared reader.
 */

/**
 * Conditionally produce the standalone `test` gate entry.
 *
 * The plain `test` gate is the canonical test runner UNLESS the
 * coverage-capture gate is taking that role — which happens only when the
 * CRAP gate is enabled (Story #1798) AND the consumer actually ships a
 * `test:coverage` script for coverage-capture to run (#4473). When CRAP is
 * enabled but `test:coverage` is absent, coverage-capture is dropped from
 * the gate list, so the `test` gate MUST come back — otherwise the consumer
 * has NO working test gate at all. Splitting this out keeps
 * `buildDefaultGates` flat for the CRAP-cyclomatic gate.
 *
 * @param {boolean} coverageCaptureActive - Whether the coverage-capture gate
 *   is registered as the test runner for this build.
 * @returns {Gate[]}
 */
function buildTestGateEntry(coverageCaptureActive) {
  if (coverageCaptureActive) return [];
  return [{ name: 'test', cmd: 'npm', args: ['test'] }];
}

const CHECK_BASELINES_HINT =
  'Unified baselines gate breached. Inspect the JSON report (`node .agents/scripts/check-baselines.js`) to see which kind/component/axis fell below floor; remediate the underlying file(s) or — when the regression is intentional — refresh the relevant baseline through its per-kind update script and commit with a `baseline-refresh:` tagged subject.';

/**
 * Baseline kinds the resolved config enables for the unified
 * `check-baselines` gate. Mirrors `selectEnabledGates` in the check-baselines
 * pipeline (a kind runs when its `gates.<kind>` block is present and not
 * explicitly disabled) so the registration probe's view of "what will run"
 * matches the gate's own view exactly.
 *
 * @param {object|undefined|null} config canonical resolved config
 * @returns {string[]}
 */
function enabledBaselineKinds(config) {
  const gates = getQuality(config)?.gates ?? {};
  return KNOWN_KINDS.filter((kind) => {
    const block = gates[kind];
    return block && typeof block === 'object' && block.enabled !== false;
  });
}

/**
 * Whether the consumer opted into fail-closed baseline enforcement via
 * `delivery.quality.requireBaselines: true`. Default false — a consumer that
 * enables baseline gates but has not committed baseline artifacts gets a
 * clean skip (see `probeBaselinesGate`) rather than a deterministic first-try
 * close failure. Fail-closed baseline posture (#4495).
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
 * Probe whether the `check-baselines` consumer contract is satisfied before
 * registering the gate (#4495 — mirrors the #4473/#4480 coverage-capture
 * remedy). The contract: every enabled baseline kind carries a committed
 * baseline artifact on disk (the same path the gate's reader resolves).
 *
 * Decision shape:
 *   - `{ register: false, reason }` — skip (caller logs the reason). Baseline
 *     gates ARE enabled but none of the enabled kinds carry a committed
 *     baseline artifact and the consumer has not set `requireBaselines`. This
 *     is the bench/greenfield case: the gate would otherwise fail
 *     deterministically on first try reading a non-existent
 *     `baselines/<kind>.json`.
 *   - `{ register: true }` — at least one committed baseline artifact is
 *     present, OR no baseline kinds are enabled at all (the gate then self-
 *     skips every kind and exits a clean empty PASS — no failure to avoid, so
 *     the gate stays registered exactly as pre-#4495); run the gate.
 *   - `{ register: true, hint }` — baselines are required-by-config
 *     (`requireBaselines: true`) but absent; keep the gate registered so it
 *     fails, with a preflight hint naming the fix.
 *
 * @param {{ config?: object, cwd?: string, presentBaselines?: string[]|Set<string> }} opts
 *   `presentBaselines` injects the set of kinds whose baseline artifact
 *   exists (tests), short-circuiting the on-disk probe.
 * @returns {{ register: boolean, reason?: string, hint?: string }}
 */
function probeBaselinesGate({ config, cwd, presentBaselines } = {}) {
  const enabled = enabledBaselineKinds(config);
  if (enabled.length === 0) {
    // No enabled baseline kinds → `check-baselines.js` self-skips every kind
    // and exits clean (an empty PASS). There is no deterministic-failure risk
    // to avoid, so keep the gate registered exactly as it was pre-#4495; the
    // #4495 skip is confined strictly to the read-miss-would-fail case below.
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
 * Build the canonical close-validation gate list.
 *
 * Ordering (cheapest fast-fail first): typecheck → lint → [test] →
 * format → [coverage-capture] → check-baselines. The standalone `test`
 * gate is dropped when coverage-capture is the active test runner — i.e.
 * `crap.enabled === true` (Story #1798) AND a `test:coverage` script
 * exists (Story #4473) — because coverage-capture then carries
 * test-failure signalling under c8. When CRAP is on but `test:coverage` is
 * absent, coverage-capture is dropped and the `test` gate is restored so
 * there is always a working test gate.
 *
 * `typecheck` is mandatory; consumers may customise the command via
 * `project.commands.typecheck` (default `npm run typecheck`).
 *
 * Story #2210 retired the legacy per-kind in-process regression gates
 * (`check-maintainability`, `check-crap`, `check-mutation`) and their
 * shared in-process runner. The unified `check-baselines` gate is now the
 * single source of truth for per-kind regression enforcement
 * (attribution-wired floor + tolerance + schema).
 * The `baseBranch` parameter threads the close run's integration branch
 * into two gates: the `format` gate's `changedFileScope` (existing) and —
 * since Story #3890 — the `check-baselines` gate's `BASELINE_REF` env, so
 * the baselines regression compare diffs head against the epic integration
 * branch (`origin/<baseBranch>`) rather than the framework-default
 * `origin/main`. Without this, every child Story on an `epic/<id>` branch
 * re-discovered inherited main-vs-epic drift in untouched files as phantom
 * regressions and worked around it by hand-setting `BASELINE_REF`.
 *
 * Story #4473 — the coverage-capture gate spawns `npm run test:coverage`,
 * so it is registered ONLY when the consumer actually ships that script.
 * When CRAP is enabled but `test:coverage` is absent, coverage-capture is
 * dropped and the plain `test` gate is restored (see `buildTestGateEntry`),
 * so a consumer without a coverage script gets a working degraded test gate
 * instead of a deterministic close failure with no test gate at all. The
 * probe reads `package.json` at `cwd` (the gate execution directory).
 *
 * Story #4495 — the unified `check-baselines` gate reads a committed
 * `baselines/<kind>.json` for each enabled kind; a consumer that enables
 * baseline gates but ships no `baselines/` tree (every bench sandbox, any
 * greenfield consumer) failed the gate deterministically on first try. The
 * gate is now registered only when its consumer contract is satisfied
 * (`probeBaselinesGate`): at least one enabled kind carries a committed
 * baseline, OR the consumer opted into fail-closed enforcement via
 * `delivery.quality.requireBaselines`. When no baselines are committed and
 * none are required, the gate is skipped with a logged reason (via `log`)
 * instead of a blocking failure.
 *
 * @param {{ config?: object, baseBranch?: string, cwd?: string, packageScripts?: Record<string, string>, presentBaselines?: string[]|Set<string>, log?: (message: string) => void }} [opts]
 *   `config` is the canonical resolved config (`{ project, delivery, ... }`);
 *   gate commands resolve from `project.commands` and the CRAP toggle from
 *   `delivery.quality.gates.crap.enabled`. `baseBranch` is the close run's
 *   integration branch (`epic/<id>` for Epic-attached Stories, the base
 *   branch for standalone Stories). `cwd` is where the `package.json`
 *   coverage-script probe and the `baselines/<kind>.json` presence probe
 *   read from (defaults to `process.cwd()`); `packageScripts` injects the
 *   scripts map directly (tests) and short-circuits the coverage-script disk
 *   read; `presentBaselines` injects the set of kinds whose baseline artifact
 *   exists (tests) and short-circuits the baseline-presence disk read; `log`
 *   receives the skip reason when the `check-baselines` gate is not
 *   registered.
 * @returns {Gate[]}
 */
export function buildDefaultGates({
  config,
  baseBranch,
  cwd,
  packageScripts,
  presentBaselines,
  log,
} = {}) {
  const scripts = packageScripts ?? readPackageScripts(cwd);
  const coverageCaptureActive =
    isCrapGateEnabled(config) && hasNpmScript(scripts, 'test:coverage');
  const typecheckCmdString = resolveTypecheckCommand(config);
  const [typecheckCmd, ...typecheckArgs] = typecheckCmdString
    .split(/\s+/)
    .filter(Boolean);
  const formatCheckString = resolveFormatCheckCommand(config);
  const [formatCmd, ...formatArgs] = formatCheckString
    .split(/\s+/)
    .filter(Boolean);
  const formatWriteString = resolveFormatWriteCommand(config);
  const formatChangedFileScope =
    formatCheckString === FORMAT_CHECK_FALLBACK
      ? buildChangedFileScope(baseBranch)
      : null;
  const baselinesGateEnv = buildBaselinesGateEnv(baseBranch);
  const baselinesDecision = probeBaselinesGate({
    config,
    cwd,
    presentBaselines,
  });
  if (!baselinesDecision.register && baselinesDecision.reason) {
    log?.(`[close-validation] ${baselinesDecision.reason}`);
  }
  return [
    {
      name: 'typecheck',
      cmd: typecheckCmd,
      args: typecheckArgs,
      hint: TYPECHECK_HINT,
    },
    { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
    ...buildTestGateEntry(coverageCaptureActive),
    {
      // Gate name kept generic ("format") so the close-orchestrator log line
      // and the per-gate phase-timer key don't shift when a repo swaps biome
      // for Prettier / dprint via `project.commands.formatCheck`. The
      // actual command and the remediation hint resolve from config.
      name: 'format',
      cmd: formatCmd,
      args: formatArgs,
      hint: buildFormatHint(formatWriteString),
      ...(formatChangedFileScope
        ? { changedFileScope: formatChangedFileScope }
        : {}),
    },
    ...(coverageCaptureActive
      ? [
          {
            name: 'coverage-capture',
            cmd: 'node',
            args: ['.agents/scripts/coverage-capture.js'],
            hint: 'Coverage capture failed — `npm run test:coverage` exited non-zero. Fix failing tests or coverage-threshold breaches, then re-run close.',
          },
        ]
      : []),
    // Story #2210 — unified `check-baselines` gate is the only path for
    // per-kind regression enforcement. The legacy per-kind in-process gates
    // were retired because their regression-compare semantics are fully
    // subsumed by this gate's attribution-wired floor + tolerance + schema
    // enforcement, and running both paths in series was redundant and
    // conflict-prone.
    //
    // `check-baselines.js` self-skips per-kind gates whose `enabled === false`
    // is configured. Story #4495: it is now also skipped entirely when the
    // consumer enables baseline gates but ships no committed baseline artifact
    // (and has not set `delivery.quality.requireBaselines`) — otherwise the
    // gate fails deterministically on first try reading a non-existent
    // `baselines/<kind>.json` (`probeBaselinesGate`). When required-by-config
    // but absent, it stays registered with a preflight hint naming the fix.
    ...(baselinesDecision.register
      ? [
          {
            name: 'check-baselines',
            cmd: 'node',
            args: ['.agents/scripts/check-baselines.js', '--format', 'text'],
            hint: baselinesDecision.hint ?? CHECK_BASELINES_HINT,
            ...(baselinesGateEnv ? { env: baselinesGateEnv } : {}),
          },
        ]
      : []),
  ];
}

/**
 * Default gate list resolved with no consumer config — uses the
 * `npm run typecheck` fallback for the typecheck gate. Call sites that have a
 * resolved config object in scope (e.g. `single-story-close.js`) should
 * prefer `buildDefaultGates({ config })` so a configured
 * `project.commands.typecheck` is honoured.
 *
 * @type {Gate[]}
 */
export const DEFAULT_GATES = buildDefaultGates();

/**
 * Gates whose I/O is read-only against the working tree (no shared mutable
 * state, no overlapping ports/sockets). Safe to run concurrently — see
 * `runCloseValidation` for the Promise.all + AbortController plumbing.
 */
export const INDEPENDENT_GATE_NAMES = new Set(['lint', 'format', 'typecheck']);

/**
 * Partition a gate list into the parallel-safe set and the order-sensitive
 * remainder. Order is preserved within each bucket so the serial walk stays
 * cheapest-fast-fail-first (test → coverage-capture → check-baselines).
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
