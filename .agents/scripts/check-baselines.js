#!/usr/bin/env node

// .agents/scripts/check-baselines.js — Story #1912 / Task #1915
//
// Thin unified runtime gate. Floor + tolerance + schema + kernel-mismatch
// dispatcher across every configured baseline gate. Regression comparison
// (head vs. epic-ref), scope resolution from `delivery.quality.gateScoping`,
// and per-component component-registry resolution are OUT of scope here —
// those stay in the per-kind `check-<kind>.js` CLIs and ship in the
// follow-up Epic #1943.
//
// Contract (per acceptance #1912/#1915):
//   - Exit 0 — every enabled gate's floors are met and no schema errors.
//   - Exit 1 — any floor breach in any enabled gate.
//   - Exit 2 — schema validation error on any baseline file.
//   - Exit 3 — config resolution error (cannot read `.agentrc.json`,
//             unknown kind in `delivery.quality.gates.*`, etc.).
//
// Kernel-mismatch detection emits a `baseline-kernel-mismatch` friction
// event (suppressed with `--no-friction`) but does NOT change the exit
// code on its own — a kernel drift is advisory, not a hard fail.
//
// Output: structured JSON on stdout (`--format json`, the default) or a
// terse human summary (`--format text`). The JSON shape groups findings
// per gate, per component, with `'*'` always present.

import { checkKernelVersion } from './lib/baselines/kernel.js';
import * as reader from './lib/baselines/reader.js';
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
 * Enumerate every enabled gate kind from a resolved quality block. A gate
 * with `enabled === false` is skipped. Returns the list of kinds in
 * declaration order from `delivery.quality.gates.*`. Pure.
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
 * The kind-specific direction lives in `axisDirection()` below. Pure;
 * exported for tests.
 *
 * @param {string} kind
 * @param {Record<string, number>} aggregate  rollup component (`{ lines:…, branches:… }` etc.)
 * @param {Record<string, number>} floor     workspace floor (`{ lines: 90, … }`)
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
  // The "≤ floor" axes are the count-style metrics where lower is better.
  // Everything else is a quality score where higher is better. The branch
  // table here is small and explicit on purpose; adding a new axis must be
  // a deliberate edit, not a silent rule-fallthrough.
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
 * Apply the floor policy across every component in a rollup. Returns the
 * per-component findings (`'*'` always emitted, in addition to any
 * configured per-component floors). Pure.
 *
 * @param {string} kind
 * @param {object} rollup        from `reader.load(kind).rollup`
 * @param {Record<string, Record<string, number>>} floors  gate.floors object
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
  // Sort: '*' first, then alpha.
  out.sort((a, b) => {
    if (a.component === '*') return -1;
    if (b.component === '*') return 1;
    return a.component.localeCompare(b.component);
  });
  return out;
}

/**
 * Run the gate for a single kind. Loads the baseline through the shared
 * reader (which validates the schema and canonicalises rows), checks the
 * kernel version against the running kernel, and applies the floor
 * policy. Returns a structured per-gate report.
 *
 * Throws when the baseline is unreadable or fails schema validation (the
 * caller maps the throw to exit code 2 vs 3 depending on the error tag).
 */
function evaluateGate({ kind, gateBlock, cwd, configPath }) {
  const baseline = reader.load(kind, { cwd, configPath });
  const kernel = checkKernelVersion(kind, baseline.kernelVersion);
  const findings = applyFloors(kind, baseline.rollup, gateBlock.floors ?? {});
  const breaches = findings.flatMap((f) => f.violations);
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
    generatedAt: baseline.generatedAt,
  };
}

/**
 * Friction signal emission for kernel drift. Best-effort — failures are
 * swallowed by the friction helper itself.
 */
async function emitKernelFriction({ kind, report, storyId, epicId }) {
  await emitFrictionSignal({
    storyId,
    epicId,
    category: 'baseline-kernel-mismatch',
    tool: 'check-baselines',
    details: `kind=${kind}; baseline.kernelVersion=${report.kernelBaseline}; running=${report.kernelCurrent}`,
    payload: {
      kind,
      baselineKernelVersion: report.kernelBaseline,
      runningKernelVersion: report.kernelCurrent,
    },
    config: undefined,
    logLabel: 'check-baselines',
  });
}

/**
 * Format the structured report for stdout. Pure.
 */
export function formatReport(report, format) {
  if (format === 'json') return JSON.stringify(report, null, 2);
  const lines = [];
  lines.push(
    `[check-baselines] ${report.gates.length} gate(s) — ` +
      `breaches=${report.totalBreaches}, kernelDrift=${report.kernelDriftCount}, ` +
      `schemaErrors=${report.schemaErrors.length}`,
  );
  for (const g of report.gates) {
    const status = g.breachCount === 0 ? 'PASS' : `FAIL (${g.breachCount})`;
    lines.push(
      `  - ${g.kind}: ${status}` +
        (g.kernelMatch
          ? ''
          : ` [kernel drift ${g.kernelBaseline} → ${g.kernelCurrent}]`),
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
 * Orchestrate the run. Returns `{ exitCode, report }` so callers (tests,
 * pre-merge-validation) can drive the gate without spawning a child
 * process. The CLI shell maps the exit code to `process.exit`.
 *
 * Exit-code contract:
 *   0 — every enabled gate passes floor + schema; kernel drift is allowed.
 *   1 — any enabled gate breaches a floor.
 *   2 — any baseline fails schema validation.
 *   3 — config resolution error (caller's domain — the CLI shell catches
 *       the throw from `resolveConfig`/`getQuality` and maps to 3).
 */
export async function runCheckBaselines({ argv, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv ?? []);
  if (args.help) {
    return {
      exitCode: 0,
      report: helpReport(),
      output: HELP_TEXT,
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

  const report = {
    schemaVersion: '1',
    cwd,
    gates: [],
    totalBreaches: 0,
    kernelDriftCount: 0,
    schemaErrors: [],
  };

  for (const kind of wanted) {
    const gateBlock = quality.gates[kind];
    try {
      const gateReport = evaluateGate({
        kind,
        gateBlock,
        cwd,
        configPath: args.configPath ?? undefined,
      });
      report.gates.push(gateReport);
      report.totalBreaches += gateReport.breachCount;
      if (!gateReport.kernelMatch) {
        report.kernelDriftCount += 1;
        if (args.friction) {
          await emitKernelFriction({
            kind,
            report: gateReport,
            storyId: args.storyId,
            epicId: args.epicId,
          });
        }
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      // Reader errors that name "schema validation failed" map to exit 2;
      // everything else under the gate evaluation is a generic failure
      // that we also surface in `schemaErrors` so the report stays a
      // single object the CI step can post.
      const tag = /schema validation failed/i.test(message) ? 'schema' : 'read';
      report.schemaErrors.push({ kind, tag, message });
    }
  }

  let exitCode = 0;
  if (report.schemaErrors.length > 0) exitCode = 2;
  else if (report.totalBreaches > 0) exitCode = 1;

  return {
    exitCode,
    report,
    output: formatReport(report, args.format),
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

Thin unified runtime gate. Floor + tolerance + schema + kernel-mismatch only.
Regression comparison stays in the per-kind check-*.js CLIs (see Epic #1943).

Exit codes:
  0  every enabled gate passes
  1  any floor breach
  2  any schema validation error
  3  config resolution error
`;

async function main() {
  let result;
  try {
    result = await runCheckBaselines({ argv: process.argv.slice(2) });
  } catch (err) {
    // Config resolution error (or unrecoverable bootstrap failure) — exit 3.
    const message = err?.message ?? String(err);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: '1', error: message }, null, 2)}\n`,
    );
    process.exit(3);
    return;
  }
  process.stdout.write(`${result.output}\n`);
  process.exit(result.exitCode);
}

runAsCli(import.meta.url, main, { source: 'check-baselines' });
