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
 * **Depth is deliberately ignored here (Story #3937).** The pluggable review
 * contract threads a risk-derived `depth` lever (`light` / `standard` /
 * `deep`) on `ReviewInput` so LLM-backed providers can dial their thoroughness
 * up or down with the Epic's judged risk. This native adapter does not read
 * `input.depth` and does not branch on it: its work is a *mechanical* lint +
 * maintainability sweep whose cost already scales with the diff — every
 * changed file is linted once and every changed JS file is scored once,
 * regardless of risk tier. There is no "review harder" knob a deterministic
 * scorer can turn: a high-risk diff and a low-risk diff of the same size do
 * exactly the same amount of work. The contract is therefore explicit rather
 * than silently dropping the field — `depth` is a no-op for this provider by
 * design, and the LLM-backed providers (codex, security-review, ultrareview)
 * are where the lever actually changes behaviour.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').ReviewInput} ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 */

import { spawnSync } from 'node:child_process';
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
  hashCommandConfig,
  recordPass,
  shouldSkip,
} from '../../validation-evidence.js';

/** Worker entry that scores one file into a full maintainability report. */
const MAINTAINABILITY_REPORT_WORKER_URL = new URL(
  '../../workers/maintainability-report-worker.js',
  import.meta.url,
);

/**
 * Below this JS-file count the worker pool's spawn overhead dominates, so
 * `analyzeChangedFiles` scores in-process (the pre-pool serial path). At or
 * above it, per-file `calculateReportForFile` scoring is offloaded to the
 * shared worker pool so the event loop is not blocked during epic-scoped
 * reviews (f-performance). Single-sourced in `cpu-pool.js` (see the
 * `POOL_SERIAL_THRESHOLD` docstring for the tuning rationale); the
 * `SERIAL_THRESHOLD` export name is preserved as this module's public API.
 */
export const SERIAL_THRESHOLD = POOL_SERIAL_THRESHOLD;

const JS_MAINTAINABILITY_EXTS = new Set(['.js', '.mjs', '.cjs']);

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

/**
 * Read a changed file's content as it exists at `headRef` via
 * `git show <headRef>:<relPath>`, rather than reading the on-disk copy at
 * `PROJECT_ROOT`.
 *
 * This is the fix for Story #3696: the native review previously scored the
 * working-tree copy at `PROJECT_ROOT`, which — when the review runs from the
 * main checkout (the common case for story/epic close) — is the **base**
 * (pre-change) content, not the **head** (PR-branch) content the PR actually
 * produces. Scoring the base copy made MI-*improving* refactors emit a
 * false-positive "Size/Volume Warning" citing the very debt they removed.
 * Sourcing from `headRef` makes the score reflect the PR branch regardless of
 * which tree happens to be checked out on disk.
 *
 * Returns `null` when the file does not exist at `headRef` (deleted by the PR,
 * a brand-new untracked path not yet committed, or a `git show` failure). A
 * `null` source is dropped downstream exactly like a `reportFn` throw — the
 * provider does not warn about a file it cannot read at head.
 *
 * @param {string} relPath  Repo-relative path of the changed file.
 * @param {string} headRef  Git ref under review (e.g. 'story-3696', 'epic/42').
 * @param {typeof gitSpawn} [gitSpawnFn]  Injected git runner (test seam).
 * @returns {string|null}
 */
export function readHeadSource(relPath, headRef, gitSpawnFn = gitSpawn) {
  const res = gitSpawnFn(PROJECT_ROOT, 'show', `${headRef}:${relPath}`);
  if (res.status !== 0) return null;
  return res.stdout ?? '';
}

/**
 * Pure: score a raw source string into a maintainability report, applying the
 * in-memory TS/TSX transpile shim first so a changed `.ts`/`.tsx` file scores
 * the same as the JS the engine would otherwise see. Returns a parse-error
 * report (never throws) when the source cannot be transpiled, matching the
 * disk-based `calculateReportForFile` contract.
 *
 * Exported for testing.
 *
 * @param {string} source   File content at head.
 * @param {string} relPath  Path (used only to pick the transpile mode).
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
 * Finding-shaped entries. `reportFn` is the thunk that produces the file's
 * report (it closes over the file's head-ref source — see
 * {@link analyzeChangedFiles}); a throw is treated as "drop this file".
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
 * Pure: fold one classified file into the running analysis tally. Shared by
 * the serial and pooled scoring paths so both produce byte-for-byte identical
 * `maintainability` rows and `critical`/`medium` findings.
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
 * Walk every changed JS file and accumulate the analysis tally.
 *
 * For small JS-file sets (below {@link SERIAL_THRESHOLD}) scoring runs
 * in-process — the worker pool's spawn overhead dominates at small sizes and
 * the in-process path matches the pre-pool behaviour byte-for-byte. At or
 * above the threshold, each file's `calculateReportForFile` call is offloaded
 * to the shared worker pool (`maintainability-report-worker`) so the native
 * provider no longer blocks the event loop during epic-scoped reviews
 * (f-performance). Either way the pure classification core
 * ({@link classifyChangedFile} + {@link classifyReport}) runs in-process, so
 * the two paths emit identical rows and findings.
 *
 * **Head sourcing (Story #3696).** Each changed JS file is scored against the
 * content it has at `headRef` — sourced via `git show <headRef>:<relPath>` —
 * not the on-disk copy at `PROJECT_ROOT`. When the review runs from the main
 * checkout (the common story/epic close case) the on-disk copy is the *base*
 * (pre-change) content, so scoring it made MI-improving refactors emit a
 * false-positive size/volume warning citing the debt they remove. Sourcing
 * from head makes the score reflect the PR branch regardless of the checked-out
 * tree. A file with no content at head (deleted by the PR, or unreadable) is
 * dropped — the provider never warns about a file it cannot read at head.
 *
 * `classifier` is injected for testability. Tests may also inject `reportFn`
 * to bypass head sourcing entirely (it receives the head source string and the
 * relPath); production callers omit it and get the git-head scorer. Injecting
 * `reportFn` forces the serial path (the injected scorer cannot cross the
 * worker boundary).
 *
 * @param {string[]} changedFiles
 * @param {{ reportFn?: Function, classifier?: Function, runOnPoolFn?: typeof runOnPool, headRef?: string|null, gitSpawnFn?: typeof gitSpawn, readHeadSourceFn?: typeof readHeadSource }} [deps]
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

  // Resolve each file's head-ref source up front. `null` source (deleted at
  // head / unreadable) is dropped — it carries no head report to warn about.
  const sources = jsFiles.map((relPath) =>
    headRef == null ? '' : readHeadSourceFn(relPath, headRef, gitSpawnFn),
  );

  // Default scorer: score the head source string. A test-injected `reportFn`
  // overrides it (receives the head source + relPath) and forces the serial
  // path because the closure cannot be cloned into a worker thread.
  const scoreReport =
    reportFn ?? ((source, relPath) => scoreSourceReport(source, relPath));
  const customReportFn = reportFn != null;

  // Serial path: small batches, or whenever a caller injects its own scorer.
  if (jsFiles.length < SERIAL_THRESHOLD || customReportFn) {
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

  // Pooled path: offload `scoreSourceReport` to the worker pool by sending the
  // pre-sourced head content (not a disk path) so the worker scores the same
  // head string the serial path does. Files with `null` head source are not
  // sent to the pool; their slot is reconstructed by mapping pool results back
  // onto the non-null subset in input order. The pure classification core runs
  // in-process so both paths emit identical rows and findings.
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
    // A host-level pool error or a null report (the worker's parse/I/O
    // sentinel) maps to the serial path's "reportFn threw" → dropped file.
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
      const results = await analyzeChangedFilesFn(changedFiles, {
        headRef,
        gitSpawnFn,
      });

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
