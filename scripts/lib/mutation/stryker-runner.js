/**
 * lib/mutation/stryker-runner.js — Invoke Stryker and parse the mutation
 * report (Story #1736, Task #1754).
 *
 * The runner is dependency-injection-friendly so unit tests never have to
 * spawn a real Stryker process. The default `spawnFn` is
 * `child_process.spawnSync`, the default `fsImpl` is `node:fs`, and the
 * default `clock` is `Date.now`.
 *
 * Output contract:
 *
 *   { ok: true, mutationScore: <number>, byWorkspace: { "*": <number>, ... },
 *     reportPath, durationMs }
 *   { ok: false, skipped: true, reason: <string> }
 *   { ok: false, skipped: false, error: <string>, durationMs }
 *
 * Stryker writes its JSON report by default to `reports/mutation/mutation.json`.
 * Consumers that relocate the report can pass `reportPath`. We never parse
 * the much larger per-mutant HTML report — only the JSON summary.
 *
 * `timeoutMs` is honoured via `spawnSync`'s `timeout` option; on TIMEOUT
 * we surface an `ok: false` result rather than throwing so the caller can
 * fold the failure into a single uniform "[mutation] failed" gate line.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { detectStrykerConfig as defaultDetectStrykerConfig } from './config-detector.js';

/** Default per-gate timeout when none is supplied (15 minutes). */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Default Stryker JSON report path (mirrors the Stryker default). */
export const DEFAULT_REPORT_PATH = 'reports/mutation/mutation.json';

/**
 * @typedef {Object} RunResult
 * @property {boolean} ok
 * @property {boolean} [skipped]
 * @property {string} [reason]
 * @property {string} [error]
 * @property {number} [mutationScore]
 * @property {Record<string, number>} [byWorkspace]
 * @property {string} [reportPath]
 * @property {number} [durationMs]
 * @property {number} [exitCode]
 */

/**
 * Run Stryker and return a normalised summary.
 *
 * @param {{
 *   cwd?: string,
 *   configPath?: string | null,
 *   reportPath?: string,
 *   timeoutMs?: number,
 *   workspace?: string,
 *   spawnFn?: typeof defaultSpawnSync,
 *   fsImpl?: typeof fs,
 *   clock?: () => number,
 *   strykerCmd?: string,
 *   strykerArgs?: string[],
 *   detectFn?: typeof defaultDetectStrykerConfig,
 *   skipDetect?: boolean,
 * }} [opts]
 * @returns {Promise<RunResult>}
 */
export async function runStryker(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const reportPath = opts.reportPath ?? DEFAULT_REPORT_PATH;
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const workspace = opts.workspace ?? '*';
  const spawnFn = opts.spawnFn ?? defaultSpawnSync;
  const fsImpl = opts.fsImpl ?? fs;
  const clock = opts.clock ?? (() => Date.now());
  const detectFn = opts.detectFn ?? defaultDetectStrykerConfig;

  // Detection short-circuit: the runner is the single point of "no
  // Stryker config → skip" so callers can fold the same result into a
  // uniform "[mutation] skipped" gate line. `skipDetect` is the escape
  // hatch for tests and for callers that have already detected.
  let resolvedConfigPath = opts.configPath ?? null;
  if (!opts.skipDetect) {
    const detection = detectFn({
      cwd,
      configPath: resolvedConfigPath,
      fsImpl,
    });
    if (!detection.found) {
      return {
        ok: false,
        skipped: true,
        reason:
          detection.reason ??
          'no Stryker config found. Run `npx stryker init` to enable.',
      };
    }
    resolvedConfigPath = detection.path;
  }

  // Default to `npx stryker run` — works whether Stryker is a local devDep
  // or a one-shot install. Consumers with a pinned executable can override.
  const cmd = opts.strykerCmd ?? 'npx';
  const args =
    opts.strykerArgs ??
    (resolvedConfigPath
      ? ['stryker', 'run', '--configFile', resolvedConfigPath]
      : ['stryker', 'run']);

  const startedAt = clock();
  const spawnResult = spawnFn(cmd, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    shell: process.platform === 'win32',
  });
  const durationMs = clock() - startedAt;

  // spawnSync sets `signal` to 'SIGTERM' when the timeout fires.
  if (
    spawnResult.signal === 'SIGTERM' ||
    spawnResult.error?.code === 'ETIMEDOUT'
  ) {
    return {
      ok: false,
      skipped: false,
      error: `Stryker timed out after ${timeoutMs}ms`,
      durationMs,
      exitCode: spawnResult.status ?? -1,
    };
  }

  if (spawnResult.error) {
    return {
      ok: false,
      skipped: false,
      error: `failed to invoke Stryker: ${spawnResult.error.message}`,
      durationMs,
    };
  }

  if (spawnResult.status !== 0) {
    return {
      ok: false,
      skipped: false,
      error: `Stryker exited with status ${spawnResult.status}: ${
        spawnResult.stderr?.trim() || spawnResult.stdout?.trim() || 'no output'
      }`,
      durationMs,
      exitCode: spawnResult.status,
    };
  }

  const absReportPath = path.isAbsolute(reportPath)
    ? reportPath
    : path.resolve(cwd, reportPath);

  if (!fsImpl.existsSync(absReportPath)) {
    return {
      ok: false,
      skipped: false,
      error: `Stryker report not found at ${reportPath} — expected JSON reporter to be enabled`,
      durationMs,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(absReportPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: `failed to parse Stryker report at ${reportPath}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs,
    };
  }

  const summary = summariseReport(parsed, { workspace });
  if (!summary.ok) {
    return {
      ok: false,
      skipped: false,
      error: summary.error,
      durationMs,
    };
  }

  return {
    ok: true,
    mutationScore: summary.mutationScore,
    byWorkspace: summary.byWorkspace,
    reportPath: absReportPath,
    durationMs,
  };
}

/**
 * Pure: parse a Stryker mutation-report payload and return the overall
 * mutation score plus per-workspace breakdown. Exposed for unit testing.
 *
 * The Stryker JSON report shape includes a top-level `files` map keyed by
 * source path, where each entry carries an array of `mutants` with a
 * `status` field. The "mutation score" is the percentage of killed +
 * covered+failed-by-test mutants over the total tested mutants.
 *
 * Status values that count toward the score numerator: `Killed`.
 * Status values that count toward the denominator: `Killed`, `Survived`,
 * `Timeout`, `CompileError`, `RuntimeError`, `NoCoverage`.
 *
 * Stryker also exposes a precomputed `schema.MutationScoreResult` /
 * `metrics.mutationScore` in its `mutation-testing-elements` reports;
 * when present, prefer it over a hand-roll so we never disagree with the
 * Stryker dashboard. The hand-roll is the fallback for older reports
 * that omit the metrics block.
 *
 * @param {unknown} report
 * @param {{ workspace?: string }} [opts]
 * @returns {{ ok: true, mutationScore: number, byWorkspace: Record<string, number> } | { ok: false, error: string }}
 */
export function summariseReport(report, opts = {}) {
  const workspace = opts.workspace ?? '*';

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, error: 'Stryker report must be a JSON object' };
  }

  const reportObj = /** @type {Record<string, unknown>} */ (report);

  // Prefer Stryker's precomputed metrics block when present.
  const metrics = /** @type {Record<string, unknown> | undefined} */ (
    reportObj.metrics
  );
  if (
    metrics &&
    typeof metrics === 'object' &&
    typeof metrics.mutationScore === 'number' &&
    Number.isFinite(metrics.mutationScore)
  ) {
    return {
      ok: true,
      mutationScore: metrics.mutationScore,
      byWorkspace: { [workspace]: metrics.mutationScore },
    };
  }

  const files = /** @type {Record<string, unknown> | undefined} */ (
    reportObj.files
  );
  if (!files || typeof files !== 'object') {
    return {
      ok: false,
      error: "Stryker report missing 'files' map",
    };
  }

  let killed = 0;
  let total = 0;
  for (const entry of Object.values(files)) {
    if (!entry || typeof entry !== 'object') continue;
    const mutants = /** @type {{ mutants?: Array<{ status?: string }> }} */ (
      entry
    ).mutants;
    if (!Array.isArray(mutants)) continue;
    for (const m of mutants) {
      const status = m?.status;
      if (typeof status !== 'string') continue;
      if (countsTowardDenominator(status)) total += 1;
      if (status === 'Killed') killed += 1;
    }
  }

  if (total === 0) {
    return {
      ok: false,
      error: 'Stryker report has no scored mutants',
    };
  }

  const score = (killed / total) * 100;
  return {
    ok: true,
    mutationScore: round2(score),
    byWorkspace: { [workspace]: round2(score) },
  };
}

function countsTowardDenominator(status) {
  return (
    status === 'Killed' ||
    status === 'Survived' ||
    status === 'Timeout' ||
    status === 'CompileError' ||
    status === 'RuntimeError' ||
    status === 'NoCoverage'
  );
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
