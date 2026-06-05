/* node:coverage ignore file -- top-level CLI gate; tested logic lives in lib/gates/baseline-store.js */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgsStringToArgv } from 'string-argv';
import { runAsCli } from './lib/cli-utils.js';
import {
  getBaselines,
  getCommands,
  getLimits,
  resolveConfig,
} from './lib/config-resolver.js';
import { isDegraded, softFailOrThrow } from './lib/degraded-mode.js';
import {
  BaselineNotFoundError,
  loadBaseline,
  writeBaseline,
} from './lib/gates/baseline-store.js';
import { Logger } from './lib/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/**
 * Hardcoded Node `spawnSync` buffer ceiling (Epic #1720 Story #1739 —
 * `limits.executionMaxBuffer` moved from `.agentrc.json` to a
 * framework-internal constant). 10 MiB matches the legacy default;
 * lint output that exceeds this much JSON is a symptom of misconfigured
 * scopes, not a tuning case.
 */
const EXECUTION_MAX_BUFFER = 10485760;

/**
 * Allowlist of command names that resolve via shell-launcher shims on
 * Windows (`.cmd` / `.bat`). Node's `spawnSync({ shell: false })` cannot
 * execute `.cmd` files (post CVE-2024-27980), so commands beginning with
 * one of these names are invoked through the platform shell. Restricting
 * `shell: true` to this fixed set keeps the command-injection surface
 * minimal while making the default `npx eslint …` invocation portable.
 */
const SHIM_LAUNCHERS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn']);

/**
 * Decide how `spawnSync` should be invoked for `cmdConfig`. Returns the
 * full argument tuple — exported for unit testing the shim-detection
 * logic without a real process spawn.
 *
 * @param {string} cmdConfig — operator-configured command string.
 * @returns {{ shell: boolean, command: string, args: string[] }}
 */
export function pickSpawnShape(cmdConfig) {
  const parsedArgs = parseArgsStringToArgv(cmdConfig);
  if (parsedArgs.length === 0) {
    return { shell: false, command: '', args: [] };
  }
  const head = parsedArgs[0];
  if (SHIM_LAUNCHERS.has(head)) {
    return { shell: true, command: cmdConfig, args: [] };
  }
  return { shell: false, command: head, args: parsedArgs.slice(1) };
}

// Shared core: extract the JSON-array tail from shell output, then tally
// errors/warnings. `{ detailed: true }` also returns per-file counts + rule
// histogram (used by `diff` + `captureBaseline` to attribute regressions).
function parseLintShared(jsonStr, { detailed = false } = {}) {
  const empty = detailed
    ? { errorCount: 0, warningCount: 0, byFile: {} }
    : { errorCount: 0, warningCount: 0 };
  const startIndex = jsonStr.indexOf('[');
  const endIndex = jsonStr.lastIndexOf(']');
  if (startIndex === -1 || endIndex === -1) {
    if (jsonStr === '') return empty;
    throw new Error(
      `Could not find JSON array in output. Output: ${jsonStr.substring(0, 100)}`,
    );
  }
  const output = JSON.parse(jsonStr.substring(startIndex, endIndex + 1));
  let totalErrors = 0;
  let totalWarnings = 0;
  const byFile = detailed ? {} : null;
  for (const file of output) {
    const errorCount = file.errorCount || 0;
    const warningCount = file.warningCount || 0;
    totalErrors += errorCount;
    totalWarnings += warningCount;
    if (!detailed) continue;
    if (errorCount === 0 && warningCount === 0) continue;
    const filePath = file.filePath || file.file || '<unknown>';
    const rules = {};
    if (Array.isArray(file.messages)) {
      for (const msg of file.messages) {
        const ruleId = msg.ruleId || msg.rule || '<unknown>';
        rules[ruleId] = (rules[ruleId] || 0) + 1;
      }
    }
    byFile[filePath] = { errorCount, warningCount, rules };
  }
  return detailed
    ? { errorCount: totalErrors, warningCount: totalWarnings, byFile }
    : { errorCount: totalErrors, warningCount: totalWarnings };
}

export function parseLintOutput(jsonStr, _cmdConfig) {
  return parseLintShared(jsonStr, { detailed: false });
}

/**
 * Detailed twin of `parseLintOutput`: returns `byFile` with per-file
 * counts and a rule histogram keyed by ruleId (or `<unknown>`).
 */
export function parseLintOutputDetailed(jsonStr, _cmdConfig) {
  return parseLintShared(jsonStr, { detailed: true });
}

// Soft-fail contract (Tech Spec #819): a JSON-parse failure emits the
// degraded envelope (or hard-fails under `--gate-mode`) so callers see
// the explicit signal rather than a silent zero-error fallback.
function runLintShared(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  gateModeOpts,
  { detailed = false } = {},
) {
  const shape = pickSpawnShape(cmdConfig);
  if (shape.command === '') {
    Logger.warn(`⚠️ [lint-baseline] Empty command configuration provided.`);
    return detailed
      ? { errorCount: 0, warningCount: 0, byFile: {} }
      : { errorCount: 0, warningCount: 0 };
  }
  const result = spawnSync(shape.command, shape.args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: executionTimeoutMs,
    maxBuffer: executionMaxBuffer,
    shell: shape.shell,
  });
  try {
    return parseLintShared(result.stdout.trim(), { detailed });
  } catch (err) {
    return softFailOrThrow(
      'LINT_OUTPUT_PARSE_FAILED',
      `lint-baseline: failed to parse JSON from \`${cmdConfig}\`: ${err.message}`,
      gateModeOpts,
    );
  }
}

export function runLintCommand(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  gateModeOpts,
) {
  return runLintShared(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    gateModeOpts,
    {
      detailed: false,
    },
  );
}

function runLintCommandDetailed(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  gateModeOpts,
) {
  return runLintShared(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    gateModeOpts,
    {
      detailed: true,
    },
  );
}

export function captureBaseline(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  baselinePath,
  baselinePathRel,
  gateModeOpts,
) {
  Logger.info(`▶ [lint-baseline] Capturing lint baseline...`);
  const detailed = runLintCommandDetailed(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    gateModeOpts,
  );
  if (isDegraded(detailed)) return detailed;
  writeBaseline({ baselinePath, data: detailed });
  Logger.info(
    `✅ Baseline captured: ${detailed.errorCount} errors, ${detailed.warningCount} warnings.`,
  );
  Logger.info(`   Saved to: ${baselinePathRel}`);
  return detailed;
}

/**
 * Pure: compute per-file regressions between a baseline and a current
 * detailed snapshot. Returns rows for files where current warnings or errors
 * exceed baseline. Each row carries the delta and the rules contributing the
 * most issues in the current snapshot. Sorted by descending warning delta
 * then descending error delta.
 *
 * Exported for testing.
 *
 * @param {object} baseline   Object loaded from baseline.json (may lack `byFile`).
 * @param {object} current    Detailed snapshot from `runLintCommandDetailed`.
 * @returns {{ file: string, errorDelta: number, warningDelta: number, rules: string[] }[]}
 */
export function diffPerFile(baseline, current) {
  const baseFiles = baseline?.byFile ?? {};
  const curFiles = current?.byFile ?? {};
  const rows = [];
  for (const [filePath, cur] of Object.entries(curFiles)) {
    const base = baseFiles[filePath] ?? { errorCount: 0, warningCount: 0 };
    const errorDelta = cur.errorCount - (base.errorCount || 0);
    const warningDelta = cur.warningCount - (base.warningCount || 0);
    if (errorDelta <= 0 && warningDelta <= 0) continue;
    const rules = Object.entries(cur.rules || {})
      .sort((a, b) => b[1] - a[1])
      .map(([rule]) => rule);
    rows.push({ file: filePath, errorDelta, warningDelta, rules });
  }
  rows.sort((a, b) => {
    if (b.warningDelta !== a.warningDelta) {
      return b.warningDelta - a.warningDelta;
    }
    return b.errorDelta - a.errorDelta;
  });
  return rows;
}

/**
 * Pure: render the diff rows as a fixed-width table suitable for terminal
 * output. When there are no regressions, emits a single line. When the
 * baseline lacks `byFile`, prepends a one-line note so operators understand
 * why every currently-warning file shows as "new".
 *
 * Exported for testing.
 */
export function formatDiffTable(rows, { baselineHasByFile } = {}) {
  if (rows.length === 0) {
    return '✅ No per-file regressions detected.';
  }
  const FILE_HEADER = 'File';
  const DELTA_HEADER = 'Δ warn/err';
  const RULES_HEADER = 'rules';
  const fileWidth = Math.max(
    FILE_HEADER.length,
    ...rows.map((r) => r.file.length),
  );
  const deltaCells = rows.map((r) => `+${r.warningDelta}w / +${r.errorDelta}e`);
  const deltaWidth = Math.max(
    DELTA_HEADER.length,
    ...deltaCells.map((c) => c.length),
  );
  const lines = [];
  if (!baselineHasByFile) {
    lines.push(
      'ℹ️ Baseline has no per-file data; treating every regression as "new since baseline".',
    );
  }
  lines.push(
    `${FILE_HEADER.padEnd(fileWidth)}  ${DELTA_HEADER.padEnd(deltaWidth)}  ${RULES_HEADER}`,
  );
  lines.push(
    `${'-'.repeat(fileWidth)}  ${'-'.repeat(deltaWidth)}  ${'-'.repeat(RULES_HEADER.length)}`,
  );
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const ruleStr = r.rules.length > 0 ? r.rules.join(', ') : '(no ruleId)';
    lines.push(
      `${r.file.padEnd(fileWidth)}  ${deltaCells[i].padEnd(deltaWidth)}  ${ruleStr}`,
    );
  }
  return lines.join('\n');
}

/**
 * Load the baseline at `baselinePath` and return an empty-shape fallback when
 * it is missing. `BaselineNotFoundError` is the only error class we tolerate
 * — anything else propagates. Pure-ish (warns via Logger).
 *
 * @param {{ baselinePath: string, baselinePathRel: string, includeByFile: boolean }} args
 * @returns {{ baseline: object, baselineHasByFile: boolean }}
 */
export function loadBaselineWithFallback({
  baselinePath,
  baselinePathRel,
  includeByFile,
}) {
  const emptyBaseline = includeByFile
    ? { errorCount: 0, warningCount: 0, byFile: {} }
    : { errorCount: 0, warningCount: 0 };
  try {
    const baseline = loadBaseline({ baselinePath });
    const baselineHasByFile =
      includeByFile &&
      baseline &&
      typeof baseline.byFile === 'object' &&
      baseline.byFile !== null;
    return { baseline, baselineHasByFile };
  } catch (err) {
    if (!(err instanceof BaselineNotFoundError)) throw err;
    const msg = includeByFile
      ? `⚠️ No baseline found at ${baselinePathRel}. Treating baseline as empty.`
      : `⚠️ No baseline found at ${baselinePathRel}. Assuming 0 baseline.`;
    Logger.warn(msg);
    return { baseline: emptyBaseline, baselineHasByFile: false };
  }
}

export function diffBaseline(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  baselinePath,
  baselinePathRel,
  gateModeOpts,
) {
  Logger.info(`▶ [lint-baseline] Computing per-file regressions...`);
  const current = runLintCommandDetailed(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    gateModeOpts,
  );
  if (isDegraded(current)) return current;

  const { baseline, baselineHasByFile } = loadBaselineWithFallback({
    baselinePath,
    baselinePathRel,
    includeByFile: true,
  });

  Logger.info(
    `   Baseline: ${baseline.errorCount ?? 0} errors, ${baseline.warningCount ?? 0} warnings`,
  );
  Logger.info(
    `   Current:  ${current.errorCount} errors, ${current.warningCount} warnings`,
  );
  Logger.info('');

  const rows = diffPerFile(baseline, current);
  Logger.info(formatDiffTable(rows, { baselineHasByFile }));
  return { ...current, regressions: rows };
}

/** Pure predicate: current snapshot has more errors or warnings than baseline. */
export function hasDegraded(current, baseline) {
  return (
    current.errorCount > baseline.errorCount ||
    current.warningCount > baseline.warningCount
  );
}

/** Pure predicate: current snapshot has strictly fewer of either count. */
export function hasImproved(current, baseline) {
  return (
    current.errorCount < baseline.errorCount ||
    current.warningCount < baseline.warningCount
  );
}

export function checkBaseline(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  baselinePath,
  baselinePathRel,
  gateModeOpts,
) {
  Logger.info(`▶ [lint-baseline] Checking lint against baseline...`);
  const current = runLintCommand(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    gateModeOpts,
  );
  if (isDegraded(current)) return current;

  const { baseline } = loadBaselineWithFallback({
    baselinePath,
    baselinePathRel,
    includeByFile: false,
  });

  Logger.info(
    `   Baseline: ${baseline.errorCount} errors, ${baseline.warningCount} warnings`,
  );
  Logger.info(
    `   Current:  ${current.errorCount} errors, ${current.warningCount} warnings`,
  );

  if (hasDegraded(current, baseline)) {
    throw new Error(
      '\n🚨 LINT DEGRADATION DETECTED! You have introduced new lint issues compared to the baseline.',
    );
  }
  if (hasImproved(current, baseline)) {
    writeBaseline({ baselinePath, data: current });
    Logger.info(
      `🎉 Lint health improved! Ratcheted baseline down to current levels.`,
    );
  }

  Logger.info(`✅ Lint check passed.`);
  return current;
}

/**
 * Orchestration body of `main` extracted as a sibling exported function so
 * the validate / dispatch / classify-degraded ladder is unit-testable
 * without spawning a process. `main` becomes a thin shell: parse → call
 * this → render → exit. CLI surface unchanged (same modes, same exit
 * codes, same stdout JSON schema for degraded envelopes).
 *
 * Note: `checkBaseline` itself still throws on real lint degradation
 * (preserved CLI behaviour — `runAsCli` maps the throw to exit 1). Tests
 * for the validation-error branch use the explicit `'invalid'` mode which
 * never reaches the runner.
 *
 * @param {{ mode: string, gateModeArgv?: string[] }} values
 * @param {{
 *   resolveConfig?: typeof resolveConfig,
 *   runners?: { capture?: Function, check?: Function, diff?: Function },
 *   env?: Record<string, string|undefined>,
 *   projectRoot?: string,
 * }} [deps]
 * @returns {Promise<{ exitCode: number, result: object }>}
 *   `result.kind` is one of: `'validation-error'`, `'envelope'`. Envelopes
 *   carry the raw runner output; `exitCode === 1` iff `isDegraded(envelope)`.
 */
export async function runLintBaselineCli(values, deps = {}) {
  const { mode, gateModeArgv = [] } = values;
  if (mode !== 'capture' && mode !== 'check' && mode !== 'diff') {
    return {
      exitCode: 1,
      result: {
        kind: 'validation-error',
        message:
          'Usage: node lint-baseline.js <capture|check|diff> [--gate-mode]',
      },
    };
  }

  const cfg = deps.resolveConfig ? deps.resolveConfig() : resolveConfig();
  const cmdConfig = getCommands(cfg).lintBaseline;
  const baselinePathRel = getBaselines(cfg).lint.path;
  const projectRoot = deps.projectRoot ?? PROJECT_ROOT;
  const baselinePath = path.resolve(projectRoot, baselinePathRel);
  const limits = getLimits(cfg);
  const env = deps.env ?? process.env;

  const gateModeOpts = { argv: gateModeArgv, env };

  const runners = deps.runners ?? {
    capture: captureBaseline,
    check: checkBaseline,
    diff: diffBaseline,
  };
  const runner = runners[mode];
  // Hardcoded post-reshape (Epic #1720 Story #1739) — see EXECUTION_MAX_BUFFER.
  const envelope = runner(
    cmdConfig,
    limits.executionTimeoutMs,
    EXECUTION_MAX_BUFFER,
    baselinePath,
    baselinePathRel,
    gateModeOpts,
  );

  return {
    exitCode: isDegraded(envelope) ? 1 : 0,
    result: { kind: 'envelope', envelope },
  };
}

export async function main(args = process.argv) {
  const values = { mode: args[2], gateModeArgv: args.slice(3) };
  const { exitCode, result } = await runLintBaselineCli(values);

  if (result.kind === 'validation-error') {
    throw new Error(result.message);
  }
  // kind === 'envelope': only print on degraded soft-fail (preserves
  // pre-refactor stdout contract — happy paths stay quiet on stdout).
  if (exitCode === 1 && isDegraded(result.envelope)) {
    process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
  }
  process.exit(exitCode);
}

runAsCli(import.meta.url, main, { source: 'LintBaseline' });
