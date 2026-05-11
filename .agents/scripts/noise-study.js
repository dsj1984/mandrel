#!/usr/bin/env node
/**
 * Empirical noise study for the maintainability + CRAP gates.
 *
 * Purpose
 * -------
 * The MI and CRAP gates fail closed on a configurable per-row tolerance. The
 * default tolerances were picked by inspection (0.5 for MI, 0.05 for CRAP)
 * based on a handful of observed flaps. Story #1397 retunes them against
 * empirical noise: we capture per-row scores across N repeated runs against a
 * fixed reference commit, then derive per-row stddev + p95 drift and a
 * recommended-threshold table that covers the observed noise floor.
 *
 * Sources of noise
 * ----------------
 *   - MI (`calculateAll`): pure function of source bytes — should be 0.
 *     We still capture it to confirm the floor.
 *   - CRAP (`scanAndScore`): depends on per-method coverage from the
 *     `coverage/coverage-final.json` artifact, which Node 22 V8
 *     instrumentation produces non-deterministically (especially on
 *     Windows). This is where the real drift lives.
 *
 * Strategy
 * --------
 * For each of N runs:
 *   1. Spawn `npm run test:coverage` to regenerate
 *      `coverage/coverage-final.json` against the current working tree.
 *   2. In-process: call `scanAndScore({ targetDirs, coverage })` for CRAP
 *      and `calculateAll(files)` for MI. Both helpers are imported
 *      directly — no second spawn — so the noise study measures the
 *      scorer + coverage layer, not the CLI wrapper.
 *   3. Collect per-row scores keyed by stable identity:
 *        - MI:   `<file>`
 *        - CRAP: `<file>::<method>@<startLine>`
 *
 * Per row across runs we compute mean, stddev, and p95 of the absolute
 * deviation from the row mean. The recommended threshold for each gate is
 * the population p95 absolute deviation across all rows, rounded to two
 * decimals — that is, "at p95 of observed noise, the threshold absorbs the
 * drift without flagging real changes."
 *
 * The CSV per-row dump is written next to the markdown report (same stem,
 * `.csv` extension). The markdown report includes:
 *   - run metadata (runs, runner OS, Node version, git ref, dates)
 *   - top-N noisiest MI rows by p95 abs-drift
 *   - top-N noisiest CRAP rows by p95 abs-drift
 *   - recommended-threshold block (machine-readable + prose)
 *
 * Pure aggregation helpers (`accumulateRowSamples`, `summarizeRows`,
 * `recommendThresholds`, `renderMarkdownReport`) are exported for unit
 * tests so the math contract is pinned without spawning child processes.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import { loadCoverage } from './lib/coverage-utils.js';
import { scanAndScore } from './lib/crap-utils.js';
import { Logger } from './lib/Logger.js';
import { calculateAll, scanDirectory } from './lib/maintainability-utils.js';

// --- Constants -------------------------------------------------------------

/**
 * Hard ceiling on `--runs`. The noise study is designed for ≤30 reps per
 * runner. Beyond ~50 the CI wall-clock blows past a reasonable workflow
 * timeout (test:coverage averages ~30–60s per run on a fresh worktree).
 * Capping here is a guardrail against operator typos and runaway loops.
 */
export const MAX_RUNS = 100;
export const DEFAULT_RUNS = 30;

// --- CLI parsing -----------------------------------------------------------

/**
 * Parse the noise-study CLI flags. Pure for testability.
 *
 * Supported flags:
 *   --runs <n>           Number of reps. Default 30. Capped at MAX_RUNS.
 *   --out <path>         Markdown report path. Required.
 *   --skip-coverage      Skip the `npm run test:coverage` step (use the
 *                        existing coverage map for every run). Useful for
 *                        smoke-testing the aggregation pipeline.
 *   --target-dirs <a,b>  Override CRAP/MI target directories (comma-list).
 *                        Default: read from `.agentrc.json`.
 *
 * Returns `{ runs, outPath, skipCoverage, targetDirs }`.
 *
 * @param {string[]} argv
 * @returns {{ runs: number, outPath: string|null, skipCoverage: boolean, targetDirs: string[]|null }}
 */
export function parseArgv(argv = process.argv.slice(2)) {
  const out = {
    runs: DEFAULT_RUNS,
    outPath: null,
    skipCoverage: false,
    targetDirs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--runs' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0) {
        out.runs = Math.min(parsed, MAX_RUNS);
      }
      i += 1;
    } else if (flag === '--out' && argv[i + 1]) {
      out.outPath = argv[i + 1];
      i += 1;
    } else if (flag === '--skip-coverage') {
      out.skipCoverage = true;
    } else if (flag === '--target-dirs' && argv[i + 1]) {
      out.targetDirs = String(argv[i + 1])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    }
  }
  return out;
}

// --- Pure aggregation ------------------------------------------------------

/**
 * Accumulate one run's worth of samples into the per-row map.
 *
 * The `rowKey` function maps a sample row to its stable identity (file for
 * MI; `file::method@line` for CRAP). Keeping the key extraction injectable
 * keeps the helper agnostic to which gate it's aggregating.
 *
 * @template R
 * @param {Map<string, { samples: number[], meta: R }>} acc
 * @param {Iterable<R>} rows
 * @param {(row: R) => string} rowKey
 * @param {(row: R) => number} rowScore
 * @returns {Map<string, { samples: number[], meta: R }>}
 */
export function accumulateRowSamples(acc, rows, rowKey, rowScore) {
  for (const row of rows) {
    const key = rowKey(row);
    const score = rowScore(row);
    if (!Number.isFinite(score)) continue;
    const existing = acc.get(key);
    if (existing) {
      existing.samples.push(score);
    } else {
      acc.set(key, { samples: [score], meta: row });
    }
  }
  return acc;
}

/**
 * Compute mean, stddev, and p95 absolute deviation for one sample array.
 * Returns zeros when the sample is empty or has only one observation
 * (stddev/p95 are undefined for n<2 — the contract is "no measurable
 * noise").
 *
 * @param {number[]} samples
 * @returns {{ mean: number, stddev: number, p95AbsDev: number, min: number, max: number, n: number }}
 */
export function describeSamples(samples) {
  const n = samples.length;
  if (n === 0) {
    return { mean: 0, stddev: 0, p95AbsDev: 0, min: 0, max: 0, n: 0 };
  }
  let min = samples[0];
  let max = samples[0];
  let sum = 0;
  for (const v of samples) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  if (n < 2) {
    return { mean, stddev: 0, p95AbsDev: 0, min, max, n };
  }
  let sqSum = 0;
  const absDevs = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const d = samples[i] - mean;
    sqSum += d * d;
    absDevs[i] = Math.abs(d);
  }
  // Population stddev — we have the entire sample set, not an estimator.
  const stddev = Math.sqrt(sqSum / n);
  absDevs.sort((a, b) => a - b);
  // Linear interpolation between the two flanking ranks (R-7 / numpy default).
  const idx = 0.95 * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  const p95AbsDev = absDevs[lo] + (absDevs[hi] - absDevs[lo]) * frac;
  return { mean, stddev, p95AbsDev, min, max, n };
}

/**
 * Summarize an accumulator into an array of `{ key, meta, ...stats }` rows
 * sorted by descending p95 abs-deviation (noisiest first).
 *
 * @template R
 * @param {Map<string, { samples: number[], meta: R }>} acc
 * @returns {Array<{ key: string, meta: R, mean: number, stddev: number, p95AbsDev: number, min: number, max: number, n: number }>}
 */
export function summarizeRows(acc) {
  const out = [];
  for (const [key, { samples, meta }] of acc.entries()) {
    out.push({ key, meta, ...describeSamples(samples) });
  }
  out.sort((a, b) => b.p95AbsDev - a.p95AbsDev);
  return out;
}

/**
 * Recommend per-gate tolerances from the per-row p95 abs-deviation vector.
 * The recommendation is the across-rows p95 of the per-row p95 (i.e. "set
 * the tolerance high enough to absorb the noisiest 95% of rows at their
 * own 95th-percentile drift").
 *
 * Optionally widens by `safetyMultiplier` (default 1.0 — the empirical p95
 * is its own safety margin; bump if you want headroom).
 *
 * Returns the raw value plus a rounded suggestion (2 decimals) suitable
 * for pasting into `.agents/default-agentrc.json`.
 *
 * @param {Array<{ p95AbsDev: number }>} summarizedRows
 * @param {number} [safetyMultiplier]
 * @returns {{ raw: number, recommended: number, sampleCount: number }}
 */
export function recommendThresholds(summarizedRows, safetyMultiplier = 1.0) {
  const xs = summarizedRows
    .map((r) => r.p95AbsDev)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) {
    return { raw: 0, recommended: 0, sampleCount: 0 };
  }
  const idx = 0.95 * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  const raw = xs[lo] + (xs[hi] - xs[lo]) * frac;
  const widened = raw * safetyMultiplier;
  // Round up to 2 decimals so the recommendation always covers the
  // observed p95, never trims it.
  const recommended = Math.ceil(widened * 100) / 100;
  return { raw, recommended, sampleCount: n };
}

/**
 * Render the markdown report body. Pure for snapshot-style testing.
 *
 * @param {{
 *   runs: number,
 *   runnerOs: string,
 *   nodeVersion: string,
 *   gitRef: string,
 *   capturedAt: string,
 *   miSummary: ReturnType<typeof summarizeRows>,
 *   crapSummary: ReturnType<typeof summarizeRows>,
 *   miRecommendation: ReturnType<typeof recommendThresholds>,
 *   crapRecommendation: ReturnType<typeof recommendThresholds>,
 *   topN?: number,
 * }} input
 * @returns {string}
 */
export function renderMarkdownReport(input) {
  const {
    runs,
    runnerOs,
    nodeVersion,
    gitRef,
    capturedAt,
    miSummary,
    crapSummary,
    miRecommendation,
    crapRecommendation,
    topN = 20,
  } = input;
  const lines = [];
  lines.push(`# Noise study — ${capturedAt}`);
  lines.push('');
  lines.push(
    'Empirical per-row drift across N repeated runs of `npm run test:coverage`',
  );
  lines.push(
    'against a fixed reference commit. Source rows are scored via the in-process',
  );
  lines.push(
    '`scanAndScore` (CRAP) and `calculateAll` (MI) helpers; the only source of',
  );
  lines.push('inter-run variation is the V8 coverage map produced by Node 22.');
  lines.push('');
  lines.push('## Run metadata');
  lines.push('');
  lines.push(`- Runs per runner: **${runs}**`);
  lines.push(`- Runner OS: \`${runnerOs}\``);
  lines.push(`- Node version: \`${nodeVersion}\``);
  lines.push(`- Git ref: \`${gitRef}\``);
  lines.push('');
  lines.push('## Recommended thresholds');
  lines.push('');
  lines.push(
    'Set per-gate tolerance to cover the across-row p95 of the per-row',
  );
  lines.push(
    'p95 absolute deviation (i.e. "the noisiest 95% of rows are absorbed',
  );
  lines.push('at their own p95 drift"). Values are rounded up to 2 decimals.');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "agentSettings": {');
  lines.push('    "quality": {');
  lines.push('      "maintainability": {');
  lines.push(`        "tolerance": ${miRecommendation.recommended.toFixed(2)}`);
  lines.push('      },');
  lines.push('      "crap": {');
  lines.push(
    `        "tolerance": ${crapRecommendation.recommended.toFixed(2)}`,
  );
  lines.push('      }');
  lines.push('    }');
  lines.push('  }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push(
    `- **MI tolerance**: recommended **${miRecommendation.recommended.toFixed(2)}** ` +
      `(raw across-row p95 = ${miRecommendation.raw.toFixed(4)}, ` +
      `${miRecommendation.sampleCount} rows sampled)`,
  );
  lines.push(
    `- **CRAP tolerance**: recommended **${crapRecommendation.recommended.toFixed(2)}** ` +
      `(raw across-row p95 = ${crapRecommendation.raw.toFixed(4)}, ` +
      `${crapRecommendation.sampleCount} rows sampled)`,
  );
  lines.push('');
  lines.push(`## Top ${topN} noisiest MI rows`);
  lines.push('');
  lines.push('| File | n | mean | stddev | p95 abs-dev | min | max |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of miSummary.slice(0, topN)) {
    lines.push(
      `| \`${row.key}\` | ${row.n} | ${row.mean.toFixed(2)} | ` +
        `${row.stddev.toFixed(4)} | ${row.p95AbsDev.toFixed(4)} | ` +
        `${row.min.toFixed(2)} | ${row.max.toFixed(2)} |`,
    );
  }
  if (miSummary.length === 0) {
    lines.push('| _(no MI rows captured)_ | | | | | | |');
  }
  lines.push('');
  lines.push(`## Top ${topN} noisiest CRAP rows`);
  lines.push('');
  lines.push('| Method | n | mean | stddev | p95 abs-dev | min | max |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of crapSummary.slice(0, topN)) {
    lines.push(
      `| \`${row.key}\` | ${row.n} | ${row.mean.toFixed(2)} | ` +
        `${row.stddev.toFixed(4)} | ${row.p95AbsDev.toFixed(4)} | ` +
        `${row.min.toFixed(2)} | ${row.max.toFixed(2)} |`,
    );
  }
  if (crapSummary.length === 0) {
    lines.push('| _(no CRAP rows captured)_ | | | | | | |');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Render the per-row CSV dump. One row per (gate, key) pair carrying the
 * full per-run sample series — downstream tools can re-aggregate without
 * re-running the study.
 *
 * @param {ReturnType<typeof summarizeRows>} miSummary
 * @param {ReturnType<typeof summarizeRows>} crapSummary
 * @param {Map<string, { samples: number[] }>} miAcc
 * @param {Map<string, { samples: number[] }>} crapAcc
 * @returns {string}
 */
export function renderCsv(miSummary, crapSummary, miAcc, crapAcc) {
  const lines = ['gate,key,n,mean,stddev,p95AbsDev,min,max,samples'];
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(6) : '');
  for (const row of miSummary) {
    const samples = miAcc.get(row.key)?.samples ?? [];
    lines.push(
      [
        'mi',
        JSON.stringify(row.key),
        row.n,
        fmt(row.mean),
        fmt(row.stddev),
        fmt(row.p95AbsDev),
        fmt(row.min),
        fmt(row.max),
        JSON.stringify(samples.map(fmt).join('|')),
      ].join(','),
    );
  }
  for (const row of crapSummary) {
    const samples = crapAcc.get(row.key)?.samples ?? [];
    lines.push(
      [
        'crap',
        JSON.stringify(row.key),
        row.n,
        fmt(row.mean),
        fmt(row.stddev),
        fmt(row.p95AbsDev),
        fmt(row.min),
        fmt(row.max),
        JSON.stringify(samples.map(fmt).join('|')),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

// --- Side-effecting capture (CLI path) -------------------------------------

/**
 * Spawn `npm run test:coverage` once and return its exit code.
 * On failure we log and continue — a single failed run shouldn't abort the
 * whole study; the per-row aggregation handles missing samples.
 *
 * @param {string} cwd
 * @returns {number}
 */
function runCoverageOnce(cwd) {
  const result = spawnSync('npm', ['run', 'test:coverage'], {
    cwd,
    stdio: 'inherit',
    shell: true,
  });
  return result.status ?? 1;
}

/**
 * Resolve the list of MI source files for the given `targetDirs`.
 * Mirrors `check-maintainability.js`'s working-tree scan.
 *
 * @param {string[]} targetDirs
 * @param {string} cwd
 * @returns {string[]}
 */
function resolveMiFiles(targetDirs, cwd) {
  const files = [];
  for (const dir of targetDirs) {
    const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
    scanDirectory(abs, files);
  }
  return files;
}

async function captureOneRun({
  cwd,
  miTargetDirs,
  crapTargetDirs,
  coveragePath,
  skipCoverage,
}) {
  if (!skipCoverage) {
    const code = runCoverageOnce(cwd);
    if (code !== 0) {
      Logger.warn(
        `[noise-study] coverage run exited with code ${code}; continuing with whatever map is on disk`,
      );
    }
  }
  const coverageAbs = path.isAbsolute(coveragePath)
    ? coveragePath
    : path.resolve(cwd, coveragePath);
  const coverage = loadCoverage(coverageAbs);

  const miFiles = resolveMiFiles(miTargetDirs, cwd);
  const miScores = await calculateAll(miFiles);
  const crapScan = await scanAndScore({
    targetDirs: crapTargetDirs,
    coverage,
    requireCoverage: true,
    cwd,
  });
  return { miScores, crapRows: crapScan.rows };
}

/**
 * Best-effort git ref resolution. Falls back to `(unknown)` so the report
 * still renders when `git` isn't on PATH.
 *
 * @param {string} cwd
 * @returns {string}
 */
function resolveGitRef(cwd) {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      shell: false,
    });
    if (result.status === 0 && typeof result.stdout === 'string') {
      return result.stdout.trim() || '(unknown)';
    }
  } catch {
    // fall through
  }
  return '(unknown)';
}

async function main() {
  const args = parseArgv();
  if (!args.outPath) {
    Logger.error(
      '[noise-study] --out <path> is required (e.g. docs/noise-study-2026-05-11.md)',
    );
    process.exit(2);
  }
  const cwd = process.cwd();
  const { agentSettings } = resolveConfig();
  const quality = getQuality({ agentSettings });
  const miTargetDirs = args.targetDirs ?? quality.maintainability.targetDirs;
  const crapTargetDirs = args.targetDirs ?? quality.crap.targetDirs;
  const coveragePath =
    quality.crap.coveragePath ?? 'coverage/coverage-final.json';

  Logger.info(
    `[noise-study] runs=${args.runs} miDirs=${miTargetDirs.join(',')} crapDirs=${crapTargetDirs.join(',')} skipCoverage=${args.skipCoverage}`,
  );

  const miAcc = new Map();
  const crapAcc = new Map();
  for (let i = 0; i < args.runs; i += 1) {
    Logger.info(`[noise-study] run ${i + 1}/${args.runs}`);
    let result;
    try {
      result = await captureOneRun({
        cwd,
        miTargetDirs,
        crapTargetDirs,
        coveragePath,
        skipCoverage: args.skipCoverage,
      });
    } catch (err) {
      Logger.warn(
        `[noise-study] run ${i + 1} failed: ${err?.message ?? err}; skipping`,
      );
      continue;
    }
    accumulateRowSamples(
      miAcc,
      Object.entries(result.miScores).map(([file, score]) => ({ file, score })),
      (r) => r.file,
      (r) => r.score,
    );
    accumulateRowSamples(
      crapAcc,
      result.crapRows,
      (r) => `${r.file}::${r.method}@${r.startLine}`,
      (r) => r.crap,
    );
  }

  const miSummary = summarizeRows(miAcc);
  const crapSummary = summarizeRows(crapAcc);
  const miRecommendation = recommendThresholds(miSummary);
  const crapRecommendation = recommendThresholds(crapSummary);

  const reportBody = renderMarkdownReport({
    runs: args.runs,
    runnerOs: process.platform,
    nodeVersion: process.version,
    gitRef: resolveGitRef(cwd),
    capturedAt: new Date().toISOString(),
    miSummary,
    crapSummary,
    miRecommendation,
    crapRecommendation,
  });

  const outAbs = path.isAbsolute(args.outPath)
    ? args.outPath
    : path.resolve(cwd, args.outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, reportBody);
  const csvAbs = outAbs.replace(/\.md$/i, '.csv');
  fs.writeFileSync(csvAbs, renderCsv(miSummary, crapSummary, miAcc, crapAcc));

  Logger.info(`[noise-study] wrote ${outAbs}`);
  Logger.info(`[noise-study] wrote ${csvAbs}`);
  Logger.info(
    `[noise-study] recommended MI tolerance=${miRecommendation.recommended.toFixed(2)} CRAP tolerance=${crapRecommendation.recommended.toFixed(2)}`,
  );
}

// Windows-aware main-guard: only run when invoked directly so the pure
// helpers stay importable from tests.
const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = fileURLToPath(import.meta.url);
    return path.resolve(self) === invoked;
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((err) => {
    Logger.error(`[noise-study] fatal: ${err?.stack ?? err?.message ?? err}`);
    process.exit(1);
  });
}
