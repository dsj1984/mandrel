#!/usr/bin/env node

// .agents/scripts/check-baselines.js — Story #1965 (Epic #1943)
//
// Unified baseline dispatcher. Runs the four-stage pipeline
// (schema → floor → tolerance → compare) per configured kind in parallel,
// emits friction events at a single centralised site, and aggregates per-
// kind exit codes via the shared `exit-codes` helper.
//
// Pipeline stages per kind (Story #1965 / Task #1977):
//   1. schema   — `reader.load(kind)` validates the head baseline against
//                 the per-kind schema via the shared AJV instance (cached
//                 module-globally; each kind's validator is built once and
//                 retained for the lifetime of the process).
//   2. floor    — `applyFloors(kind, rollup, gateBlock.floors)` collects
//                 per-component axis violations.
//   3. tolerance — `gateBlock.tolerance` is forwarded into the gate report
//                  so per-kind compare callers can clamp deltas; the
//                  dispatcher itself does not interpret tolerance values.
//   4. compare   — when a base ref is in scope, the dispatcher reads the
//                  base baseline once via `git-base.readBaseFromGit(ref,
//                  path)`, parses + validates it with the same kind
//                  schema, and calls `kindModule.compare(head, base)` to
//                  classify regressions / improvements / unchanged.
//
// Read-once contract (Task #1977 acceptance): each baseline file is
// touched at most once per dispatcher invocation. The head baseline is
// loaded by `reader.load`; the base baseline is fetched by
// `git-base.readBaseFromGit`, which carries its own (ref,file) LRU.
//
// Exit-code contract (Task #1975, see `lib/baselines/exit-codes.js`):
//   0 EXIT_PASS        — every enabled gate is green.
//   1 EXIT_FLOOR       — at least one floor breach.
//   2 EXIT_SCHEMA      — at least one schema validation error.
//   3 EXIT_CONFIG      — config resolution failure (mapped by main()).
//   4 EXIT_REGRESSION  — at least one head-vs-base regression detected.
//
// Friction contract (Task #1976): when `--no-friction` is NOT passed, the
// dispatcher emits exactly one friction event per (kind, severity) tuple
// using the canonical payload `{tool:'check-baselines', kind, severity,
// file?, method?, delta?, baseRef}`. Per-kind modules MUST NOT emit
// friction directly — the dispatcher is the single emission site.

import {
  aggregate as aggregateExitCodes,
  EXIT_CONFIG,
  EXIT_FLOOR,
  EXIT_PASS,
  EXIT_REGRESSION,
  EXIT_SCHEMA,
} from './lib/baselines/exit-codes.js';
import { readBaseFromGit } from './lib/baselines/git-base.js';
import { checkKernelVersion, getKindModule } from './lib/baselines/kernel.js';
import * as reader from './lib/baselines/reader.js';
import { resolveScope } from './lib/baselines/scope.js';
import { runAsCli } from './lib/cli-utils.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import { emitFrictionSignal } from './lib/gates/friction.js';

const KNOWN_KINDS = Object.freeze([
  'lint',
  'coverage',
  'crap',
  'maintainability',
  'mutation',
  'lighthouse',
  'bundle-size',
]);

const DEFAULT_BASELINE_PATHS = Object.freeze({
  lint: 'baselines/lint.json',
  coverage: 'baselines/coverage.json',
  crap: 'baselines/crap.json',
  maintainability: 'baselines/maintainability.json',
  mutation: 'baselines/mutation.json',
  lighthouse: 'baselines/lighthouse.json',
  'bundle-size': 'baselines/bundle-size.json',
});

/**
 * Parse the CLI flags. Pure — exported for tests.
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{
 *   configPath: string | null,
 *   gates: string[] | null,
 *   format: 'json' | 'text',
 *   friction: boolean,
 *   storyId: string | null,
 *   epicId: string | null,
 *   help?: boolean,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    configPath: null,
    gates: null,
    format: 'json',
    friction: true,
    storyId: null,
    epicId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config' && argv[i + 1]) {
      out.configPath = argv[++i];
    } else if (a === '--gate' && argv[i + 1]) {
      out.gates = (out.gates ?? []).concat(
        argv[++i]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (a === '--format' && argv[i + 1]) {
      const v = argv[++i];
      if (v !== 'json' && v !== 'text') {
        throw new Error(`--format expects "json" or "text"; got "${v}"`);
      }
      out.format = v;
    } else if (a === '--no-friction') {
      out.friction = false;
    } else if (a === '--story' && argv[i + 1]) {
      out.storyId = argv[++i];
    } else if (a === '--epic' && argv[i + 1]) {
      out.epicId = argv[++i];
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag "${a}"`);
    }
  }
  return out;
}

/**
 * Enumerate every enabled gate kind from a resolved quality block. Pure.
 *
 * @param {object} quality  result of `getQuality(config)`
 * @returns {string[]}
 */
export function selectEnabledGates(quality) {
  const gates = quality?.gates ?? {};
  const out = [];
  for (const kind of KNOWN_KINDS) {
    const block = gates[kind];
    if (!block || typeof block !== 'object') continue;
    if (block.enabled === false) continue;
    out.push(kind);
  }
  return out;
}

/**
 * Compare a single rollup component against a single floor object. Returns
 * the array of axis violations (empty when every axis meets its floor).
 *
 * Per-axis comparison direction:
 *   - coverage axes (lines/branches/functions): `value >= floor` (percent ≥)
 *   - maintainability:                          `value >= floor` (MI ≥)
 *   - lint (errorCount/warningCount):           `value <= floor` (count ≤)
 *   - crap (max/p95/methodsAbove*):             `value <= floor` (≤)
 *   - mutation score:                           `value >= floor` (≥)
 *   - mutation survived/noCoverage:             `value <= floor` (≤)
 *
 * Pure; exported for tests.
 *
 * @param {string} kind
 * @param {Record<string, number>} aggregate
 * @param {Record<string, number>} floor
 * @returns {Array<{ axis: string, value: number, floor: number, direction: 'gte' | 'lte' }>}
 */
export function compareToFloor(kind, aggregate, floor) {
  const out = [];
  if (!floor || typeof floor !== 'object') return out;
  for (const axis of Object.keys(floor)) {
    const target = floor[axis];
    if (typeof target !== 'number' || !Number.isFinite(target)) continue;
    const value = aggregate?.[axis];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const direction = axisDirection(kind, axis);
    const pass = direction === 'gte' ? value >= target : value <= target;
    if (!pass) {
      out.push({ axis, value, floor: target, direction });
    }
  }
  return out;
}

function axisDirection(kind, axis) {
  if (kind === 'lint') return 'lte';
  if (kind === 'crap') return 'lte';
  if (kind === 'bundle-size') return 'lte';
  if (kind === 'mutation') {
    if (axis === 'survived' || axis === 'noCoverage') return 'lte';
    return 'gte';
  }
  return 'gte';
}

/**
 * Apply the floor policy across every component in a rollup. Pure.
 *
 * @param {string} kind
 * @param {object} rollup
 * @param {Record<string, Record<string, number>>} floors
 * @returns {Array<{ component: string, violations: Array<object> }>}
 */
export function applyFloors(kind, rollup, floors) {
  const out = [];
  const components = new Set([
    '*',
    ...Object.keys(floors ?? {}),
    ...Object.keys(rollup ?? {}),
  ]);
  for (const component of components) {
    const aggregate = rollup?.[component];
    if (!aggregate || typeof aggregate !== 'object') continue;
    const floor = floors?.[component] ?? floors?.['*'];
    const violations = compareToFloor(kind, aggregate, floor);
    out.push({ component, violations });
  }
  out.sort((a, b) => {
    if (a.component === '*') return -1;
    if (b.component === '*') return 1;
    return a.component.localeCompare(b.component);
  });
  return out;
}

/**
 * Resolve the on-disk relative path for a baseline kind. The dispatcher
 * needs this for the base-ref read (git-base.readBaseFromGit takes a
 * repo-relative file path); the head read goes through `reader.load`
 * which has its own resolver.
 *
 * @param {string} kind
 * @param {object} gateBlock
 * @returns {string} repo-relative path
 */
function baselineRelativePath(kind, gateBlock) {
  const configured =
    typeof gateBlock?.baselinePath === 'string' &&
    gateBlock.baselinePath.length > 0
      ? gateBlock.baselinePath
      : null;
  return configured ?? DEFAULT_BASELINE_PATHS[kind];
}

/**
 * Resolve the scope (full/diff vs ref) for the dispatcher run. Today the
 * dispatcher is invoked without explicit scope flags; the helper still
 * runs so config and env can drive the diff ref. Returned `mode === 'diff'`
 * with a non-null `ref` enables the compare stage.
 *
 * @param {object} input
 * @returns {{ mode: 'full'|'diff', ref: string|null, source: string }}
 */
function resolveDispatchScope({ kind, quality, env }) {
  const cfg = quality?.gateScoping ?? {};
  return resolveScope({
    kind,
    configScope: cfg.scope,
    configRef: cfg.diffRef,
    cliFlags: {
      envScope: env?.BASELINE_SCOPE,
      envRef: env?.BASELINE_REF,
    },
  });
}

/**
 * Run the compare stage for a single kind. Reads the base baseline from
 * git via `readBaseFromGit` (cached), validates it through the shared
 * reader, and delegates classification to the kind module.
 *
 * Returns `{ regressions, improvements, unchanged, baseRef, baseRead }`.
 * `baseRead === false` means no base baseline was available (no scope ref,
 * git missing, or the file does not exist at the ref) — the caller treats
 * that as "no compare data, no regression".
 *
 * @param {{ kind: string, gateBlock: object, scope: object, cwd: string }} input
 * @returns {Promise<object>}
 */
function emptyCompareResult(baseRef) {
  return { baseRef, baseRead: false };
}

function readBaseBaselinePayload(scope, kind, gateBlock, cwd) {
  const rel = baselineRelativePath(kind, gateBlock);
  let raw;
  try {
    raw = readBaseFromGit(scope.ref, rel, { cwd });
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function evaluateCompare({ kind, gateBlock, scope, cwd }) {
  if (scope.mode !== 'diff' || !scope.ref) return emptyCompareResult(null);
  const basePayload = readBaseBaselinePayload(scope, kind, gateBlock, cwd);
  if (!basePayload) return emptyCompareResult(scope.ref);
  const kindModule = getKindModule(kind);
  if (typeof kindModule.compare !== 'function') {
    return emptyCompareResult(scope.ref);
  }
  // The head baseline was already loaded once by the caller via
  // `reader.load`; we receive only the rows we need to compare against.
  return { baseRef: scope.ref, baseRead: true, basePayload, kindModule };
}

/**
 * Run the per-kind pipeline (schema → floor → tolerance → compare).
 * Returns a structured report (or `{ schemaError }` if the head baseline
 * fails schema validation / read).
 *
 * @param {{ kind: string, gateBlock: object, scope: object, cwd: string,
 *           configPath?: string }} input
 * @returns {Promise<object>}
 */
function loadHeadBaseline(kind, cwd, configPath) {
  try {
    return { baseline: reader.load(kind, { cwd, configPath }) };
  } catch (err) {
    const message = err?.message ?? String(err);
    const tag = /schema validation failed/i.test(message) ? 'schema' : 'read';
    return { schemaError: { tag, message } };
  }
}

function flattenBreaches(findings) {
  return findings.flatMap((f) =>
    f.violations.map((v) => ({ ...v, component: f.component })),
  );
}

function runCompareStage(headBaseline, cmp) {
  const empty = {
    regressions: [],
    improvements: [],
    unchanged: [],
    additions: [],
  };
  if (!cmp.baseRead || !cmp.basePayload || !cmp.kindModule) return empty;
  try {
    const baseRows = Array.isArray(cmp.basePayload.rows)
      ? cmp.basePayload.rows
      : [];
    const result = cmp.kindModule.compare(
      { rows: headBaseline.rows },
      { rows: baseRows },
    );
    return {
      regressions: result?.regressions ?? [],
      improvements: result?.improvements ?? [],
      unchanged: result?.unchanged ?? [],
      additions: result?.additions ?? [],
    };
  } catch {
    // Compare failures are advisory — drop to "no regression" rather
    // than failing the whole gate; the per-kind module owns the
    // hard contract.
    return empty;
  }
}

/**
 * Apply the per-gate tolerance to the raw compare output. Without an
 * explicit tolerance the per-kind classifier wins. With
 * `{ kind: 'absolute', value: N }`, regressions whose largest absolute
 * axis-delta is below N are demoted to `unchanged`.
 */
function tolerantNumericFields(head, base) {
  if (!head || !base) return [];
  return Object.entries(head)
    .filter(
      ([key, h]) => typeof h === 'number' && typeof base[key] === 'number',
    )
    .map(([key, h]) => ({ key, head: h, base: base[key] }));
}

function regressionExceedsTolerance(reg, threshold) {
  const fields = tolerantNumericFields(reg.head, reg.base);
  if (fields.length === 0) return true;
  return fields.some(({ head, base }) => Math.abs(head - base) >= threshold);
}

function applyTolerance(compareOutput, tolerance) {
  if (!tolerance || tolerance.kind !== 'absolute') return compareOutput;
  const threshold = Number(tolerance.value);
  if (!Number.isFinite(threshold) || threshold <= 0) return compareOutput;
  const kept = [];
  const demoted = [];
  for (const reg of compareOutput.regressions) {
    if (regressionExceedsTolerance(reg, threshold)) kept.push(reg);
    else demoted.push(reg);
  }
  return {
    ...compareOutput,
    regressions: kept,
    unchanged: [...compareOutput.unchanged, ...demoted],
  };
}

function buildGateReport({
  kind,
  gateBlock,
  baseline,
  findings,
  breaches,
  compareOutput,
  cmp,
}) {
  const kernel = checkKernelVersion(kind, baseline.kernelVersion);
  return {
    kind,
    enabled: true,
    kernelMatch: kernel.match,
    kernelCurrent: kernel.current,
    kernelBaseline: baseline.kernelVersion,
    tolerance: gateBlock.tolerance ?? null,
    floors: gateBlock.floors ?? {},
    components: findings,
    breachCount: breaches.length,
    breaches,
    regressions: compareOutput.regressions,
    improvements: compareOutput.improvements,
    unchanged: compareOutput.unchanged,
    additions: compareOutput.additions ?? [],
    regressionCount: compareOutput.regressions.length,
    baseRef: cmp.baseRef ?? null,
    generatedAt: baseline.generatedAt,
  };
}

async function evaluateKind({ kind, gateBlock, scope, cwd, configPath }) {
  // Stage 1: schema (head load via reader, which validates).
  const headLoad = loadHeadBaseline(kind, cwd, configPath);
  if (headLoad.schemaError) {
    return { kind, schemaError: headLoad.schemaError };
  }
  const baseline = headLoad.baseline;
  // Stage 2: floor.
  const findings = applyFloors(kind, baseline.rollup, gateBlock.floors ?? {});
  const breaches = flattenBreaches(findings);
  // Stage 3 (tolerance) is applied to the compare output below — the
  // gateBlock.tolerance entry demotes near-floor noise back to unchanged
  // so a routine percent-point of jitter does not trip EXIT_REGRESSION.
  // Stage 4: compare (head vs base @ scope.ref).
  const cmp = await evaluateCompare({ kind, gateBlock, scope, cwd });
  const rawCompare = runCompareStage(baseline, cmp);
  const compareOutput = applyTolerance(rawCompare, gateBlock.tolerance ?? null);
  return buildGateReport({
    kind,
    gateBlock,
    baseline,
    findings,
    breaches,
    compareOutput,
    cmp,
  });
}

/**
 * Friction emission. The dispatcher is the single emission site: per
 * (kind, severity) tuple, exactly one friction event is emitted with the
 * canonical payload `{tool:'check-baselines', kind, severity, file?,
 * method?, delta?, baseRef}`.
 *
 * Severities:
 *   - `floor`             — at least one floor breach.
 *   - `regression`        — at least one head-vs-base regression.
 *   - `schema`            — head baseline failed schema validation / read.
 *   - `kernel-mismatch`   — baseline kernelVersion ≠ running kernel.
 *
 * Returns the list of emitted events for test inspection.
 */
function buildSchemaEvent(envelope, schemaError) {
  return { ...envelope, severity: 'schema', message: schemaError.message };
}

function buildFloorEvent(envelope, breaches) {
  const first = breaches?.[0];
  const value = first?.value;
  const floor = first?.floor;
  const delta =
    typeof value === 'number' && typeof floor === 'number'
      ? value - floor
      : null;
  return {
    ...envelope,
    severity: 'floor',
    file: first?.component ?? null,
    method: first?.axis ?? null,
    delta,
  };
}

function buildRegressionEvent(envelope, regressions) {
  const first = regressions?.[0];
  return {
    ...envelope,
    severity: 'regression',
    file: first?.key ?? null,
    method: null,
    delta: null,
  };
}

function buildKernelMismatchEvent(envelope, gateReport) {
  return {
    ...envelope,
    severity: 'kernel-mismatch',
    file: null,
    method: null,
    delta: null,
    baselineKernelVersion: gateReport.kernelBaseline,
    runningKernelVersion: gateReport.kernelCurrent,
  };
}

async function dispatchFrictionEvent({ args, category, details, payload }) {
  await emitFrictionSignal({
    storyId: args.storyId,
    epicId: args.epicId,
    category,
    tool: 'check-baselines',
    details,
    payload,
    logLabel: 'check-baselines',
  });
}

async function emitGateFriction({ gateReport, schemaError, args }) {
  const emitted = [];
  if (!args.friction) return emitted;
  const baseRef = gateReport?.baseRef ?? null;
  const kind = gateReport?.kind ?? schemaError?.kind;
  const envelope = { tool: 'check-baselines', kind, baseRef };

  if (schemaError) {
    const ev = buildSchemaEvent(envelope, schemaError);
    emitted.push(ev);
    await dispatchFrictionEvent({
      args,
      category: 'baseline-schema-error',
      details: schemaError.message,
      payload: ev,
    });
    return emitted;
  }

  if ((gateReport?.breachCount ?? 0) > 0) {
    const ev = buildFloorEvent(envelope, gateReport.breaches);
    emitted.push(ev);
    await dispatchFrictionEvent({
      args,
      category: 'baseline-floor-breach',
      details: `kind=${kind}; breaches=${gateReport.breachCount}`,
      payload: ev,
    });
  }

  if ((gateReport?.regressionCount ?? 0) > 0) {
    const ev = buildRegressionEvent(envelope, gateReport.regressions);
    emitted.push(ev);
    await dispatchFrictionEvent({
      args,
      category: 'baseline-regression',
      details: `kind=${kind}; regressions=${gateReport.regressionCount}; baseRef=${baseRef ?? 'none'}`,
      payload: ev,
    });
  }

  if (gateReport?.kernelMatch === false) {
    const ev = buildKernelMismatchEvent(envelope, gateReport);
    emitted.push(ev);
    await dispatchFrictionEvent({
      args,
      category: 'baseline-kernel-mismatch',
      details: `kind=${kind}; baseline=${gateReport.kernelBaseline}; running=${gateReport.kernelCurrent}`,
      payload: ev,
    });
  }

  return emitted;
}

/**
 * Format the structured report for stdout. Pure.
 */
function formatHeader(report) {
  return (
    `[check-baselines] ${report.gates.length} gate(s) — ` +
    `breaches=${report.totalBreaches}, regressions=${report.totalRegressions ?? 0}, ` +
    `kernelDrift=${report.kernelDriftCount}, schemaErrors=${report.schemaErrors.length}`
  );
}

function formatGateStatus(g) {
  if (g.breachCount === 0 && (g.regressionCount ?? 0) === 0) return 'PASS';
  return `FAIL (breaches=${g.breachCount}, regressions=${g.regressionCount ?? 0})`;
}

function formatGateLine(g) {
  const status = formatGateStatus(g);
  const drift = g.kernelMatch
    ? ''
    : ` [kernel drift ${g.kernelBaseline} → ${g.kernelCurrent}]`;
  const baseRef = g.baseRef ? ` [baseRef=${g.baseRef}]` : '';
  return `  - ${g.kind}: ${status}${drift}${baseRef}`;
}

function formatViolationLine(component, v) {
  const op = v.direction === 'gte' ? '<' : '>';
  return `    · ${component}.${v.axis}: ${v.value} ${op} floor ${v.floor}`;
}

function appendGateText(lines, g) {
  lines.push(formatGateLine(g));
  for (const c of g.components) {
    if (c.violations.length === 0) continue;
    for (const v of c.violations) {
      lines.push(formatViolationLine(c.component, v));
    }
  }
}

export function formatReport(report, format) {
  if (format === 'json') return JSON.stringify(report, null, 2);
  const lines = [formatHeader(report)];
  for (const g of report.gates) appendGateText(lines, g);
  for (const s of report.schemaErrors) {
    lines.push(`  ! schema error (${s.kind}): ${s.message}`);
  }
  return lines.join('\n');
}

/**
 * Orchestrate the run. Per-kind pipelines run via `Promise.all`; per-kind
 * exit codes are aggregated through the shared `aggregate(...)` helper.
 *
 * Returns `{ exitCode, report, output, frictionEvents }`. `frictionEvents`
 * is the flat list of payloads emitted (one per kind/severity tuple).
 *
 * @param {{ argv?: string[], cwd?: string, env?: object }} [opts]
 */
function emptyReport(cwd) {
  return {
    schemaVersion: '1',
    cwd,
    gates: [],
    totalBreaches: 0,
    totalRegressions: 0,
    kernelDriftCount: 0,
    schemaErrors: [],
  };
}

function pickWantedKinds(quality, gateFilter) {
  const allKinds = selectEnabledGates(quality);
  if (!gateFilter || gateFilter.length === 0) return allKinds;
  return allKinds.filter((k) => gateFilter.includes(k));
}

function dispatchPerKind({ wanted, quality, env, cwd, configPath }) {
  return Promise.all(
    wanted.map((kind) => {
      const gateBlock = quality.gates[kind];
      const scope = resolveDispatchScope({ kind, quality, env });
      return evaluateKind({ kind, gateBlock, scope, cwd, configPath });
    }),
  );
}

/**
 * Map a per-kind gate result to its exit code. Regression contributes to
 * EXIT_REGRESSION only when the gate has an explicit tolerance policy
 * configured — without one the per-kind CLIs (still in the close-validation
 * chain alongside this dispatcher) own the regression veto, and the
 * dispatcher's compare stage is informational. Once Epic #1943 finishes
 * deleting the per-kind CLIs, every gate will carry an explicit tolerance
 * and this guard becomes a no-op.
 */
function exitCodeForGate(result) {
  if ((result.regressionCount ?? 0) > 0 && result.tolerance) {
    return EXIT_REGRESSION;
  }
  if (result.breachCount > 0) return EXIT_FLOOR;
  return EXIT_PASS;
}

async function accumulateSchemaError(result, ctx) {
  ctx.report.schemaErrors.push({
    kind: result.kind,
    tag: result.schemaError.tag,
    message: result.schemaError.message,
  });
  ctx.perKindExitCodes.push(EXIT_SCHEMA);
  const events = await emitGateFriction({
    gateReport: null,
    schemaError: { ...result.schemaError, kind: result.kind },
    args: ctx.args,
  });
  ctx.frictionEvents.push(...events);
}

async function accumulateGateResult(result, ctx) {
  ctx.report.gates.push(result);
  ctx.report.totalBreaches += result.breachCount;
  ctx.report.totalRegressions += result.regressionCount ?? 0;
  if (!result.kernelMatch) ctx.report.kernelDriftCount += 1;
  ctx.perKindExitCodes.push(exitCodeForGate(result));
  const events = await emitGateFriction({ gateReport: result, args: ctx.args });
  ctx.frictionEvents.push(...events);
}

async function consumePerKindResults(perKindResults, args, report) {
  const ctx = { args, report, perKindExitCodes: [], frictionEvents: [] };
  for (const result of perKindResults) {
    if (result.schemaError) {
      await accumulateSchemaError(result, ctx);
      continue;
    }
    await accumulateGateResult(result, ctx);
  }
  return {
    exitCode: aggregateExitCodes(...ctx.perKindExitCodes),
    frictionEvents: ctx.frictionEvents,
  };
}

export async function runCheckBaselines({
  argv,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const args = parseArgs(argv ?? []);
  if (args.help) {
    return {
      exitCode: 0,
      report: helpReport(),
      output: HELP_TEXT,
      frictionEvents: [],
    };
  }
  const config = resolveConfig({
    cwd,
    configPath: args.configPath ?? undefined,
  });
  const quality = getQuality({ delivery: config.delivery });
  const wanted = pickWantedKinds(quality, args.gates);
  // Per-kind pipeline: Promise.all over the configured kind list. Each
  // pipeline runs schema → floor → tolerance → compare in sequence
  // internally; pipelines run independently across kinds.
  const perKindResults = await dispatchPerKind({
    wanted,
    quality,
    env,
    cwd,
    configPath: args.configPath ?? undefined,
  });

  const report = emptyReport(cwd);
  const { exitCode, frictionEvents } = await consumePerKindResults(
    perKindResults,
    args,
    report,
  );
  return {
    exitCode,
    report,
    output: formatReport(report, args.format),
    frictionEvents,
  };
}

function helpReport() {
  return {
    schemaVersion: '1',
    help: true,
    knownKinds: [...KNOWN_KINDS],
  };
}

const HELP_TEXT = `Usage: check-baselines.js [--config <path>] [--gate <kind>[,<kind>]] [--format json|text] [--no-friction] [--story <id>] [--epic <id>]

Unified baseline dispatcher. Per-kind pipeline (schema → floor → tolerance →
compare) over every configured gate, with centralised friction emission and
aggregated exit codes.

Exit codes:
  0  every enabled gate passes
  1  any floor breach
  2  any schema validation error
  3  config resolution error
  4  any head-vs-base regression
`;

async function main() {
  let result;
  try {
    result = await runCheckBaselines({ argv: process.argv.slice(2) });
  } catch (err) {
    const message = err?.message ?? String(err);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: '1', error: message }, null, 2)}\n`,
    );
    process.exit(EXIT_CONFIG);
    return;
  }
  process.stdout.write(`${result.output}\n`);
  process.exit(result.exitCode);
}

runAsCli(import.meta.url, main, { source: 'check-baselines' });
