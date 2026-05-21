/**
 * review-providers/native.js — Native (in-process) ReviewProvider adapter.
 *
 * Story #2833 (Epic #2815) — extracts the findings-collection logic that
 * previously lived in the retired `.agents/scripts/epic-code-review` CLI into a
 * `ReviewProvider`-shaped adapter. The adapter:
 *
 *   1. Diffs `headRef` against `baseRef` to enumerate changed files.
 *   2. Runs scoped lint (biome + markdownlint) over the changed surface.
 *   3. Computes per-file maintainability reports for changed JS files.
 *   4. Maps each signal to a `Finding` with a `severity` ∈ {critical, high,
 *      medium, suggestion}.
 *
 * The adapter does NOT post to GitHub, does NOT render a markdown body,
 * and does NOT consult the lifecycle bus. Those concerns belong to
 * `runCodeReview()` (which calls the renderer + the structured-comment
 * upserter) and the listener chain.
 *
 * Construction is intentionally zero-arg so the factory can instantiate
 * it without threading config through every call. Per-invocation config
 * (paths, runners, evidence store) is injected via the `runReview` arg or
 * the `createNativeProvider({ deps })` overload used by tests.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').ReviewInput} ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../config-resolver.js';
import { gitSpawn } from '../../git-utils.js';
import {
  calculateReportForFile,
  classifyReport,
} from '../../maintainability-engine.js';
import {
  hashCommandConfig,
  recordPass,
  shouldSkip,
} from '../../validation-evidence.js';

/**
 * Parse stdout/stderr from a lint runner to estimate error vs warning counts.
 *
 * Handles the two runners composing `npm run lint` in this project:
 *   - Biome: emits "Found N error(s)." and "Found N warning(s)." lines.
 *   - markdownlint: emits one diagnostic per issue, plus a trailing
 *     "Summary: N error(s)" line.
 *
 * Severity classification: when the runner exits non-zero but its output
 * matches neither known reporter format, the result is "could not classify" —
 * `executionFailed: true` so callers can degrade the gate to a suggestion +
 * skipped marker rather than mislabelling an environment problem as high risk.
 *
 * Exported for testing.
 *
 * @param {{ status: number, stdout: string, stderr: string }} result
 * @returns {{ errors: number, warnings: number, parsed: boolean, executionFailed: boolean }}
 */
export function parseLintOutput(result) {
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  let errors = 0;
  let warnings = 0;
  let parsed = false;

  const errMatches = combined.matchAll(/Found\s+(\d+)\s+error/gi);
  for (const m of errMatches) {
    errors += Number(m[1]);
    parsed = true;
  }
  const warnMatches = combined.matchAll(/Found\s+(\d+)\s+warning/gi);
  for (const m of warnMatches) {
    warnings += Number(m[1]);
    parsed = true;
  }

  const mdSummary = combined.match(/Summary:\s+(\d+)\s+error/i);
  if (mdSummary) {
    errors += Number(mdSummary[1]);
    parsed = true;
  }

  const executionFailed = !parsed && result.status !== 0;

  return { errors, warnings, parsed, executionFailed };
}

/**
 * Pure: split changed paths into the file lists each lint runner consumes.
 *
 * Exported for testing.
 *
 * @param {string[]} changedFiles
 * @returns {{ code: string[], md: string[] }}
 */
export function partitionFilesForLint(changedFiles) {
  const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|json|jsonc)$/i;
  const code = [];
  const md = [];
  for (const f of changedFiles) {
    if (CODE.test(f)) code.push(f);
    else if (/\.md$/i.test(f)) md.push(f);
  }
  return { code, md };
}

function resolveCurrentSha(cwd, gitSpawnFn = gitSpawn) {
  const res = gitSpawnFn(cwd, 'rev-parse', 'HEAD');
  if (res.status !== 0) return null;
  const sha = (res.stdout || '').trim();
  return sha.length > 0 ? sha : null;
}

function spawnLintRunner(bin, args, cwd) {
  const result = spawnSync('npx', ['--no', bin, ...args], {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Run lint scoped to the changed surface only. Returns a normalized summary
 * compatible with `parseLintOutput` plus a `skipped` flag set when there is
 * no JS or markdown file in the changed set (nothing to lint).
 *
 * @param {string[]} changedFiles
 * @param {string} cwd
 * @param {(bin: string, args: string[], cwd: string) => { status: number, stdout: string, stderr: string }} [runnerFn]
 * @returns {{ errors: number, warnings: number, parsed: boolean, skipped: boolean, mode: 'changed-only', executionFailed?: boolean }}
 */
export function runScopedLint(changedFiles, cwd, runnerFn = spawnLintRunner) {
  const { code, md } = partitionFilesForLint(changedFiles);
  if (code.length === 0 && md.length === 0) {
    return {
      errors: 0,
      warnings: 0,
      parsed: false,
      skipped: true,
      mode: 'changed-only',
    };
  }

  const runs = [];
  if (code.length > 0) runs.push(runnerFn('biome', ['lint', ...code], cwd));
  if (md.length > 0) {
    runs.push(
      runnerFn('markdownlint', [...md, '--ignore', 'node_modules'], cwd),
    );
  }

  let status = 0;
  let stdout = '';
  let stderr = '';
  for (const r of runs) {
    if ((r.status ?? 1) > status) status = r.status ?? 1;
    stdout += r.stdout ?? '';
    stderr += r.stderr ?? '';
  }
  const summary = parseLintOutput({ status, stdout, stderr });
  return { ...summary, skipped: false, mode: 'changed-only' };
}

/**
 * Compute the canonical command-config hash for the scoped-lint runner. The
 * caller passes the partitioned biome + markdown lists so the hash captures
 * the exact set of files; any change to that set invalidates the prior
 * evidence and forces a re-lint.
 *
 * Exported for testing.
 */
export function buildLintEvidenceConfig(changedFiles, cwd) {
  const { code, md } = partitionFilesForLint(changedFiles);
  const args = [];
  if (code.length > 0) args.push('biome', 'lint', ...code);
  if (md.length > 0) {
    args.push('markdownlint', ...md, '--ignore', 'node_modules');
  }
  return hashCommandConfig({
    cmd: 'epic-code-review/scoped-lint',
    args,
    cwd,
  });
}

/**
 * Pure: classify a single file's maintainability report into a row + optional
 * Finding-shaped entries. `reportFn` is the file-classifier (defaults to the
 * engine's `calculateReportForFile`); injected so tests can stub deletion /
 * parse errors without touching disk.
 *
 * @returns {{ row: object|null, criticalFinding: Finding|null, mediumFinding: Finding|null }}
 */
export function classifyChangedFile(relPath, { reportFn, classifier } = {}) {
  const absPath = path.resolve(PROJECT_ROOT, relPath);
  let report;
  try {
    report = reportFn(absPath);
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
 * Walk every changed JS file and accumulate the analysis tally. `reportFn`
 * and `classifier` are injected for testability.
 *
 * @param {string[]} changedFiles
 * @param {{ reportFn?: Function, classifier?: Function }} [deps]
 * @returns {{ totalFiles: number, jsFiles: number, maintainability: object[], criticalFindings: Finding[], mediumFindings: Finding[] }}
 */
export function analyzeChangedFiles(
  changedFiles,
  { reportFn = calculateReportForFile, classifier = classifyReport } = {},
) {
  const results = {
    totalFiles: changedFiles.length,
    jsFiles: 0,
    maintainability: [],
    criticalFindings: [],
    mediumFindings: [],
  };
  for (const relPath of changedFiles) {
    const ext = path.extname(relPath);
    if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') continue;
    results.jsFiles += 1;
    const { row, criticalFinding, mediumFinding } = classifyChangedFile(
      relPath,
      { reportFn, classifier },
    );
    if (!row) continue;
    results.maintainability.push(row);
    if (criticalFinding) results.criticalFindings.push(criticalFinding);
    if (mediumFinding) results.mediumFindings.push(mediumFinding);
  }
  return results;
}

/**
 * Pure: turn a lint summary into Finding(s). Lint errors collapse into a
 * single high-risk finding (the structured comment shows the count); lint
 * warnings collapse into a single suggestion. An `executionFailed` summary
 * produces one suggestion finding describing the runner failure rather than
 * a high-risk false positive.
 *
 * @param {{ errors: number, warnings: number, parsed?: boolean, skipped?: boolean, mode?: string, executionFailed?: boolean, evidenceSkipped?: boolean }} lintSummary
 * @returns {Finding[]}
 */
export function buildLintFindings(lintSummary) {
  if (lintSummary.mode === 'off') return [];
  if (lintSummary.evidenceSkipped) return [];
  if (lintSummary.skipped) return [];
  if (lintSummary.executionFailed) {
    return [
      {
        severity: 'suggestion',
        title: 'Lint runner could not execute',
        body:
          'The scoped lint runner produced no parseable output (binary missing, ' +
          'parse failure, or environment issue). Verify with the canonical ' +
          '`npm run lint` before merging — treating as a suggestion to avoid a ' +
          'false high-risk signal.',
        category: 'lint',
      },
    ];
  }
  const findings = [];
  if (lintSummary.errors > 0) {
    findings.push({
      severity: 'high',
      title: `Lint check failed (${lintSummary.errors} error(s))`,
      body:
        `Scoped lint reported ${lintSummary.errors} error(s) and ` +
        `${lintSummary.warnings} warning(s) on the changed surface. ` +
        'Fix errors before merging.',
      category: 'lint',
    });
  } else if (lintSummary.warnings > 0) {
    findings.push({
      severity: 'suggestion',
      title: `Lint check passed with ${lintSummary.warnings} warning(s)`,
      body:
        `Scoped lint reported ${lintSummary.warnings} warning(s) on the ` +
        'changed surface. Treat as suggestions.',
      category: 'lint',
    });
  }
  return findings;
}

function _emptyResults() {
  return {
    totalFiles: 0,
    jsFiles: 0,
    maintainability: [],
    criticalFindings: [],
    mediumFindings: [],
  };
}

function tryEvidenceSkip({
  storyId,
  epicId,
  useEvidence,
  headSha,
  evidenceCfg,
  shouldSkipFn,
  logger,
}) {
  if (!(useEvidence && storyId && epicId && headSha)) return null;
  const verdict = shouldSkipFn(
    {
      storyId,
      gateName: 'epic-code-review/lint',
      currentSha: headSha,
      configHash: evidenceCfg,
    },
    { cwd: PROJECT_ROOT, epicId },
  );
  if (!verdict.skip) return null;
  logger?.info?.(
    `[native-review] Scoped lint skipped (evidence match: SHA=${headSha.slice(
      0,
      7,
    )}, recorded ${verdict.record?.timestamp ?? 'n/a'}).`,
  );
  return {
    errors: 0,
    warnings: 0,
    parsed: false,
    skipped: true,
    mode: 'changed-only',
    evidenceSkipped: true,
  };
}

function maybeRecordLintEvidence({
  storyId,
  epicId,
  useEvidence,
  headSha,
  evidenceCfg,
  lintSummary,
  recordPassFn,
  logger,
}) {
  const eligible =
    useEvidence &&
    storyId &&
    epicId &&
    headSha &&
    lintSummary.errors === 0 &&
    !lintSummary.skipped;
  if (!eligible) return;
  try {
    recordPassFn(
      {
        storyId,
        gateName: 'epic-code-review/lint',
        sha: headSha,
        configHash: evidenceCfg,
        exitCode: 0,
      },
      { cwd: PROJECT_ROOT, epicId },
    );
  } catch (err) {
    logger?.warn?.(
      `[native-review] Failed to record lint evidence: ${err?.message ?? err}`,
    );
  }
}

async function runLintPhase({
  scopeLint,
  changedFiles,
  storyId,
  epicId,
  useEvidence,
  gitSpawnFn,
  shouldSkipFn,
  recordPassFn,
  runScopedLintFn,
  logger,
}) {
  if (scopeLint === 'off') {
    logger?.info?.(
      '[native-review] Lint scoped off (scopeLint=off); skipping.',
    );
    return {
      errors: 0,
      warnings: 0,
      parsed: false,
      skipped: true,
      mode: 'off',
    };
  }
  const evidenceCfg = buildLintEvidenceConfig(changedFiles, PROJECT_ROOT);
  const headSha = resolveCurrentSha(PROJECT_ROOT, gitSpawnFn);
  const skipSummary = tryEvidenceSkip({
    storyId,
    epicId,
    useEvidence,
    headSha,
    evidenceCfg,
    shouldSkipFn,
    logger,
  });
  if (skipSummary) return skipSummary;

  logger?.info?.(
    '[native-review] Linting changed files only (biome + markdownlint, scoped to diff)...',
  );
  const lintSummary = runScopedLintFn(changedFiles, PROJECT_ROOT);
  maybeRecordLintEvidence({
    storyId,
    epicId,
    useEvidence,
    headSha,
    evidenceCfg,
    lintSummary,
    recordPassFn,
    logger,
  });
  return lintSummary;
}

/**
 * Build a `ReviewProvider` instance backed by the native in-process pipeline.
 *
 * The `deps` overload is the test seam — production callers (the factory)
 * invoke `createNativeProvider()` with no arguments and get the default
 * dependency chain (real git, real lint, real maintainability engine).
 *
 * @param {{
 *   gitSpawnFn?: typeof gitSpawn,
 *   runScopedLintFn?: typeof runScopedLint,
 *   analyzeChangedFilesFn?: typeof analyzeChangedFiles,
 *   buildLintFindingsFn?: typeof buildLintFindings,
 *   shouldSkipFn?: typeof shouldSkip,
 *   recordPassFn?: typeof recordPass,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   scopeLint?: 'changed-only'|'off',
 *   storyId?: number|null,
 *   useEvidence?: boolean,
 * }} [deps]
 * @returns {ReviewProvider}
 */
export function createNativeProvider(deps = {}) {
  const {
    gitSpawnFn = gitSpawn,
    runScopedLintFn = runScopedLint,
    analyzeChangedFilesFn = analyzeChangedFiles,
    buildLintFindingsFn = buildLintFindings,
    shouldSkipFn = shouldSkip,
    recordPassFn = recordPass,
    logger,
    scopeLint = 'changed-only',
    storyId = null,
    useEvidence = true,
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
      const results = analyzeChangedFilesFn(changedFiles);

      // Epic-scope reviews flow through validation-evidence; story-scope
      // reviews currently share the same gate name, keyed on the storyId.
      const epicId = scope === 'epic' ? ticketId : null;
      const lintSummary = await runLintPhase({
        scopeLint,
        changedFiles,
        storyId: storyId ?? (scope === 'story' ? ticketId : null),
        epicId,
        useEvidence,
        gitSpawnFn,
        shouldSkipFn,
        recordPassFn,
        runScopedLintFn,
        logger,
      });

      const lintFindings = buildLintFindingsFn(lintSummary);

      // Canonical ordering: critical (maintainability) first, then high
      // (lint errors), then medium (size/volume warnings), then suggestion
      // (lint warnings / executionFailed). The renderer re-bucketizes by
      // severity tier, so this order only matters for stability of fixture
      // outputs.
      return [
        ...results.criticalFindings,
        ...lintFindings.filter((f) => f.severity === 'high'),
        ...results.mediumFindings,
        ...lintFindings.filter((f) => f.severity === 'suggestion'),
      ];
    },
  };
}

/**
 * Zero-arg factory entry point used by the `review-provider-factory`. Kept
 * separate from `createNativeProvider({ deps })` so the registry signature
 * stays `() => ReviewProvider`.
 *
 * @returns {ReviewProvider}
 */
export function createNativeProviderForRegistry() {
  return createNativeProvider();
}
