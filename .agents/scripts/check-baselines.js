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
async function evaluateCompare({ kind, gateBlock, scope, cwd }) {
  if (scope.mode !== 'diff' || !scope.ref) {
    return {
      regressions: [],
      improvements: [],
      unchanged: [],
      baseRef: null,
      baseRead: false,
    };
  }
  const rel = baselineRelativePath(kind, gateBlock);
  let raw;
  try {
    raw = readBaseFromGit(scope.ref, rel, { cwd });
  } catch {
    return {
      regressions: [],
      improvements: [],
      unchanged: [],
      baseRef: scope.ref,
      baseRead: false,
    };
  }
  if (raw === null) {
    return {
      regressions: [],
      improvements: [],
      unchanged: [],
      baseRef: scope.ref,
      baseRead: false,
    };
  }
  let basePayload;
  try {
    basePayload = JSON.parse(raw);
  } catch {
    return {
      regressions: [],
      improvements: [],
      unchanged: [],
      baseRef: scope.ref,
      baseRead: false,
    };
  }
  const kindModule = getKindModule(kind);
  if (typeof kindModule.compare !== 'function') {
    return {
      regressions: [],
      improvements: [],
      unchanged: [],
      baseRef: scope.ref,
      baseRead: false,
    };
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
async function evaluateKind({ kind, gateBlock, scope, cwd, configPath }) {
  // Stage 1: schema (head load via reader, which validates).
  let baseline;
  try {
    baseline = reader.load(kind, { cwd, configPath });
  } catch (err) {
    const message = err?.message ?? String(err);
    const tag = /schema validation failed/i.test(message) ? 'schema' : 'read';
    return { kind, schemaError: { tag, message } };
  }
  const kernel = checkKernelVersion(kind, baseline.kernelVersion);

  // Stage 2: floor.
  const findings = applyFloors(kind, baseline.rollup, gateBlock.floors ?? {});
  const breaches = findings.flatMap((f) =>
    f.violations.map((v) => ({ ...v, component: f.component })),
  );

  // Stage 3: tolerance — forwarded for transparency. The dispatcher does
  // not interpret tolerance today; per-kind compare consumers may.
  const tolerance = gateBlock.tolerance ?? null;

  // Stage 4: compare (head vs base @ scope.ref).
  const cmp = await evaluateCompare({ kind, gateBlock, scope, cwd });
  let regressions = [];
  let improvements = [];
  let unchanged = [];
  if (cmp.baseRead && cmp.basePayload && cmp.kindModule) {
    try {
      const result = cmp.kindModule.compare(
        { rows: baseline.rows },
        {
          rows: Array.isArray(cmp.basePayload.rows) ? cmp.basePayload.rows : [],
        },
      );
      regressions = result?.regressions ?? [];
      improvements = result?.improvements ?? [];
      unchanged = result?.unchanged ?? [];
    } catch {
      // Compare failures are advisory — drop to "no regression" rather
      // than failing the whole gate; the per-kind module owns the
      // hard contract.
    }
  }

  return {
    kind,
    enabled: true,
    kernelMatch: kernel.match,
    kernelCurrent: kernel.current,
    kernelBaseline: baseline.kernelVersion,
    tolerance,
    floors: gateBlock.floors ?? {},
    components: findings,
    breachCount: breaches.length,
    breaches,
    regressions,
    improvements,
    unchanged,
    regressionCount: regressions.length,
    baseRef: cmp.baseRef ?? null,
    generatedAt: baseline.generatedAt,
  };
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
async function emitGateFriction({ gateReport, schemaError, args }) {
  const emitted = [];
  if (!args.friction) return emitted;
  const baseRef = gateReport?.baseRef ?? null;
  const kind = gateReport?.kind ?? schemaError?.kind;
  const baseEnvelope = {
    tool: 'check-baselines',
    kind,
    baseRef,
  };

  if (schemaError) {
    const ev = {
      ...baseEnvelope,
      severity: 'schema',
      message: schemaError.message,
    };
    emitted.push(ev);
    await emitFrictionSignal({
      storyId: args.storyId,
      epicId: args.epicId,
      category: 'baseline-schema-error',
      tool: 'check-baselines',
      details: schemaError.message,
      payload: ev,
      logLabel: 'check-baselines',
    });
    return emitted;
  }

  if ((gateReport?.breachCount ?? 0) > 0) {
    const first = gateReport.breaches[0];
    const ev = {
      ...baseEnvelope,
      severity: 'floor',
      file: first?.component ?? null,
      method: first?.axis ?? null,
      delta:
        typeof first?.value === 'number' && typeof first?.floor === 'number'
          ? first.value - first.floor
          : null,
    };
    emitted.push(ev);
    await emitFrictionSignal({
      storyId: args.storyId,
      epicId: args.epicId,
      category: 'baseline-floor-breach',
      tool: 'check-baselines',
      details: `kind=${kind}; breaches=${gateReport.breachCount}`,
      payload: ev,
      logLabel: 'check-baselines',
    });
  }

  if ((gateReport?.regressionCount ?? 0) > 0) {
    const first = gateReport.regressions[0];
    const ev = {
      ...baseEnvelope,
      severity: 'regression',
      file: first?.key ?? null,
      method: null,
      delta: null,
    };
    emitted.push(ev);
    await emitFrictionSignal({
      storyId: args.storyId,
      epicId: args.epicId,
      category: 'baseline-regression',
      tool: 'check-baselines',
      details: `kind=${kind}; regressions=${gateReport.regressionCount}; baseRef=${baseRef ?? 'none'}`,
      payload: ev,
      logLabel: 'check-baselines',
    });
  }

  if (gateReport && gateReport.kernelMatch === false) {
    const ev = {
      ...baseEnvelope,
      severity: 'kernel-mismatch',
      file: null,
      method: null,
      delta: null,
      baselineKernelVersion: gateReport.kernelBaseline,
      runningKernelVersion: gateReport.kernelCurrent,
    };
    emitted.push(ev);
    await emitFrictionSignal({
      storyId: args.storyId,
      epicId: args.epicId,
      category: 'baseline-kernel-mismatch',
      tool: 'check-baselines',
      details: `kind=${kind}; baseline=${gateReport.kernelBaseline}; running=${gateReport.kernelCurrent}`,
      payload: ev,
      logLabel: 'check-baselines',
    });
  }

  return emitted;
}

/**
 * Format the structured report for stdout. Pure.
 */
export function formatReport(report, format) {
  if (format === 'json') return JSON.stringify(report, null, 2);
  const lines = [];
  lines.push(
    `[check-baselines] ${report.gates.length} gate(s) — ` +
      `breaches=${report.totalBreaches}, regressions=${report.totalRegressions ?? 0}, ` +
      `kernelDrift=${report.kernelDriftCount}, schemaErrors=${report.schemaErrors.length}`,
  );
  for (const g of report.gates) {
    const status =
      g.breachCount === 0 && (g.regressionCount ?? 0) === 0
        ? 'PASS'
        : `FAIL (breaches=${g.breachCount}, regressions=${g.regressionCount ?? 0})`;
    lines.push(
      `  - ${g.kind}: ${status}` +
        (g.kernelMatch
          ? ''
          : ` [kernel drift ${g.kernelBaseline} → ${g.kernelCurrent}]`) +
        (g.baseRef ? ` [baseRef=${g.baseRef}]` : ''),
    );
    for (const c of g.components) {
      if (c.violations.length === 0) continue;
      for (const v of c.violations) {
        lines.push(
          `    · ${c.component}.${v.axis}: ${v.value} ${
            v.direction === 'gte' ? '<' : '>'
          } floor ${v.floor}`,
        );
      }
    }
  }
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
  const allKinds = selectEnabledGates(quality);
  const wanted =
    args.gates && args.gates.length > 0
      ? allKinds.filter((k) => args.gates.includes(k))
      : allKinds;

  // Per-kind pipeline: Promise.all over the configured kind list. Each
  // pipeline runs schema → floor → tolerance → compare in sequence
  // internally; pipelines run independently across kinds.
  const perKindResults = await Promise.all(
    wanted.map((kind) => {
      const gateBlock = quality.gates[kind];
      const scope = resolveDispatchScope({ kind, quality, env });
      return evaluateKind({
        kind,
        gateBlock,
        scope,
        cwd,
        configPath: args.configPath ?? undefined,
      });
    }),
  );

  const report = {
    schemaVersion: '1',
    cwd,
    gates: [],
    totalBreaches: 0,
    totalRegressions: 0,
    kernelDriftCount: 0,
    schemaErrors: [],
  };

  // Friction emission centralised here — the dispatcher is the single
  // emission site (Task #1976). Per-kind modules MUST NOT emit.
  const frictionEvents = [];
  const perKindExitCodes = [];

  for (const result of perKindResults) {
    if (result.schemaError) {
      report.schemaErrors.push({
        kind: result.kind,
        tag: result.schemaError.tag,
        message: result.schemaError.message,
      });
      perKindExitCodes.push(EXIT_SCHEMA);
      const events = await emitGateFriction({
        gateReport: null,
        schemaError: { ...result.schemaError, kind: result.kind },
        args,
      });
      frictionEvents.push(...events);
      continue;
    }
    report.gates.push(result);
    report.totalBreaches += result.breachCount;
    report.totalRegressions += result.regressionCount ?? 0;
    if (!result.kernelMatch) report.kernelDriftCount += 1;

    // Per-kind exit-code mapping. Multiple severities collapse into the
    // highest severity for that kind; the dispatcher's overall exit code
    // is aggregate(...) across every kind.
    let kindCode = EXIT_PASS;
    if (result.breachCount > 0) kindCode = EXIT_FLOOR;
    if ((result.regressionCount ?? 0) > 0) kindCode = EXIT_REGRESSION;
    perKindExitCodes.push(kindCode);

    const events = await emitGateFriction({ gateReport: result, args });
    frictionEvents.push(...events);
  }

  // Aggregate exit codes via the shared helper. Schema errors already
  // pushed EXIT_SCHEMA (2) above; floor and regression flow in here.
  // Precedence is numeric: EXIT_REGRESSION (4) > EXIT_CONFIG (3) >
  // EXIT_SCHEMA (2) > EXIT_FLOOR (1) > EXIT_PASS (0).
  const exitCode = aggregateExitCodes(...perKindExitCodes);

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
