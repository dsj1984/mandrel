/**
 * close-validation/gates.js — Gate construction and partitioning.
 *
 * Owns the canonical close-validation gate list (`buildDefaultGates` /
 * `DEFAULT_GATES`) and the parallel-vs-serial partitioning used by the
 * runner (`INDEPENDENT_GATE_NAMES` / `partitionGates`).
 */

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
 * `origin/<epicBranch>` here makes the gate diff head against the epic
 * integration branch instead of the framework-default `origin/main`, so
 * drift that already landed on `main` but is outside the Story's own diff
 * does not surface as a phantom regression. The same convention
 * (`origin/<epicBranch>`) is used by the baseline-attribution and
 * auto-refresh paths, keeping read/compare bases aligned.
 *
 * Returns `null` when no integration branch is supplied (the gate then
 * keeps its existing default-ref / consumer-config behaviour untouched).
 *
 * @param {string|undefined|null} epicBranch
 * @returns {{ BASELINE_REF: string } | null}
 */
function buildBaselinesGateEnv(epicBranch) {
  if (typeof epicBranch !== 'string' || epicBranch.length === 0) return null;
  return { BASELINE_REF: `origin/${epicBranch}` };
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
 * Conditionally produce the standalone `test` gate entry. Returns an empty
 * array when the CRAP gate is enabled (Story #1798: coverage-capture is the
 * canonical test runner in that mode); returns the legacy single-entry
 * gate otherwise. Splitting this out keeps `buildDefaultGates` flat for
 * the CRAP-cyclomatic gate.
 *
 * @param {object|undefined|null} config - Canonical resolved config.
 * @returns {Gate[]}
 */
function buildTestGateEntry(config) {
  if (isCrapGateEnabled(config)) return [];
  return [{ name: 'test', cmd: 'npm', args: ['test'] }];
}

/**
 * Build the canonical close-validation gate list.
 *
 * Ordering (cheapest fast-fail first): typecheck → lint → [test] →
 * format → coverage-capture → check-baselines. The standalone `test`
 * gate is dropped when `crap.enabled === true` (Story #1798) because
 * coverage-capture carries test-failure signalling under c8 in that
 * mode.
 *
 * `typecheck` is mandatory; consumers may customise the command via
 * `project.commands.typecheck` (default `npm run typecheck`).
 *
 * Story #2210 retired the legacy per-kind in-process regression gates
 * (`check-maintainability`, `check-crap`, `check-mutation`) and their
 * shared in-process runner. The unified `check-baselines` gate is now the
 * single source of truth for per-kind regression enforcement
 * (attribution-wired floor + tolerance + schema).
 * The `epicBranch` parameter threads the close run's integration branch
 * into two gates: the `format` gate's `changedFileScope` (existing) and —
 * since Story #3890 — the `check-baselines` gate's `BASELINE_REF` env, so
 * the baselines regression compare diffs head against the epic integration
 * branch (`origin/<epicBranch>`) rather than the framework-default
 * `origin/main`. Without this, every child Story on an `epic/<id>` branch
 * re-discovered inherited main-vs-epic drift in untouched files as phantom
 * regressions and worked around it by hand-setting `BASELINE_REF`.
 *
 * @param {{ config?: object, epicBranch?: string }} [opts] - `config` is the
 *   canonical resolved config (`{ project, delivery, ... }`); gate commands
 *   resolve from `project.commands` and the CRAP toggle from
 *   `delivery.quality.gates.crap.enabled`. `epicBranch` is the close run's
 *   integration branch (`epic/<id>` for Epic-attached Stories, the base
 *   branch for standalone Stories).
 * @returns {Gate[]}
 */
export function buildDefaultGates({ config, epicBranch } = {}) {
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
      ? buildChangedFileScope(epicBranch)
      : null;
  const baselinesGateEnv = buildBaselinesGateEnv(epicBranch);
  return [
    {
      name: 'typecheck',
      cmd: typecheckCmd,
      args: typecheckArgs,
      hint: TYPECHECK_HINT,
    },
    { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
    ...buildTestGateEntry(config),
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
    {
      name: 'coverage-capture',
      cmd: 'node',
      args: ['.agents/scripts/coverage-capture.js'],
      hint: 'Coverage capture failed — `npm run test:coverage` exited non-zero. Fix failing tests or coverage-threshold breaches, then re-run close.',
    },
    {
      // Story #2210 — unified `check-baselines` gate is the only path for
      // per-kind regression enforcement. The legacy per-kind in-process
      // gates were retired because their regression-compare semantics are
      // fully subsumed by this gate's attribution-wired floor + tolerance +
      // schema enforcement, and running both paths in series was redundant
      // and conflict-prone.
      //
      // `check-baselines.js` self-skips per-kind gates whose
      // `enabled === false` is configured, so registering it
      // unconditionally is safe.
      name: 'check-baselines',
      cmd: 'node',
      args: ['.agents/scripts/check-baselines.js', '--format', 'text'],
      hint: 'Unified baselines gate breached. Inspect the JSON report (`node .agents/scripts/check-baselines.js`) to see which kind/component/axis fell below floor; remediate the underlying file(s) or — when the regression is intentional — refresh the relevant baseline through its per-kind update script and commit with a `baseline-refresh:` tagged subject.',
      ...(baselinesGateEnv ? { env: baselinesGateEnv } : {}),
    },
  ];
}

/**
 * Default gate list resolved with no consumer config — uses the
 * `npm run typecheck` fallback for the typecheck gate. Call sites that have a
 * resolved config object in scope (e.g. `story-close.js`) should
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
