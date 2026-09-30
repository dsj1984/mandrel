/**
 * review-providers/native.js — in-process ReviewProvider: maintainability
 * scoring of the changed files, honouring the gate's exemptions. It runs no
 * lint — lint is a close-validation gate the worker's preflight also runs.
 * `input.depth` is ignored by design.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').ReviewInput} ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 */

import path from 'node:path';
import { POOL_SERIAL_THRESHOLD, runOnPool } from '../../cpu-pool.js';
import { gitSpawn } from '../../git-utils.js';
import {
  calculateReport,
  classifyReport,
} from '../../maintainability-engine.js';
import { PROJECT_ROOT } from '../../project-root.js';
import { transpileIfNeeded } from '../../transpile.js';
import {
  resolveMaintainabilityIgnoreGlobs,
  scopeMaintainabilityFiles,
} from './mi-exemptions.js';

const MAINTAINABILITY_REPORT_WORKER_URL = new URL(
  '../../workers/maintainability-report-worker.js',
  import.meta.url,
);

/** Below this JS-file count scoring runs in-process; at or above, on the worker pool. */
export const SERIAL_THRESHOLD = POOL_SERIAL_THRESHOLD;

const JS_MAINTAINABILITY_EXTS = new Set(['.js', '.mjs', '.cjs']);

/**
 * Read the file at `headRef`, never from disk: close runs from the main
 * checkout, where disk holds the BASE content. `null` when absent at head.
 *
 * @param {string} relPath
 * @param {string} headRef
 * @param {typeof gitSpawn} [gitSpawnFn]
 * @returns {string|null}
 */
export function readHeadSource(relPath, headRef, gitSpawnFn = gitSpawn) {
  const res = gitSpawnFn(PROJECT_ROOT, 'show', `${headRef}:${relPath}`);
  if (res.status !== 0) return null;
  return res.stdout ?? '';
}

/**
 * Score a source string (TS transpiled first). Returns a parse-error report
 * rather than throwing.
 *
 * @param {string} source
 * @param {string} relPath  Used only to pick the transpile mode.
 * @returns {ReturnType<typeof calculateReport>}
 */
export function scoreSourceReport(source, relPath) {
  const prepared = transpileIfNeeded(relPath, source);
  if (prepared === null) {
    return {
      moduleScore: 0,
      methods: [],
      worstMethod: null,
      meanMethod: null,
      parseError: true,
    };
  }
  return calculateReport(prepared);
}

/**
 * Classify one file's report into a row plus optional findings. A `reportFn`
 * throw drops the file.
 *
 * @returns {{ row: object|null, criticalFinding: Finding|null, mediumFinding: Finding|null }}
 */
export function classifyChangedFile(relPath, { reportFn, classifier } = {}) {
  let report;
  try {
    report = reportFn(relPath);
  } catch (_err) {
    return { row: null, criticalFinding: null, mediumFinding: null };
  }
  const tier = classifier(report);
  const row = { file: relPath, report, tier };
  if (tier === 'critical') {
    const reason =
      report.worstMethod !== null && report.worstMethod < 20
        ? `worst method ${report.worstMethod.toFixed(1)}`
        : `module score ${report.moduleScore.toFixed(1)}`;
    return {
      row,
      criticalFinding: {
        severity: 'critical',
        title: 'Low Maintainability',
        body:
          `Module \`${relPath}\` reports a critical maintainability tier (${reason}).` +
          '\n\nRefactor toward shorter methods and lower module size before merging.',
        file: relPath,
        category: 'maintainability',
      },
      mediumFinding: null,
    };
  }
  if (tier === 'warning') {
    const moduleScore = report.moduleScore.toFixed(1);
    const worst =
      report.worstMethod !== null
        ? `, worst method ${report.worstMethod.toFixed(1)}`
        : '';
    return {
      row,
      criticalFinding: null,
      mediumFinding: {
        severity: 'medium',
        title: 'Size/Volume Warning',
        body:
          `Module \`${relPath}\` reports a size/volume warning ` +
          `(module ${moduleScore}${worst}).` +
          '\n\nConsider breaking up the module or extracting helpers.',
        file: relPath,
        category: 'maintainability',
      },
    };
  }
  return { row, criticalFinding: null, mediumFinding: null };
}

/**
 * Shared by the serial and pooled paths so both emit identical output.
 *
 * @param {{ totalFiles: number, jsFiles: number, maintainability: object[], criticalFindings: Finding[], mediumFindings: Finding[] }} results
 * @param {{ row: object|null, criticalFinding: Finding|null, mediumFinding: Finding|null }} classified
 */
function accumulateClassified(results, classified) {
  const { row, criticalFinding, mediumFinding } = classified;
  if (!row) return;
  results.maintainability.push(row);
  if (criticalFinding) results.criticalFindings.push(criticalFinding);
  if (mediumFinding) results.mediumFindings.push(mediumFinding);
}

function isJsMaintainabilityFile(relPath) {
  return JS_MAINTAINABILITY_EXTS.has(path.extname(relPath));
}

/**
 * Pooled at or above `serialThreshold`. An injected `reportFn` forces the
 * serial path (a closure cannot cross the worker boundary).
 *
 * @param {string[]} changedFiles
 * @param {{ reportFn?: Function, classifier?: Function, runOnPoolFn?: typeof runOnPool, headRef?: string|null, gitSpawnFn?: typeof gitSpawn, readHeadSourceFn?: typeof readHeadSource, serialThreshold?: number }} [deps]
 * @returns {Promise<{ totalFiles: number, jsFiles: number, maintainability: object[], criticalFindings: Finding[], mediumFindings: Finding[] }>}
 */
export async function analyzeChangedFiles(
  changedFiles,
  {
    reportFn = null,
    classifier = classifyReport,
    runOnPoolFn = runOnPool,
    headRef = null,
    gitSpawnFn = gitSpawn,
    readHeadSourceFn = readHeadSource,
    serialThreshold = SERIAL_THRESHOLD,
  } = {},
) {
  const results = {
    totalFiles: changedFiles.length,
    jsFiles: 0,
    maintainability: [],
    criticalFindings: [],
    mediumFindings: [],
  };

  const jsFiles = changedFiles.filter(isJsMaintainabilityFile);
  results.jsFiles = jsFiles.length;
  if (jsFiles.length === 0) return results;

  const sources = jsFiles.map((relPath) =>
    headRef == null ? '' : readHeadSourceFn(relPath, headRef, gitSpawnFn),
  );

  const scoreReport =
    reportFn ?? ((source, relPath) => scoreSourceReport(source, relPath));
  const customReportFn = reportFn != null;

  if (jsFiles.length < serialThreshold || customReportFn) {
    for (let i = 0; i < jsFiles.length; i += 1) {
      const relPath = jsFiles[i];
      const source = sources[i];
      if (source == null) continue;
      accumulateClassified(
        results,
        classifyChangedFile(relPath, {
          reportFn: () => scoreReport(source, relPath),
          classifier,
        }),
      );
    }
    return results;
  }

  // Send head content (not a disk path) so the worker scores what the serial path does.
  const poolItems = [];
  const poolIndex = []; // poolItems[k] corresponds to jsFiles[poolIndex[k]]
  for (let i = 0; i < jsFiles.length; i += 1) {
    if (sources[i] == null) continue;
    poolItems.push({ source: sources[i], label: jsFiles[i] });
    poolIndex.push(i);
  }
  if (poolItems.length === 0) return results;

  const poolResults = await runOnPoolFn(
    MAINTAINABILITY_REPORT_WORKER_URL,
    poolItems,
  );
  for (let k = 0; k < poolIndex.length; k += 1) {
    const relPath = jsFiles[poolIndex[k]];
    const poolEntry = poolResults[k];
    // A pool error or null report drops the file, as a serial throw does.
    if (!poolEntry || poolEntry.__cpuPoolError || poolEntry.report == null) {
      continue;
    }
    accumulateClassified(
      results,
      classifyChangedFile(relPath, {
        reportFn: () => poolEntry.report,
        classifier,
      }),
    );
  }
  return results;
}

/**
 * @param {{
 *   gitSpawnFn?: typeof gitSpawn,
 *   analyzeChangedFilesFn?: typeof analyzeChangedFiles,
 *   resolveIgnoreGlobsFn?: typeof resolveMaintainabilityIgnoreGlobs,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} [deps]
 * @returns {ReviewProvider}
 */
export function createNativeProvider(deps = {}) {
  const {
    gitSpawnFn = gitSpawn,
    analyzeChangedFilesFn = analyzeChangedFiles,
    resolveIgnoreGlobsFn = resolveMaintainabilityIgnoreGlobs,
    logger,
  } = deps;

  return {
    /**
     * @param {ReviewInput} input
     * @returns {Promise<Finding[]>}
     */
    async runReview(input) {
      const { scope, ticketId, baseRef, headRef } = input ?? {};
      if (!baseRef || !headRef) {
        throw new TypeError(
          '[native-review] runReview requires baseRef and headRef.',
        );
      }
      if (!Number.isInteger(ticketId) || ticketId <= 0) {
        throw new TypeError(
          '[native-review] runReview requires a positive integer ticketId.',
        );
      }

      logger?.info?.(
        `[native-review] Comparing ${headRef} against ${baseRef} for ${scope} #${ticketId}...`,
      );

      const diffResult = gitSpawnFn(
        PROJECT_ROOT,
        'diff',
        `${baseRef}...${headRef}`,
        '--name-only',
      );
      if (diffResult.status !== 0) {
        throw new Error(
          `[native-review] Failed to get diff ${baseRef}...${headRef}: ${diffResult.stderr}`,
        );
      }

      const changedFiles = diffResult.stdout
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);

      if (changedFiles.length === 0) {
        logger?.info?.('[native-review] No changes detected.');
        return [];
      }

      logger?.info?.(
        `[native-review] Analyzing ${changedFiles.length} changed file(s)...`,
      );
      const mi = scopeMaintainabilityFiles(changedFiles, {
        cwd: PROJECT_ROOT,
        resolveIgnoreGlobsFn,
      });
      if (mi.notice) logger?.info?.(mi.notice);
      const results = await analyzeChangedFilesFn(mi.scored, {
        headRef,
        gitSpawnFn,
      });

      // Severity order; only matters for fixture stability.
      return [...results.criticalFindings, ...results.mediumFindings];
    },
  };
}

/**
 * Zero-arg registry entry point.
 *
 * @returns {ReviewProvider}
 */
export function createNativeProviderForRegistry() {
  return createNativeProvider();
}
