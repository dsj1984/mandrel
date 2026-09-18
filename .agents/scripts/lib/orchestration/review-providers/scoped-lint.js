/**
 * review-providers/scoped-lint.js — scoped biome + markdownlint over the
 * changed surface. Runners resolve on disk before spawning (`npx --no biome`
 * exits 0 silently when biome is absent), and each surface is classified
 * independently so one failure cannot become the other's verdict.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CODE_EXTENSIONS = /\.(js|mjs|cjs|jsx|ts|tsx|json|jsonc)$/i;

/**
 * npx's unresolvable-bin output: the legacy message or current npm's E404.
 * Matching the E404 code, not any `npm error` line, keeps genuine runner
 * errors out.
 */
const NPX_UNRESOLVABLE =
  /could not determine executable to run|npm (?:error|ERR!)\s+code\s+E404/i;

/** Biome's exit-1 when every path is config-excluded: an empty scope, not a failure. */
const BIOME_EMPTY_SCOPE = /No files were processed in the specified paths/i;

/**
 * Markdown runners in preference order, each with its own argument shape:
 * cli2 rejects `--ignore`, which cli v1 takes.
 */
const MARKDOWN_RUNNERS = Object.freeze([
  Object.freeze({ bin: 'markdownlint-cli2', extraArgs: Object.freeze([]) }),
  Object.freeze({
    bin: 'markdownlint',
    extraArgs: Object.freeze(['--ignore', 'node_modules']),
  }),
]);

const CODE_RUNNERS = Object.freeze([
  Object.freeze({ bin: 'biome', extraArgs: Object.freeze([]) }),
]);

const DEGRADATION_REASONS = Object.freeze({
  RUNNER_NOT_INSTALLED: 'runner-not-installed',
  RUNNER_NOT_RESOLVABLE: 'runner-not-resolvable',
  UNPARSEABLE_OUTPUT: 'unparseable-output',
});

/**
 * Spawn one lint runner through `npx --no` (never install on the fly).
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
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
 * First candidate installed under `<cwd>/node_modules/.bin`, else `null`.
 * Deliberately local-only: a global runner reads as absent and degrades
 * honestly rather than trusting an unresolved spawn.
 *
 * @param {ReadonlyArray<{ bin: string, extraArgs: ReadonlyArray<string> }>} candidates
 * @param {string} cwd
 * @param {(p: string) => boolean} existsFn  Injected for testing.
 * @returns {{ bin: string, extraArgs: ReadonlyArray<string> }|null}
 */
function resolveRunner(candidates, cwd, existsFn) {
  for (const candidate of candidates) {
    const base = path.join(cwd, 'node_modules', '.bin', candidate.bin);
    if (existsFn(base)) return candidate;
    if (
      process.platform === 'win32' &&
      (existsFn(`${base}.cmd`) || existsFn(`${base}.ps1`))
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Zero counts with `executionFailed: true`, so it can never read as clean.
 *
 * @returns {ReturnType<typeof parseLintOutput>}
 */
function unresolvedRunnerSummary() {
  return {
    errors: 0,
    warnings: 0,
    parsed: false,
    executionFailed: true,
    emptyScope: false,
    reason: DEGRADATION_REASONS.RUNNER_NOT_INSTALLED,
  };
}

/**
 * Resolve one surface's runner and, only if it resolved, spawn and classify it.
 *
 * @param {{
 *   label: string,
 *   candidates: ReadonlyArray<{ bin: string, extraArgs: ReadonlyArray<string> }>,
 *   buildArgs: (runner: { bin: string, extraArgs: ReadonlyArray<string> }) => string[],
 *   cwd: string,
 *   runnerFn: typeof spawnLintRunner,
 *   existsFn: (p: string) => boolean,
 * }} args
 * @returns {{ surface: string, summary: ReturnType<typeof parseLintOutput> }}
 */
function runSurface({ label, candidates, buildArgs, cwd, runnerFn, existsFn }) {
  const runner = resolveRunner(candidates, cwd, existsFn);
  if (runner === null) {
    return { surface: label, summary: unresolvedRunnerSummary() };
  }
  return {
    surface: runner.bin,
    summary: parseLintOutput(runnerFn(runner.bin, buildArgs(runner), cwd)),
  };
}

/**
 * @param {string[]} changedFiles
 * @returns {{ code: string[], md: string[] }}
 */
export function partitionFilesForLint(changedFiles) {
  const code = [];
  const md = [];
  for (const f of changedFiles) {
    if (CODE_EXTENSIONS.test(f)) code.push(f);
    else if (/\.md$/i.test(f)) md.push(f);
  }
  return { code, md };
}

/**
 * A non-zero exit matching no reporter format is `executionFailed`, except
 * biome's empty-scope exit.
 *
 * @param {{ status?: number, stdout?: string, stderr?: string }} result
 * @returns {{ errors: number, warnings: number, parsed: boolean, executionFailed: boolean, emptyScope: boolean, reason: string|null }}
 */
export function parseLintOutput(result) {
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  let errors = 0;
  let warnings = 0;
  let parsed = false;

  for (const m of combined.matchAll(/Found\s+(\d+)\s+error/gi)) {
    errors += Number(m[1]);
    parsed = true;
  }
  for (const m of combined.matchAll(/Found\s+(\d+)\s+warning/gi)) {
    warnings += Number(m[1]);
    parsed = true;
  }
  const mdSummary = combined.match(/Summary:\s+(\d+)\s+error/i);
  if (mdSummary) {
    errors += Number(mdSummary[1]);
    parsed = true;
  }

  const failedExit = !parsed && (result.status ?? 0) !== 0;
  const emptyScope = failedExit && BIOME_EMPTY_SCOPE.test(combined);
  const executionFailed = failedExit && !emptyScope;
  const reason = executionFailed
    ? NPX_UNRESOLVABLE.test(combined)
      ? DEGRADATION_REASONS.RUNNER_NOT_RESOLVABLE
      : DEGRADATION_REASONS.UNPARSEABLE_OUTPUT
    : null;

  return { errors, warnings, parsed, executionFailed, emptyScope, reason };
}

/**
 * Counts add and `executionFailed` is the OR; `surfaces[]` keeps what the
 * lossy OR cannot answer.
 *
 * @param {Array<{ surface: string, summary: ReturnType<typeof parseLintOutput> }>} surfaces
 */
function mergeSurfaceSummaries(surfaces) {
  const rows = surfaces.map(({ surface, summary }) => ({
    surface,
    parsed: summary.parsed,
    errors: summary.errors,
    warnings: summary.warnings,
    executionFailed: summary.executionFailed,
    reason: summary.reason ?? DEGRADATION_REASONS.UNPARSEABLE_OUTPUT,
  }));
  const total = (field) => rows.reduce((sum, row) => sum + row[field], 0);

  return {
    errors: total('errors'),
    warnings: total('warnings'),
    parsed: rows.some((row) => row.parsed),
    executionFailed: rows.some((row) => row.executionFailed),
    skipped: false,
    mode: 'changed-only',
    degradations: rows
      .filter((row) => row.executionFailed)
      .map(({ surface, reason }) => ({ surface, reason })),
    surfaces: rows.map(({ reason, ...row }) => row),
  };
}

/**
 * @param {string[]} changedFiles
 * @param {string} cwd
 * @param {typeof spawnLintRunner} [runnerFn]
 * @param {{ existsFn?: (p: string) => boolean }} [deps]
 * @returns {{ errors: number, warnings: number, parsed: boolean, skipped: boolean, mode: 'changed-only'|'off', executionFailed: boolean, degradations: Array<{ surface: string, reason: string }>, surfaces: Array<{ surface: string, parsed: boolean, errors: number, warnings: number, executionFailed: boolean }> }}
 */
export function runScopedLint(
  changedFiles,
  cwd,
  runnerFn = spawnLintRunner,
  deps = {},
) {
  const { existsFn = existsSync } = deps;
  const { code, md } = partitionFilesForLint(changedFiles);
  if (code.length === 0 && md.length === 0) {
    return {
      errors: 0,
      warnings: 0,
      parsed: false,
      skipped: true,
      mode: 'changed-only',
      executionFailed: false,
      degradations: [],
      surfaces: [],
    };
  }

  const surfaces = [];
  if (code.length > 0) {
    surfaces.push(
      runSurface({
        label: 'biome',
        candidates: CODE_RUNNERS,
        buildArgs: (runner) => ['lint', ...code, ...runner.extraArgs],
        cwd,
        runnerFn,
        existsFn,
      }),
    );
  }
  if (md.length > 0) {
    surfaces.push(
      runSurface({
        label: 'markdownlint',
        candidates: MARKDOWN_RUNNERS,
        buildArgs: (runner) => [...md, ...runner.extraArgs],
        cwd,
        runnerFn,
        existsFn,
      }),
    );
  }

  return mergeSurfaceSummaries(surfaces);
}
