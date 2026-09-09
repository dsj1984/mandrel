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
  resolveLintCommand,
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
  // Story #5173 — `fullSuiteLock` marks the one gate here that spawns a whole
  // suite, so `defaultGateRunner` serializes it behind the host lock. It is
  // set on this entry alone precisely because the two full-suite gates are
  // mutually exclusive: when `coverage-capture` is registered instead, the
  // lock is taken one level down, inside `runCapture`.
  return [{ name: 'test', cmd: 'npm', args: ['test'], fullSuiteLock: true }];
}

const CHECK_BASELINES_HINT =
  'Unified baselines gate breached. Inspect the JSON report (`node .agents/scripts/check-baselines.js`) to see which kind/component/axis fell below floor; remediate the underlying file(s) or — when the regression is intentional — refresh the relevant baseline through its per-kind update script and commit with a `baseline-refresh:` tagged subject.';

/**
 * The names the unified baselines gate can register under (Story #5172).
 *
 * `single` is the unsplit entry — the historical name, and the fail-closed
 * fallback used whenever the enabled-kind set cannot be resolved into two
 * buckets. `independent` and `coverage` are the split pair: the first reads no
 * coverage artifact and therefore fails alongside `lint` / `format` /
 * `typecheck` in the parallel partition, the second consumes the artifact
 * `coverage-capture` writes and therefore stays serial behind it.
 *
 * Every name here MUST also be a member of the `gateName` enum in
 * `.agents/schemas/validation-evidence.schema.json` — the close pipeline keys
 * per-gate evidence on it. `tests/close-validation-gates-enum.test.js` pins
 * that ⊆ invariant.
 */
export const BASELINES_GATE_NAMES = Object.freeze({
  single: 'check-baselines',
  independent: 'check-baselines-independent',
  coverage: 'check-baselines-coverage',
});

/**
 * The baseline kinds whose evaluation reads the coverage artifact written by
 * the `coverage-capture` gate (`coverage` scores it directly; `crap` divides
 * complexity by it). They are the only kinds that have to wait for the
 * capture — every other kind scores the source tree and can run as early as
 * the cheapest gates do.
 */
const COVERAGE_CONSUMING_KINDS = new Set(['coverage', 'crap']);

/**
 * Baseline kinds the resolved config enables for the unified
 * `check-baselines` gate. Mirrors `selectEnabledGates` in the check-baselines
 * pipeline (a kind runs when its `gates.<kind>` block is present and not
 * explicitly disabled) so the registration probe's view of "what will run"
 * matches the gate's own view exactly — and so the Story #5172 partition is
 * derived from the pipeline's own view of what runs rather than a hardcoded
 * kind list that a consumer's config could silently contradict.
 *
 * Returns `null` when that view cannot be resolved at all (a config object
 * whose `delivery.quality` access throws). Callers MUST read `null` as
 * "unknown" and fall back to the single unsplit gate: a partition that cannot
 * be computed must never silently drop enforcement.
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
 * @param {{ config?: object, cwd?: string, enabledKinds?: string[]|null, presentBaselines?: string[]|Set<string> }} opts
 *   `enabledKinds` is `enabledBaselineKinds(config)` computed once by the
 *   caller (so the probe and the partition below read the same view).
 *   A `null` — the unresolvable set — reads as "no enabled kinds", which is
 *   the fail-closed path: the gate stays registered under its single
 *   historical name. `presentBaselines` injects the set of kinds whose
 *   baseline artifact exists (tests), short-circuiting the on-disk probe.
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
 * Build the `check-baselines` gate entries for this run (Story #5172).
 *
 * One registration decision, one `BASELINE_REF` overlay, one remediation
 * hint — fanned out across however many entries the enabled-kind set splits
 * into. Keeping the fan-out here is what makes the #3890 (`BASELINE_REF`)
 * and #4495 (`probeBaselinesGate`) invariants structurally impossible to
 * apply to one entry and forget on the other.
 *
 * Three shapes:
 *   - decision says skip → no entries at all (#4495's greenfield skip).
 *   - `kinds` is null (unresolvable) or empty → ONE entry under the single
 *     historical name with no `--gate` filter, in its historical serial
 *     position. Fail closed: a partition that cannot be computed must never
 *     silently drop enforcement, and an empty set means the gate self-skips
 *     every kind and exits a clean empty PASS exactly as it did pre-split.
 *   - otherwise → the split pair, each pinned to its own `--gate` list.
 *     Neither bucket is ever registered with an empty kind set, so a consumer
 *     running only coverage-consuming kinds gets no parallel entry and one
 *     running none of them gets no serial entry.
 *
 * The independent entry is emitted first so a reader of the gate list sees
 * the order the runner actually walks; `partitionGates` is what routes it
 * into the parallel phase, and the coverage entry keeps its declared
 * position after `coverage-capture`.
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
 * Split a resolved command string into the `{ cmd, args }` pair a gate entry
 * carries. Whitespace-separated, so `npm run lint` yields the argv the gate
 * spawned before any of these commands were configurable — which is what
 * keeps an unconfigured consumer's `commandConfigHash` unchanged.
 *
 * @param {string} commandString
 * @returns {{ cmd: string, args: string[] }}
 */
function splitCommand(commandString) {
  const [cmd, ...args] = commandString.split(/\s+/).filter(Boolean);
  return { cmd, args };
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
 * `typecheck` and `lint` are mandatory; consumers may customise either
 * command via `project.commands.typecheck` / `project.commands.lint`
 * (defaults `npm run typecheck` / `npm run lint`). Customising `lint` is how
 * a consumer whose hooks and CI already lint the diff stops paying for a
 * third whole-repo pass at close: `lint` runs in the parallel partition, so
 * a slow whole-repo lint sets the floor for that whole phase.
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
    // Gate name kept generic ("lint") for the same reason the format gate's
    // is: the command resolves from config, so a consumer pointing it at a
    // scoped pair does not shift the close-orchestrator log line, the
    // evidence keyspace, or the parallel-partition membership below.
    { name: 'lint', cmd: lint.cmd, args: lint.args },
    ...buildTestGateEntry(coverageCaptureActive),
    {
      // Gate name kept generic ("format") so the close-orchestrator log line
      // doesn't shift when a repo swaps biome for Prettier / dprint via
      // `project.commands.formatCheck`. The
      // actual command and the remediation hint resolve from config.
      name: 'format',
      cmd: format.cmd,
      args: format.args,
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
    //
    // Story #5172: the gate registers as up to TWO entries. The kinds that
    // read no coverage artifact run in the parallel independent partition so
    // a baseline breach fails beside `lint` / `format` / `typecheck` instead
    // of minutes later behind `coverage-capture`; the coverage-consuming
    // kinds keep the serial slot after it. `buildBaselinesGateEntries` owns
    // that fan-out so both entries inherit ONE registration decision, ONE
    // `BASELINE_REF` overlay and ONE hint.
    ...buildBaselinesGateEntries({
      decision: baselinesDecision,
      kinds: baselineKinds,
      env: baselinesGateEnv,
    }),
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
const INDEPENDENT_GATE_NAMES = new Set([
  'lint',
  'format',
  'typecheck',
  // Story #5172 — the coverage-independent half of the baselines gate. It
  // reads the committed `baselines/<kind>.json` files and scores the source
  // tree in-process; it writes nothing and shares no port, so it satisfies
  // the same read-only contract as the three gates above.
  BASELINES_GATE_NAMES.independent,
]);

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
