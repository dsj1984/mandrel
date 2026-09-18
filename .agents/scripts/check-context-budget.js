/**
 * CLI: ratchet gate for documentation context bytes against
 * `baselines/context-budget.json`. Measures `alwaysLoaded` (the `CLAUDE.md`
 * `@`-import closure), `mandatoryRead` (`project.docsContextFiles`) and
 * `workflow` (entry points + `mandatoryReads:` closure).
 *
 * Only `alwaysLoaded` gates — every session and subagent spawn pays it. Exit 1
 * when it grows past `totalBytes + toleranceBytes` or a recorded row names a
 * path it no longer contains; every other drift, and all shrinkage, is
 * reported with exit 0 (the close writes a lower total back). An empty tier or
 * a missing baseline is a no-op. Tolerance lives only in the baseline JSON.
 *
 * Flags: --baseline <path>, --root <path>, --update (keeps tolerance), --json.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { resolveDocTiers, tierTotalBytes } from './lib/doc-tiers.js';

/**
 * Measured tiers, in report order — only those a session is forced to read.
 * @type {Array<'alwaysLoaded' | 'mandatoryRead' | 'workflow'>}
 */
export const MEASURED_TIERS = ['alwaysLoaded', 'mandatoryRead', 'workflow'];

/**
 * Tiers whose drift fails the command; the rest are report-only.
 * @type {Array<'alwaysLoaded'>}
 */
export const ENFORCED_TIERS = ['alwaysLoaded'];

/**
 * Seeded by `--update` when the baseline carries none.
 * @type {number}
 */
export const DEFAULT_TOLERANCE_BYTES = 2048;

/**
 * @param {string[]} argv
 * @returns {{ baselinePath: string|null, rootPath: string|null, update: boolean, json: boolean }}
 */
export function parseArgv(argv = []) {
  let baselinePath = null;
  let rootPath = null;
  let update = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--baseline') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        baselinePath = next;
        i += 1;
      }
    } else if (a === '--root') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        rootPath = next;
        i += 1;
      }
    } else if (a === '--update') {
      update = true;
    } else if (a === '--json') {
      json = true;
    }
  }
  return { baselinePath, rootPath, update, json };
}

/**
 * `null` when missing or unparseable.
 *
 * @param {string} baselinePath
 * @returns {{ toleranceBytes?: number, tiers?: Record<string, { totalBytes: number, files?: Array<{ path: string, bytes: number }> }> } | null}
 */
export function loadBaseline(baselinePath) {
  try {
    if (!fs.existsSync(baselinePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {{ tiers: Record<string, Array<{ path: string, bytes: number }>> }} tierMap
 * @param {number} toleranceBytes
 * @returns {object}
 */
export function buildBaseline(tierMap, toleranceBytes) {
  const tiers = {};
  for (const name of MEASURED_TIERS) {
    const files = tierMap.tiers[name] ?? [];
    tiers[name] = { totalBytes: tierTotalBytes(files), files };
  }
  // Top-level, not under `tiers`: a per-file size record with no total to diff.
  const agentBootFiles = (tierMap.tiers.agentBoot ?? []).map((f) => ({
    path: f.path,
    bytes: f.bytes,
  }));
  return {
    $schema: 'https://mandrel.dev/baselines/context-budget.schema.json',
    generatedAt: new Date().toISOString(),
    toleranceBytes,
    tiers,
    agentBoot: {
      files: agentBootFiles,
    },
    // Recorded, never gated.
    workflowClosure: {
      reachableTotalBytes: tierMap.workflowClosure?.reachableTotalBytes ?? 0,
      entryPoints: tierMap.workflowClosure?.entryPoints ?? [],
    },
  };
}

/**
 * Recorded rows naming a path the tier no longer contains (deleted or
 * de-listed) — their bytes inflate the total against nothing.
 *
 * @param {string} tier
 * @param {Array<{ path: string, bytes: number }>} files live tier measurement
 * @param {{ files?: Array<{ path: string, bytes?: number }> }} baseTier recorded tier
 * @returns {Array<{ tier: string, path: string, bytes: number|null }>}
 */
function absentRows(tier, files, baseTier) {
  const live = new Set(files.map((f) => f.path));
  const out = [];
  for (const row of baseTier?.files ?? []) {
    if (typeof row?.path !== 'string' || live.has(row.path)) continue;
    out.push({
      tier,
      path: row.path,
      bytes: Number.isFinite(row.bytes) ? row.bytes : null,
    });
  }
  return out;
}

/**
 * Pure diff against the baseline; empty or unrecorded tiers are skipped.
 *
 * @param {{ tiers: Record<string, Array<{ path: string, bytes: number }>> }} tierMap
 * @param {{ toleranceBytes?: number, tiers?: Record<string, { totalBytes: number }> }} baseline
 * @returns {{
 *   grown: Array<{ tier: string, current: number, baseline: number, tolerance: number, delta: number }>,
 *   shrunk: Array<{ tier: string, current: number, baseline: number, delta: number }>,
 *   absent: Array<{ tier: string, path: string, bytes: number|null }>,
 *   skipped: string[],
 * }}
 */
export function diffBudget(tierMap, baseline) {
  const tolerance = Number.isFinite(baseline?.toleranceBytes)
    ? baseline.toleranceBytes
    : 0;
  const grown = [];
  const shrunk = [];
  const absent = [];
  const skipped = [];
  for (const tier of MEASURED_TIERS) {
    const files = tierMap.tiers[tier] ?? [];
    const current = tierTotalBytes(files);
    const baseTier = baseline?.tiers?.[tier];
    if (
      files.length === 0 ||
      !baseTier ||
      !Number.isFinite(baseTier.totalBytes)
    ) {
      skipped.push(tier);
      continue;
    }
    const baselineBytes = baseTier.totalBytes;
    if (current > baselineBytes + tolerance) {
      grown.push({
        tier,
        current,
        baseline: baselineBytes,
        tolerance,
        delta: current - baselineBytes,
      });
    } else if (current < baselineBytes) {
      // Zero-tolerance downward, so the write-back never misses a small gain.
      shrunk.push({
        tier,
        current,
        baseline: baselineBytes,
        delta: baselineBytes - current,
      });
    }
    absent.push(...absentRows(tier, files, baseTier));
  }
  return { grown, shrunk, absent, skipped };
}

/**
 * @param {{ tier?: string }} entry
 * @returns {boolean}
 */
function isEnforced(entry) {
  return ENFORCED_TIERS.includes(entry?.tier);
}

/**
 * The single definition of the failure set: enforced-tier `grown` + `absent`.
 *
 * @param {ReturnType<typeof diffBudget>} diff
 * @returns {number}
 */
export function budgetFailureCount(diff) {
  const grown = (diff?.grown ?? []).filter(isEnforced).length;
  const absent = (diff?.absent ?? []).filter(isEnforced).length;
  return grown + absent;
}

const REPORT_ONLY_NOTE = ' — reported, never gated';

/**
 * A report-only row is marked `~` with an inline note, so the line itself
 * says whether it broke the build.
 *
 * @param {{ tier: string }} row
 * @param {string} enforcedPrefix
 * @returns {{ prefix: string, note: string }}
 */
function gateMarks(row, enforcedPrefix) {
  return isEnforced(row)
    ? { prefix: enforcedPrefix, note: '' }
    : { prefix: '~', note: REPORT_ONLY_NOTE };
}

/**
 * @param {ReturnType<typeof diffBudget>} diff
 * @returns {string}
 */
export function renderDiff(diff) {
  const lines = [];
  for (const g of diff.grown) {
    const { prefix, note } = gateMarks(g, '+');
    lines.push(
      `${prefix} ${g.tier}: ${g.current} bytes exceeds budget ${g.baseline} + tolerance ${g.tolerance} (delta +${g.delta})${note}`,
    );
  }
  for (const s of diff.shrunk) {
    lines.push(
      `- ${s.tier}: ${s.current} bytes is under the recorded ${s.baseline} (delta -${s.delta}) — the close writes the lower total back to baselines/context-budget.json when this branch lands`,
    );
  }
  for (const a of diff.absent ?? []) {
    const { prefix, note } = gateMarks(a, '-');
    lines.push(
      `${prefix} ${a.tier}: recorded row ${a.path} names a path the measured tier no longer contains — refresh baselines/context-budget.json${note}`,
    );
  }
  const tag = budgetFailureCount(diff) > 0 ? '(gate fail)' : '(ok)';
  lines.push(
    `[context-budget] grown=${diff.grown.length} shrunk=${diff.shrunk.length} absent=${diff.absent?.length ?? 0} skipped=${diff.skipped.length} ${tag}`,
  );
  return lines.join('\n');
}

/**
 * The workflow reachable-closure line, or `''`.
 *
 * @param {{ workflowClosure?: { reachableTotalBytes?: number, entryPoints?: unknown[] } }} tierMap
 * @param {{ workflowClosure?: { reachableTotalBytes?: number } } | null} [baseline]
 * @returns {string}
 */
export function renderReachable(tierMap, baseline) {
  const closure = tierMap?.workflowClosure;
  const current = closure?.reachableTotalBytes ?? 0;
  if (current <= 0) return '';
  const recorded = baseline?.workflowClosure?.reachableTotalBytes;
  const against = Number.isFinite(recorded) ? ` (recorded ${recorded})` : '';
  const entries = closure.entryPoints?.length ?? 0;
  return `  workflow reachable closure: ${current} bytes across ${entries} entry points${against} — drift signal, never gated`;
}

/**
 * The agent-boot size line (total and largest role def), or `''`.
 *
 * @param {{ tiers?: { agentBoot?: Array<{ path: string, bytes: number }> } }} tierMap
 * @returns {string}
 */
function renderAgentBoot(tierMap) {
  const files = tierMap?.tiers?.agentBoot ?? [];
  if (files.length === 0) return '';
  const largest = files.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  return `  agentBoot: ${tierTotalBytes(files)} bytes across ${files.length} role defs, largest ${largest.path} at ${largest.bytes} — reported, never gated`;
}

/**
 * Preserves the recorded tolerance so `--update` never widens the gate.
 *
 * @param {object} params
 * @returns {0}
 */
function writeUpdatedBaseline({ tierMap, resolvedBaselinePath, json, stdout }) {
  const existing = loadBaseline(resolvedBaselinePath);
  const tolerance = Number.isFinite(existing?.toleranceBytes)
    ? existing.toleranceBytes
    : DEFAULT_TOLERANCE_BYTES;
  const envelope = buildBaseline(tierMap, tolerance);
  fs.mkdirSync(path.dirname(resolvedBaselinePath), { recursive: true });
  fs.writeFileSync(
    resolvedBaselinePath,
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  if (!json) {
    stdout.write(
      `[context-budget] wrote baseline ${resolvedBaselinePath} (tolerance ${tolerance} bytes)\n`,
    );
  } else {
    stdout.write(
      `${JSON.stringify({ kind: 'context-budget-update', baselinePath: resolvedBaselinePath, envelope }, null, 2)}\n`,
    );
  }
  return 0;
}

/**
 * @param {object} params
 * @returns {0}
 */
function reportMissingBaseline({
  tierMap,
  resolvedBaselinePath,
  json,
  stdout,
  stderr,
}) {
  if (json) {
    stdout.write(
      `${JSON.stringify({ kind: 'context-budget-report', baselinePath: resolvedBaselinePath, tiers: tierMap.tiers, grown: [], shrunk: [], absent: [], skipped: MEASURED_TIERS, exitCode: 0, noBaseline: true }, null, 2)}\n`,
    );
  } else {
    stderr.write(
      `[context-budget] ⚠ budget not found at ${resolvedBaselinePath} — skipping (no-op)\n`,
    );
  }
  return 0;
}

/**
 * Every verdict is decided here, so the two renderers cannot disagree.
 *
 * @param {{ tierMap: object, baseline: object }} params
 * @returns {{ diff: object, exitCode: 0 | 1 }}
 */
function evaluateBudget({ tierMap, baseline }) {
  const diff = diffBudget(tierMap, baseline);
  return { diff, exitCode: budgetFailureCount(diff) > 0 ? 1 : 0 };
}

/**
 * @param {object} params
 * @returns {void}
 */
function renderJsonReport({
  tierMap,
  baseline,
  resolvedBaselinePath,
  report,
  stdout,
}) {
  const { diff, exitCode } = report;
  const envelope = {
    kind: 'context-budget-report',
    baselinePath: resolvedBaselinePath,
    toleranceBytes: Number.isFinite(baseline.toleranceBytes)
      ? baseline.toleranceBytes
      : 0,
    current: Object.fromEntries(
      MEASURED_TIERS.map((t) => [t, tierTotalBytes(tierMap.tiers[t] ?? [])]),
    ),
    grown: diff.grown,
    shrunk: diff.shrunk,
    absent: diff.absent,
    skipped: diff.skipped,
    enforcedTiers: ENFORCED_TIERS,
    agentBoot: tierMap.tiers?.agentBoot ?? [],
    workflowReachableBytes: tierMap.workflowClosure?.reachableTotalBytes ?? 0,
    exitCode,
  };
  stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

/**
 * One remediation line per failing condition (each is fixed differently).
 *
 * @param {object} params
 * @returns {void}
 */
function renderFailureDiagnostics({ report, stderr }) {
  const { diff } = report;
  if (diff.grown.some(isEnforced)) {
    stderr.write(
      `[context-budget] ❌ the always-loaded documentation tier grew beyond tolerance — every session and every subagent spawn re-pays it. Refresh the budget consciously with \`node .agents/scripts/check-context-budget.js --update\` once the growth is intentional\n`,
    );
  }
  if (diff.absent.some(isEnforced)) {
    stderr.write(
      `[context-budget] ❌ a recorded always-loaded row names a path the measured tier no longer contains — its bytes inflate the recorded total against nothing. Refresh with \`node .agents/scripts/check-context-budget.js --update\`\n`,
    );
  }
}

/**
 * @param {{ tierMap: object, baseline: object | null }} params
 * @returns {string[]}
 */
function optionalReportLines({ tierMap, baseline }) {
  return [renderReachable(tierMap, baseline), renderAgentBoot(tierMap)].filter(
    Boolean,
  );
}

/**
 * @param {object} params
 * @returns {void}
 */
function renderTextReport({ tierMap, baseline, report, stdout, stderr }) {
  const { diff, exitCode } = report;
  stdout.write(`\n--- context-budget preview ---\n`);
  stdout.write(`${renderDiff(diff)}\n`);
  for (const line of optionalReportLines({ tierMap, baseline })) {
    stdout.write(`${line}\n`);
  }
  if (exitCode === 1) renderFailureDiagnostics({ report, stderr });
}

/**
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   config?: object,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} 1 only for enforced-tier drift.
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  config,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { baselinePath, rootPath, update, json } = parseArgv(argv);
  const root = rootPath ? path.resolve(cwd, rootPath) : path.resolve(cwd);
  const resolvedBaselinePath = path.resolve(
    cwd,
    baselinePath ?? path.join('baselines', 'context-budget.json'),
  );
  const resolvedConfig = config ?? resolveConfig();
  const tierMap = resolveDocTiers(resolvedConfig, { root });

  if (update) {
    return writeUpdatedBaseline({
      tierMap,
      resolvedBaselinePath,
      json,
      stdout,
    });
  }

  const baseline = loadBaseline(resolvedBaselinePath);
  if (!baseline) {
    return reportMissingBaseline({
      tierMap,
      resolvedBaselinePath,
      json,
      stdout,
      stderr,
    });
  }

  const report = evaluateBudget({ tierMap, baseline });
  if (json) {
    renderJsonReport({
      tierMap,
      baseline,
      resolvedBaselinePath,
      report,
      stdout,
    });
  } else {
    renderTextReport({ tierMap, baseline, report, stdout, stderr });
  }

  return report.exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'context-budget',
  propagateExitCode: true,
  errorPrefix: '[context-budget] ❌ Fatal error',
});
