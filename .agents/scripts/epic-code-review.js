#!/usr/bin/env node

/**
 * .agents/scripts/epic-code-review.js — Automated Sprint Code Review
 *
 * Performs an automated "first pass" code review on an Epic branch.
 * This script:
 *   1. Identifies all files modified/added in the Epic branch vs main.
 *   2. Runs lint checks scoped to the changed surface (biome + markdownlint
 *      over only the changed files) and distinguishes errors (🟠 high risk)
 *      from warnings (🟢 suggestion). Workspace-wide lint enforcement lives
 *      at story-close, pre-push, and CI.
 *   3. Calculates per-method maintainability reports for changed JS files
 *      and tiers them so size-driven drops don't poison the Critical tier.
 *   4. Generates a summary report of findings.
 *   5. Posts the report to the Epic issue.
 *
 * Usage:
 *   node .agents/scripts/epic-code-review.js --epic <EPIC_ID>
 *                                              [--scope-lint changed-only|off]
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import {
  calculateReportForFile,
  classifyReport,
} from './lib/maintainability-engine.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import {
  hashCommandConfig,
  recordPass,
  shouldSkip,
} from './lib/validation-evidence.js';

/**
 * Parse stdout/stderr from a lint runner to estimate error vs warning counts.
 *
 * Handles the two runners composing `npm run lint` in this project:
 *   - Biome: emits "Found N error(s)." and "Found N warning(s)." lines.
 *   - markdownlint: emits one diagnostic per issue, plus a trailing
 *     "Summary: N error(s)" line.
 *
 * Severity classification (per the close-workflow recommendation): when the
 * runner exits non-zero but its output matches neither known reporter
 * format, the result is "could not classify" — this is the
 * binary-missing / parse-failure / environment bucket. We mark
 * `executionFailed: true` so callers can degrade the gate to a 🟢 suggestion
 * + skip rather than mislabelling an environment problem as 🟠 high risk
 * (which forced the operator to manually re-run `npm run lint` to
 * disambiguate).
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

  // Biome summary lines — use a global regex so we pick up every reporter
  // section (markdown, JS, etc.) when the composite command runs multiple.
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

  // markdownlint "Summary: N error(s)" style.
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
 * Biome handles JS/TS/JSON; markdownlint handles `.md`. Anything else (CSS,
 * images, YAML, etc.) is skipped — the review is a "focused first pass," not
 * a workspace-wide gate.
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

/**
 * Resolve `git rev-parse HEAD` inside `cwd`. Returns null on failure so the
 * evidence-skip path silently no-ops instead of throwing — review correctness
 * never depends on the skip firing.
 */
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
 * Injectable runner makes this unit-testable without spawning processes.
 *
 * @param {string[]} changedFiles
 * @param {string} cwd
 * @param {(bin: string, args: string[], cwd: string) => { status: number, stdout: string, stderr: string }} [runnerFn]
 * @returns {{ errors: number, warnings: number, parsed: boolean, skipped: boolean, mode: 'changed-only' }}
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
 * Parse the CLI argv into a normalized review-config object. Pure; exported
 * for testing.
 *
 * `scopeLint` defaults to `changed-only` — workspace-wide lint enforcement
 * stays at story-close, pre-push, and CI, so the review pass only needs to
 * surface findings on the actual diff. `off` skips the lint section entirely
 * for runs where the operator already knows lint is clean.
 *
 * `--story <id>` opts the lint step into validation-evidence skip: when the
 * Story has already recorded a `lint` pass against the current HEAD with the
 * same scoped command-config, the lint runner is skipped. `--no-evidence`
 * forces the runner regardless.
 *
 * @param {string[]} argv
 * @returns {{ epicId: number|null, baseBranch: string|null, post: boolean, scopeLint: 'changed-only'|'off', storyId: number|null, useEvidence: boolean }}
 */
export function parseReviewArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      base: { type: 'string' },
      post: { type: 'boolean', default: true },
      'scope-lint': { type: 'string', default: 'changed-only' },
      story: { type: 'string' },
      'no-evidence': { type: 'boolean', default: false },
    },
    strict: false,
  });
  const parsed = Number.parseInt(values.epic ?? '', 10);
  const parsedStory = Number.parseInt(values.story ?? '', 10);
  const rawScope = values['scope-lint'] ?? 'changed-only';
  const scopeLint = rawScope === 'off' ? 'off' : 'changed-only';
  return {
    epicId: Number.isNaN(parsed) || parsed <= 0 ? null : parsed,
    baseBranch: values.base ?? null,
    post: values.post !== false,
    scopeLint,
    storyId: Number.isNaN(parsedStory) || parsedStory <= 0 ? null : parsedStory,
    useEvidence: values['no-evidence'] !== true,
  };
}

/**
 * Compute the canonical command-config hash for the scoped-lint runner. The
 * caller passes the partitioned biome + markdown lists so the hash captures
 * the exact set of files; any change to that set (a different diff, a new
 * file added) invalidates the prior evidence and forces a re-lint.
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
 * issue strings. `reportFn` is the file-classifier (defaults to the engine's
 * `calculateReportForFile`); injected so tests can stub deletion / parse
 * errors without touching disk.
 *
 * @returns {{ row: object|null, criticalIssue: string|null, warningIssue: string|null }}
 */
export function classifyChangedFile(relPath, { reportFn, classifier } = {}) {
  const absPath = path.resolve(PROJECT_ROOT, relPath);
  let report;
  try {
    report = reportFn(absPath);
  } catch (_err) {
    return { row: null, criticalIssue: null, warningIssue: null };
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
      criticalIssue: `🔴 Low Maintainability: \`${relPath}\` (${reason})`,
      warningIssue: null,
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
      criticalIssue: null,
      warningIssue: `🟡 Size/Volume Warning: \`${relPath}\` (module ${moduleScore}${worst})`,
    };
  }
  return { row, criticalIssue: null, warningIssue: null };
}

/**
 * Pure: walk every changed JS file and accumulate the review tally.
 * `reportFn` and `classifier` are injected for testability.
 */
export function analyzeChangedFiles(
  changedFiles,
  { reportFn = calculateReportForFile, classifier = classifyReport } = {},
) {
  const results = {
    totalFiles: changedFiles.length,
    jsFiles: 0,
    maintainability: [],
    criticalIssues: [],
    warningIssues: [],
  };
  for (const relPath of changedFiles) {
    const ext = path.extname(relPath);
    if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') continue;
    results.jsFiles += 1;
    const { row, criticalIssue, warningIssue } = classifyChangedFile(relPath, {
      reportFn,
      classifier,
    });
    if (!row) continue;
    results.maintainability.push(row);
    if (criticalIssue) results.criticalIssues.push(criticalIssue);
    if (warningIssue) results.warningIssues.push(warningIssue);
  }
  return results;
}

/**
 * Pure: severity counts derived from the analysis tally + lint summary.
 *
 * `executionFailed` (lint runner crashed, binary missing, or output could
 * not be parsed) is treated as 🟢 Suggestion + skipped gate, NOT high risk.
 * The previous behavior conflated "runner couldn't execute" with "runner
 * found errors", forcing operators to manually re-run `npm run lint` to
 * disambiguate.
 */
export function buildSeverity(results, lintSummary) {
  if (lintSummary.executionFailed) {
    return {
      critical: results.criticalIssues.length,
      high: 0,
      medium: results.warningIssues.length,
      suggestion: 1,
    };
  }
  return {
    critical: results.criticalIssues.length,
    high: lintSummary.errors > 0 ? 1 : 0,
    medium: results.warningIssues.length,
    suggestion: lintSummary.warnings > 0 ? 1 : 0,
  };
}

/** Pure: render the lint-status one-liner for the report. */
export function buildLintLine(lintSummary) {
  if (lintSummary.mode === 'off') {
    return 'ℹ️ **Lint Skipped**: `--scope-lint=off`. Workspace lint still gates at story-close, pre-push, and CI.';
  }
  if (lintSummary.executionFailed) {
    return '🟢 **Lint Runner Could Not Execute**: scoped lint produced no parseable output (binary missing, parse failure, or environment issue). Treating as suggestion + skipped gate — verify with the canonical `npm run lint` before merging.';
  }
  if (lintSummary.skipped) {
    return 'ℹ️ **Lint Skipped**: no JS or markdown files in changed surface.';
  }
  if (lintSummary.errors > 0) {
    return `❌ **Lint Check Failed**: ${lintSummary.errors} error(s), ${lintSummary.warnings} warning(s) on changed files. Fix errors before merging.`;
  }
  if (lintSummary.warnings > 0) {
    return `🟢 **Lint Check Passed with Warnings**: ${lintSummary.warnings} warning(s) on changed files — treat as suggestions.`;
  }
  return '✅ **Lint Check Passed**: changed surface is clean.';
}

function tierLabel(tier) {
  if (tier === 'healthy') return '🟢 Healthy';
  if (tier === 'warning') return '🟡 Warning';
  if (tier === 'critical') return '🔴 Critical';
  return '⚠️ Parse Error';
}

/** Pure: assemble the markdown review body. */
export function buildReviewReport({
  epicId,
  baseBranch,
  epicBranch,
  results,
  severity,
  lintLine,
}) {
  return [
    `## 🔬 Automated Code Review Results for Epic #${epicId}`,
    '',
    `**Comparison**: \`${baseBranch}\` ... \`${epicBranch}\``,
    `**Surface Area**: ${results.totalFiles} files changed (${results.jsFiles} JS files)`,
    '',
    '### 📦 Severity Tier Counts',
    '',
    `- 🔴 Critical Blocker: ${severity.critical}`,
    `- 🟠 High Risk: ${severity.high}`,
    `- 🟡 Medium Risk: ${severity.medium}`,
    `- 🟢 Suggestion: ${severity.suggestion}`,
    '',
    '### 📊 Maintainability Overview',
    '| File | Module | Worst Method | Tier |',
    '| :--- | :--- | :--- | :--- |',
    ...results.maintainability.map((m) => {
      const worst =
        m.report.worstMethod !== null ? m.report.worstMethod.toFixed(1) : 'n/a';
      return `| \`${m.file}\` | ${m.report.moduleScore.toFixed(2)} | ${worst} | ${tierLabel(m.tier)} |`;
    }),
    '',
    '### 🚨 Critical Findings',
    results.criticalIssues.length > 0
      ? results.criticalIssues.join('\n')
      : '✅ No maintainability blockers identified.',
    '',
    '### 🟡 Warnings',
    results.warningIssues.length > 0
      ? results.warningIssues.join('\n')
      : '✅ No size/volume warnings.',
    '',
    lintLine,
    '',
    '---',
    '_This is an automated pre-review. A human or specialist agent should still verify business logic and security constraints._',
  ].join('\n');
}

function lintOffSummary() {
  return {
    errors: 0,
    warnings: 0,
    parsed: false,
    skipped: true,
    mode: 'off',
  };
}

function evidenceSkippedSummary() {
  return {
    errors: 0,
    warnings: 0,
    parsed: false,
    skipped: true,
    mode: 'changed-only',
    evidenceSkipped: true,
  };
}

function tryEvidenceSkip({
  args,
  headSha,
  evidenceCfg,
  shouldSkipFn,
  progress,
}) {
  if (!(args.useEvidence && args.storyId && args.epicId && headSha))
    return null;
  const verdict = shouldSkipFn(
    {
      storyId: args.storyId,
      gateName: 'epic-code-review/lint',
      currentSha: headSha,
      configHash: evidenceCfg,
    },
    { cwd: PROJECT_ROOT, epicId: args.epicId },
  );
  if (!verdict.skip) return null;
  progress(
    'LINT',
    `⏭ Scoped lint skipped (evidence match: SHA=${headSha.slice(0, 7)}, recorded ${verdict.record?.timestamp ?? 'n/a'}).`,
  );
  return evidenceSkippedSummary();
}

function maybeRecordLintEvidence({
  args,
  headSha,
  evidenceCfg,
  lintSummary,
  recordPassFn,
  progress,
}) {
  const eligible =
    args.useEvidence &&
    args.storyId &&
    args.epicId &&
    headSha &&
    lintSummary.errors === 0 &&
    !lintSummary.skipped;
  if (!eligible) return;
  try {
    recordPassFn(
      {
        storyId: args.storyId,
        gateName: 'epic-code-review/lint',
        sha: headSha,
        configHash: evidenceCfg,
        exitCode: 0,
      },
      { cwd: PROJECT_ROOT, epicId: args.epicId },
    );
  } catch (err) {
    progress(
      'LINT',
      `⚠ Failed to record lint evidence: ${err?.message ?? err}`,
    );
  }
}

async function runLintPhase({
  scopeLint,
  changedFiles,
  args,
  gitSpawnFn,
  shouldSkipFn,
  recordPassFn,
  runScopedLintFn,
  progress,
}) {
  if (scopeLint === 'off') {
    progress('LINT', 'Lint scoped off (--scope-lint=off); skipping.');
    return lintOffSummary();
  }
  const evidenceCfg = buildLintEvidenceConfig(changedFiles, PROJECT_ROOT);
  const headSha = resolveCurrentSha(PROJECT_ROOT, gitSpawnFn);
  const skipSummary = tryEvidenceSkip({
    args,
    headSha,
    evidenceCfg,
    shouldSkipFn,
    progress,
  });
  if (skipSummary) return skipSummary;

  progress(
    'LINT',
    'Linting changed files only (biome + markdownlint, scoped to diff)...',
  );
  const lintSummary = runScopedLintFn(changedFiles, PROJECT_ROOT);
  maybeRecordLintEvidence({
    args,
    headSha,
    evidenceCfg,
    lintSummary,
    recordPassFn,
    progress,
  });
  return lintSummary;
}

/**
 * Runner-shaped entry-point: takes the parsed review-args plus optional
 * dependency-injection hooks, runs the review, and returns the structured
 * outcome. Pure-ish (modulo IO) — all side-effects are routed via the
 * injection hooks so tests can drive the runner end-to-end without touching
 * git, disk, the lint runners, the validation-evidence file, or the
 * ticketing provider.
 *
 * Exported for tests + the CLI `main()`.
 *
 * @param {object} args — output of `parseReviewArgs`
 * @param {object} [deps] — Optional injection hooks (tests)
 * @param {Function} [deps.gitSpawnFn]      — Stub for `gitSpawn`
 * @param {Function} [deps.shouldSkipFn]    — Stub for `shouldSkip`
 * @param {Function} [deps.recordPassFn]    — Stub for `recordPass`
 * @param {Function} [deps.runScopedLintFn] — Stub for `runScopedLint`
 * @param {Function} [deps.analyzeChangedFilesFn] — Stub for `analyzeChangedFiles`
 * @param {Function} [deps.providerFactory] — Stub for `createProvider`
 * @param {Function} [deps.upsertCommentFn] — Stub for `upsertStructuredComment`
 * @param {Function} [deps.resolveConfigFn] — Stub for `resolveConfig`
 * @param {object}   [deps.logger]          — Logger-shaped object (info/warn/error/fatal)
 * @param {Function} [deps.print]           — Stub for `Logger.info` (the rendered report)
 * @returns {Promise<{ status: 'ok'|'no-changes'|'invalid', report?: string, posted?: boolean, severity?: object }>}
 */
export async function runEpicCodeReview(args, deps = {}) {
  const {
    gitSpawnFn = gitSpawn,
    shouldSkipFn = shouldSkip,
    recordPassFn = recordPass,
    runScopedLintFn = runScopedLint,
    analyzeChangedFilesFn = analyzeChangedFiles,
    providerFactory = createProvider,
    upsertCommentFn = upsertStructuredComment,
    resolveConfigFn = resolveConfig,
    logger = Logger,
    print = (s) => Logger.info(s),
  } = deps;

  const progress =
    deps.progress ??
    logger.createProgress?.('epic-code-review', { stderr: false }) ??
    ((label, msg) => logger.info?.(`[${label}] ${msg}`));

  if (!args || args.epicId === null || args.epicId === undefined) {
    logger.fatal('Usage: node epic-code-review.js --epic <EPIC_ID>');
    return { status: 'invalid' };
  }

  const { agentSettings, orchestration } = resolveConfigFn();
  const baseBranch = args.baseBranch ?? agentSettings.baseBranch ?? 'main';
  const epicBranch = `epic/${args.epicId}`;
  const scopeLint = args.scopeLint;

  progress('INIT', `Starting automated review for Epic #${args.epicId}...`);
  progress('GIT', `Comparing ${epicBranch} against ${baseBranch}...`);

  const diffResult = gitSpawnFn(
    PROJECT_ROOT,
    'diff',
    `${baseBranch}...${epicBranch}`,
    '--name-only',
  );
  if (diffResult.status !== 0) {
    logger.fatal(`Failed to get diff: ${diffResult.stderr}`);
    return { status: 'invalid' };
  }

  const changedFiles = diffResult.stdout
    .trim()
    .split('\n')
    .filter((f) => f.length > 0);

  if (changedFiles.length === 0) {
    progress('DONE', 'No changes detected. Skipping review.');
    return { status: 'no-changes' };
  }

  progress('REVIEW', `Analyzing ${changedFiles.length} changed files...`);
  const results = analyzeChangedFilesFn(changedFiles);

  const lintSummary = await runLintPhase({
    scopeLint,
    changedFiles,
    args,
    gitSpawnFn,
    shouldSkipFn,
    recordPassFn,
    runScopedLintFn,
    progress,
  });

  progress('REPORT', 'Generating findings report...');
  const severity = buildSeverity(results, lintSummary);
  const report = buildReviewReport({
    epicId: args.epicId,
    baseBranch,
    epicBranch,
    results,
    severity,
    lintLine: buildLintLine(lintSummary),
  });
  print(report);

  let posted = false;
  if (args.post) {
    progress('POST', `Posting review report to Epic #${args.epicId}...`);
    const provider = providerFactory(orchestration);
    await upsertCommentFn(provider, args.epicId, 'code-review', report);
    progress('DONE', 'Report posted successfully.');
    posted = true;
  }

  return { status: 'ok', report, posted, severity };
}

async function main() {
  const args = parseReviewArgs(process.argv.slice(2));
  await runEpicCodeReview(args);
}

runAsCli(import.meta.url, main, { source: 'epic-code-review' });
