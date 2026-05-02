import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
import { Logger } from './lib/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export function parseLintOutput(jsonStr, _cmdConfig) {
  // Parse the JSON array. Find start and end to avoid extraneous shell output
  const startIndex = jsonStr.indexOf('[');
  const endIndex = jsonStr.lastIndexOf(']');
  if (startIndex === -1 || endIndex === -1) {
    if (jsonStr === '') return { errorCount: 0, warningCount: 0 };
    throw new Error(
      'Could not find JSON array in output. Output: ' +
        jsonStr.substring(0, 100),
    );
  }
  const cleanJson = jsonStr.substring(startIndex, endIndex + 1);
  const output = JSON.parse(cleanJson);
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const file of output) {
    totalErrors += file.errorCount || 0;
    totalWarnings += file.warningCount || 0;
  }
  return { errorCount: totalErrors, warningCount: totalWarnings };
}

/**
 * Same JSON parser as `parseLintOutput`, but additionally retains per-file
 * counts and a per-file rule histogram. Used by the `diff` subcommand and by
 * `captureBaseline` so subsequent diffs can attribute deltas to specific
 * rules. Output shape:
 *
 *   {
 *     errorCount: number,
 *     warningCount: number,
 *     byFile: {
 *       [filePath]: {
 *         errorCount: number,
 *         warningCount: number,
 *         rules: { [ruleId]: count }
 *       }
 *     }
 *   }
 *
 * Empty input yields `{ errorCount: 0, warningCount: 0, byFile: {} }`. The
 * function expects the ESLint-style JSON shape (array of objects with
 * `filePath`, `errorCount`, `warningCount`, and `messages[]` carrying
 * `ruleId`); messages without a `ruleId` are bucketed under `<unknown>`.
 */
export function parseLintOutputDetailed(jsonStr, _cmdConfig) {
  const startIndex = jsonStr.indexOf('[');
  const endIndex = jsonStr.lastIndexOf(']');
  if (startIndex === -1 || endIndex === -1) {
    if (jsonStr === '') {
      return { errorCount: 0, warningCount: 0, byFile: {} };
    }
    throw new Error(
      'Could not find JSON array in output. Output: ' +
        jsonStr.substring(0, 100),
    );
  }
  const cleanJson = jsonStr.substring(startIndex, endIndex + 1);
  const output = JSON.parse(cleanJson);
  let totalErrors = 0;
  let totalWarnings = 0;
  const byFile = {};
  for (const file of output) {
    const errorCount = file.errorCount || 0;
    const warningCount = file.warningCount || 0;
    totalErrors += errorCount;
    totalWarnings += warningCount;
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
  return { errorCount: totalErrors, warningCount: totalWarnings, byFile };
}

export function runLintCommand(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  gateModeOpts,
) {
  const parsedArgs = parseArgsStringToArgv(cmdConfig);
  if (parsedArgs.length === 0) {
    console.warn(`⚠️ [lint-baseline] Empty command configuration provided.`);
    return { errorCount: 0, warningCount: 0 };
  }
  const cmd = parsedArgs.shift();
  const cmdArgs = parsedArgs;
  const result = spawnSync(cmd, cmdArgs, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: executionTimeoutMs,
    maxBuffer: executionMaxBuffer,
    shell: false,
  });

  try {
    const jsonStr = result.stdout.trim();
    return parseLintOutput(jsonStr, cmdConfig);
  } catch (err) {
    // Soft-fail contract (Tech Spec #819): the previous behaviour was a
    // silent zero-error fallback, which masked tooling regressions. Now we
    // emit a degraded envelope (or hard-fail in gate-mode) so callers see
    // the explicit signal and can decide whether to abort the gate.
    return softFailOrThrow(
      'LINT_OUTPUT_PARSE_FAILED',
      `lint-baseline: failed to parse JSON from \`${cmdConfig}\`: ${err.message}`,
      gateModeOpts,
    );
  }
}

/**
 * Detailed-parsing twin of `runLintCommand`. Returns `byFile` alongside the
 * totals so the diff subcommand can attribute regressions to specific files
 * and rules. Same degraded-mode contract as the basic runner.
 */
function runLintCommandDetailed(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  gateModeOpts,
) {
  const parsedArgs = parseArgsStringToArgv(cmdConfig);
  if (parsedArgs.length === 0) {
    console.warn(`⚠️ [lint-baseline] Empty command configuration provided.`);
    return { errorCount: 0, warningCount: 0, byFile: {} };
  }
  const cmd = parsedArgs.shift();
  const cmdArgs = parsedArgs;
  const result = spawnSync(cmd, cmdArgs, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: executionTimeoutMs,
    maxBuffer: executionMaxBuffer,
    shell: false,
  });

  try {
    const jsonStr = result.stdout.trim();
    return parseLintOutputDetailed(jsonStr, cmdConfig);
  } catch (err) {
    return softFailOrThrow(
      'LINT_OUTPUT_PARSE_FAILED',
      `lint-baseline: failed to parse JSON from \`${cmdConfig}\`: ${err.message}`,
      gateModeOpts,
    );
  }
}

export function captureBaseline(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  baselinePath,
  baselinePathRel,
  gateModeOpts,
) {
  console.log(`▶ [lint-baseline] Capturing lint baseline...`);
  const detailed = runLintCommandDetailed(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    gateModeOpts,
  );
  if (isDegraded(detailed)) return detailed;
  const dir = path.dirname(baselinePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(detailed, null, 2), 'utf8');
  console.log(
    `✅ Baseline captured: ${detailed.errorCount} errors, ${detailed.warningCount} warnings.`,
  );
  console.log(`   Saved to: ${baselinePathRel}`);
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

function diffBaseline(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  baselinePath,
  baselinePathRel,
  gateModeOpts,
) {
  console.log(`▶ [lint-baseline] Computing per-file regressions...`);
  const current = runLintCommandDetailed(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    gateModeOpts,
  );
  if (isDegraded(current)) return current;

  let baseline = { errorCount: 0, warningCount: 0, byFile: {} };
  let baselineHasByFile = false;
  if (fs.existsSync(baselinePath)) {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    baselineHasByFile =
      baseline &&
      typeof baseline.byFile === 'object' &&
      baseline.byFile !== null;
  } else {
    console.warn(
      `⚠️ No baseline found at ${baselinePathRel}. Treating baseline as empty.`,
    );
  }

  console.log(
    `   Baseline: ${baseline.errorCount ?? 0} errors, ${baseline.warningCount ?? 0} warnings`,
  );
  console.log(
    `   Current:  ${current.errorCount} errors, ${current.warningCount} warnings`,
  );
  console.log('');

  const rows = diffPerFile(baseline, current);
  console.log(formatDiffTable(rows, { baselineHasByFile }));
  return { ...current, regressions: rows };
}

function checkBaseline(
  cmdConfig,
  executionTimeoutMs,
  executionMaxBuffer,
  baselinePath,
  baselinePathRel,
  gateModeOpts,
) {
  console.log(`▶ [lint-baseline] Checking lint against baseline...`);
  const current = runLintCommand(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    gateModeOpts,
  );
  if (isDegraded(current)) return current;

  let baseline = { errorCount: 0, warningCount: 0 };
  if (fs.existsSync(baselinePath)) {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } else {
    console.warn(
      `⚠️ No baseline found at ${baselinePathRel}. Assuming 0 baseline.`,
    );
  }

  console.log(
    `   Baseline: ${baseline.errorCount} errors, ${baseline.warningCount} warnings`,
  );
  console.log(
    `   Current:  ${current.errorCount} errors, ${current.warningCount} warnings`,
  );

  if (
    current.errorCount > baseline.errorCount ||
    current.warningCount > baseline.warningCount
  ) {
    Logger.fatal(
      '\n🚨 LINT DEGRADATION DETECTED! You have introduced new lint issues compared to the baseline.',
    );
  }

  // Ratchet (shrink baseline) if better
  if (
    current.errorCount < baseline.errorCount ||
    current.warningCount < baseline.warningCount
  ) {
    fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2), 'utf8');
    console.log(
      `🎉 Lint health improved! Ratcheted baseline down to current levels.`,
    );
  }

  console.log(`✅ Lint check passed.`);
  return current;
}

export async function main(args = process.argv) {
  const mode = args[2];
  if (mode !== 'capture' && mode !== 'check' && mode !== 'diff') {
    Logger.fatal(
      'Usage: node lint-baseline.js <capture|check|diff> [--gate-mode]',
    );
  }

  const { settings } = resolveConfig();
  const cmdConfig = getCommands({ agentSettings: settings }).lintBaseline;
  const baselinePathRel = getBaselines({ agentSettings: settings }).lint.path;
  const baselinePath = path.resolve(PROJECT_ROOT, baselinePathRel);
  const limits = getLimits({ agentSettings: settings });
  const executionTimeoutMs = limits.executionTimeoutMs;
  const executionMaxBuffer = limits.executionMaxBuffer;

  const gateModeOpts = {
    argv: args.slice(3),
    env: process.env,
  };

  let runner;
  if (mode === 'capture') runner = captureBaseline;
  else if (mode === 'diff') runner = diffBaseline;
  else runner = checkBaseline;
  const result = runner(
    cmdConfig,
    executionTimeoutMs,
    executionMaxBuffer,
    baselinePath,
    baselinePathRel,
    gateModeOpts,
  );

  if (isDegraded(result)) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

runAsCli(import.meta.url, main, { source: 'LintBaseline' });
