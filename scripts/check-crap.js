import fs from 'node:fs';
import path from 'node:path';
import { getChangedFiles } from './lib/changed-files.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { loadCoverage } from './lib/coverage-utils.js';
import { deriveFixGuidance } from './lib/crap-engine.js';
import {
  getCrapBaseline,
  KERNEL_VERSION,
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  scanAndScore,
} from './lib/crap-utils.js';
import { createFrictionEmitter } from './lib/orchestration/friction-emitter.js';
import { createProvider } from './lib/provider-factory.js';

/**
 * CLI: verify CRAP scores against the committed baseline.
 *
 * Hybrid enforcement — tracked methods must not regress beyond `tolerance`;
 * new (untracked) methods must stay at or below `newMethodCeiling`. Removed
 * baseline rows are surfaced (not suppressed, not a failure) so a deletion is
 * visible at review time.
 *
 * Contract:
 *   - `settings.quality.crap.enabled === false` → skip, exit 0.
 *   - Missing baseline → fail closed, exit 1 with a bootstrap-instruction
 *     message. (The transitional informational mode from #596 was retired in
 *     Story #791; the gate is now hard-enforcing across all three firing
 *     sites — close-validation, pre-push, CI.)
 *   - Baseline `kernelVersion` or `escomplexVersion` mismatch vs. the running
 *     scorer → fail closed, exit 1 with a message pointing at
 *     `npm run crap:update`.
 *   - Otherwise: exit 1 if any regression or new-method ceiling violation,
 *     else exit 0.
 *
 * `--story <id>` (or the `FRICTION_STORY_ID` env) mirrors
 * `check-maintainability.js` — on failure we upsert a rate-limited friction
 * structured comment on the named Story naming every violating method.
 *
 * Environment overrides (take precedence over `.agentrc.json`):
 *   - `CRAP_NEW_METHOD_CEILING` — integer; overrides `crap.newMethodCeiling`.
 *   - `CRAP_TOLERANCE`          — float;   overrides `crap.tolerance`.
 *   - `CRAP_REFRESH_TAG`        — string;  overrides `crap.refreshTag` (surfaced
 *                                          in the failure hint).
 * These are intended for the base-branch-enforced `baseline-refresh-guardrail`
 * CI job (see Story #610) so CI can force base-branch values regardless of
 * what the PR branch config says. Malformed values log a warning and fall
 * back to the config value — a typo in CI must never silently relax the gate.
 */

/**
 * Pure helper: resolve the effective CRAP config by layering env-var overrides
 * on top of the resolved `.agentrc.json` values. Exported so tests can assert
 * the precedence + malformed-value behavior without spawning the CLI.
 *
 * @param {{ newMethodCeiling?: unknown, tolerance?: unknown, refreshTag?: unknown }} crapConfig
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ newMethodCeiling: number, tolerance: number, refreshTag: string, overrides: string[] }}
 */
export function resolveCrapEnvOverrides(crapConfig, env) {
  const overrides = [];
  let newMethodCeiling = Number.isFinite(crapConfig?.newMethodCeiling)
    ? crapConfig.newMethodCeiling
    : 30;
  // Default 0.05 (raised from 0.001 in 5.36.1). CRAP scores are
  // `c² · (1 − cov)³ + c`, so a sub-percent per-method coverage rounding
  // shift across CI environments — same code, different escomplex /
  // coverage build — moves the score by ~0.01 on its own. A 0.001
  // tolerance flagged that as a regression; real regressions cross
  // whole-integer thresholds (e.g. 8 → 12) and clear 0.05 trivially.
  let tolerance = Number.isFinite(crapConfig?.tolerance)
    ? crapConfig.tolerance
    : 0.05;
  let refreshTag =
    typeof crapConfig?.refreshTag === 'string' && crapConfig.refreshTag.length
      ? crapConfig.refreshTag
      : 'baseline-refresh:';

  const rawCeiling = env?.CRAP_NEW_METHOD_CEILING;
  if (rawCeiling !== undefined && rawCeiling !== '') {
    const parsed = Number(rawCeiling);
    if (Number.isFinite(parsed) && parsed >= 0) {
      newMethodCeiling = parsed;
      overrides.push(`newMethodCeiling=${parsed} (CRAP_NEW_METHOD_CEILING)`);
    } else {
      console.warn(
        `[CRAP] ⚠ ignoring malformed CRAP_NEW_METHOD_CEILING=${rawCeiling}; keeping config value ${newMethodCeiling}`,
      );
    }
  }

  const rawTolerance = env?.CRAP_TOLERANCE;
  if (rawTolerance !== undefined && rawTolerance !== '') {
    const parsed = Number(rawTolerance);
    if (Number.isFinite(parsed) && parsed >= 0) {
      tolerance = parsed;
      overrides.push(`tolerance=${parsed} (CRAP_TOLERANCE)`);
    } else {
      console.warn(
        `[CRAP] ⚠ ignoring malformed CRAP_TOLERANCE=${rawTolerance}; keeping config value ${tolerance}`,
      );
    }
  }

  const rawRefreshTag = env?.CRAP_REFRESH_TAG;
  if (typeof rawRefreshTag === 'string' && rawRefreshTag.length > 0) {
    refreshTag = rawRefreshTag;
    overrides.push(`refreshTag=${rawRefreshTag} (CRAP_REFRESH_TAG)`);
  }

  return { newMethodCeiling, tolerance, refreshTag, overrides };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const out = {
    storyId: null,
    baselinePath: undefined,
    coveragePath: undefined,
    changedSinceRef: null,
    jsonPath: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--story' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0) out.storyId = parsed;
      i += 1;
    } else if (argv[i] === '--baseline' && argv[i + 1]) {
      out.baselinePath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--coverage' && argv[i + 1]) {
      out.coveragePath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--changed-since') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.changedSinceRef = next;
        i += 1;
      } else {
        out.changedSinceRef = 'main';
      }
    } else if (argv[i] === '--json' && argv[i + 1]) {
      out.jsonPath = argv[i + 1];
      i += 1;
    }
  }
  if (out.storyId === null) {
    const envVal = Number(process.env.FRICTION_STORY_ID);
    if (Number.isInteger(envVal) && envVal > 0) out.storyId = envVal;
  }
  return out;
}

/**
 * Pure helper — narrow a list of rows to the ones whose `file` field is in
 * `scopeSet`. Shared between scan-row filtering and baseline-row filtering so
 * the `--changed-since` code path treats both sides of the comparison the
 * same way (otherwise every baseline row for an untouched file would surface
 * as "removed" on every diff-scoped run).
 *
 * @template {{file: string}} R
 * @param {R[]} rows
 * @param {Set<string>} scopeSet
 * @returns {R[]}
 */
export function filterRowsByFileScope(rows, scopeSet) {
  if (!scopeSet) return rows ?? [];
  return (rows ?? []).filter((r) => scopeSet.has(r.file));
}

/**
 * Pure comparator. Given scanned `currentRows` and committed `baselineRows`,
 * produce a structured verdict covering all four match paths:
 *
 *   1. **exact**     — same (file, method, startLine). Regresses if current
 *                      crap > baseline crap + tolerance.
 *   2. **drifted**   — same (file, method) but startLine shifted. Uses the
 *                      closest line-drifted baseline row; regresses under the
 *                      same no-regression rule. A drift without regression is
 *                      reported informationally in `drifted`.
 *   3. **new**       — no baseline match. Violates if crap > newMethodCeiling.
 *   4. **removed**   — baseline rows not seen in the current scan. Surfaced
 *                      only; never a failure.
 *
 * @param {{
 *   currentRows: Array<{file: string, method: string, startLine: number, cyclomatic: number, coverage: number, crap: number}>,
 *   baselineRows: Array<{file: string, method: string, startLine: number, crap: number}>,
 *   newMethodCeiling: number,
 *   tolerance: number,
 * }} params
 * @returns {{
 *   total: number,
 *   regressions: number,
 *   newViolations: number,
 *   drifted: number,
 *   removed: number,
 *   violations: Array<object>,
 *   removedRows: Array<object>,
 * }}
 */
export function compareCrap({
  currentRows,
  baselineRows,
  newMethodCeiling,
  tolerance,
}) {
  const exactIndex = new Map();
  const methodIndex = new Map();
  for (const b of baselineRows ?? []) {
    exactIndex.set(`${b.file}::${b.method}@${b.startLine}`, b);
    const mk = `${b.file}::${b.method}`;
    if (!methodIndex.has(mk)) methodIndex.set(mk, []);
    methodIndex.get(mk).push(b);
  }
  const seenBaselineKeys = new Set();

  const violations = [];
  let regressions = 0;
  let newViolations = 0;
  let drifted = 0;

  for (const row of currentRows ?? []) {
    const exactKey = `${row.file}::${row.method}@${row.startLine}`;
    const methodKey = `${row.file}::${row.method}`;
    const exact = exactIndex.get(exactKey);
    if (exact) {
      seenBaselineKeys.add(exactKey);
      if (row.crap > exact.crap + tolerance) {
        regressions += 1;
        violations.push({
          ...row,
          kind: 'regression',
          baseline: exact.crap,
          baselineStartLine: exact.startLine,
        });
      }
      continue;
    }

    const candidates = methodIndex.get(methodKey);
    if (Array.isArray(candidates) && candidates.length > 0) {
      // Pick the closest un-seen candidate by startLine distance; fall back to
      // the first one if all have been seen (duplicate method names).
      let pick = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        const k = `${c.file}::${c.method}@${c.startLine}`;
        if (seenBaselineKeys.has(k)) continue;
        const d = Math.abs(c.startLine - row.startLine);
        if (d < bestDist) {
          bestDist = d;
          pick = c;
        }
      }
      if (!pick) pick = candidates[0];
      seenBaselineKeys.add(`${pick.file}::${pick.method}@${pick.startLine}`);
      drifted += 1;
      if (row.crap > pick.crap + tolerance) {
        regressions += 1;
        violations.push({
          ...row,
          kind: 'drifted-regression',
          baseline: pick.crap,
          baselineStartLine: pick.startLine,
        });
      }
      continue;
    }

    if (row.crap > newMethodCeiling + tolerance) {
      newViolations += 1;
      violations.push({
        ...row,
        kind: 'new',
        baseline: null,
        ceiling: newMethodCeiling,
      });
    }
  }

  const removedRows = [];
  for (const b of baselineRows ?? []) {
    const k = `${b.file}::${b.method}@${b.startLine}`;
    if (!seenBaselineKeys.has(k)) removedRows.push(b);
  }

  return {
    total: currentRows?.length ?? 0,
    regressions,
    newViolations,
    drifted,
    removed: removedRows.length,
    violations,
    removedRows,
  };
}

/**
 * Pure decision helper for the missing-baseline / kernel-mismatch /
 * escomplex-mismatch / tsTranspiler-mismatch gate paths. Lets tests assert
 * the exact operator-facing message without spawning a child process.
 *
 * Story #791 retired the transitional `bootstrap` exit-0 path: a missing
 * baseline still fails closed (exit 1) so close-validation, pre-push, and
 * CI all enforce uniformly. Operators bootstrap explicitly via
 * `npm run crap:update` + a `baseline-refresh:` commit.
 *
 * Story #829 (5.29.0) softened `kernelVersion` and `tsTranspilerVersion`
 * drift to **warn**, not fail: when consumers pin-and-bump the framework
 * the kernel may move ahead of their committed baseline, and they need
 * runway to refresh deliberately rather than discovering the bump from
 * a hard CI red. `escomplexVersion` mismatch continues to fail closed —
 * a different kernel can change scoring semantics without warning.
 *
 * @param {{
 *   baseline: {kernelVersion: string, escomplexVersion: string, tsTranspilerVersion?: string, rows: Array}|null,
 *   runningKernelVersion: string,
 *   runningEscomplexVersion: string,
 *   runningTsTranspilerVersion?: string,
 * }} params
 * @returns {{ ok: true, warnings: string[] }
 *   | { ok: false, exitCode: 1, kind: 'missing-baseline'|'escomplex-mismatch', message: string }}
 */
export function evaluateBaselineCompatibility({
  baseline,
  runningKernelVersion,
  runningEscomplexVersion,
  runningTsTranspilerVersion,
}) {
  if (baseline === null || baseline === undefined) {
    return {
      ok: false,
      exitCode: 1,
      kind: 'missing-baseline',
      message:
        "[CRAP] ❌ no baseline found — run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to bootstrap",
    };
  }
  if (baseline.escomplexVersion !== runningEscomplexVersion) {
    return {
      ok: false,
      exitCode: 1,
      kind: 'escomplex-mismatch',
      message: `[CRAP] scorer changed from ${baseline.escomplexVersion} to ${runningEscomplexVersion} — run 'npm run crap:update'`,
    };
  }
  const warnings = [];
  if (baseline.kernelVersion !== runningKernelVersion) {
    warnings.push(
      `[CRAP] ⚠ kernelVersion drift: baseline=${baseline.kernelVersion} running=${runningKernelVersion}. ` +
        "Run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to refresh.",
    );
  }
  const baselineTs = baseline.tsTranspilerVersion ?? '0.0.0';
  if (runningTsTranspilerVersion && baselineTs !== runningTsTranspilerVersion) {
    warnings.push(
      `[CRAP] ⚠ tsTranspilerVersion drift: baseline=${baselineTs} running=${runningTsTranspilerVersion}. ` +
        "Run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to refresh.",
    );
  }
  return { ok: true, warnings };
}

/**
 * Build the structured `--json` report envelope.
 *
 * Violations carry the same fields the stdout printer emits plus a
 * deterministic `fixGuidance` block derived from the formula: target is the
 * baseline for regressions and the ceiling for new-method violations. Rows
 * are deep-cloned so callers can safely mutate the envelope without
 * corrupting the live comparator result.
 *
 * @param {{
 *   compareResult: ReturnType<typeof compareCrap>,
 *   scanSummary: { skippedFilesNoCoverage?: number, skippedMethodsNoCoverage?: number },
 *   kernelVersion: string,
 *   escomplexVersion: string,
 *   newMethodCeiling: number,
 * }} params
 * @returns {{
 *   kernelVersion: string,
 *   escomplexVersion: string,
 *   summary: object,
 *   violations: Array<object>,
 * }}
 */
export function buildCrapReport({
  compareResult,
  scanSummary,
  kernelVersion,
  escomplexVersion,
  newMethodCeiling,
}) {
  const skippedNoCoverage =
    (scanSummary?.skippedFilesNoCoverage ?? 0) +
    (scanSummary?.skippedMethodsNoCoverage ?? 0);
  const violations = (compareResult.violations ?? []).map((v) => {
    const target = v.kind === 'new' ? v.ceiling : v.baseline;
    const fixGuidance = deriveFixGuidance({
      cyclomatic: v.cyclomatic,
      target,
    });
    return {
      file: v.file,
      method: v.method,
      startLine: v.startLine,
      cyclomatic: v.cyclomatic,
      coverage: v.coverage,
      crap: v.crap,
      baseline: v.kind === 'new' ? null : v.baseline,
      ceiling: v.kind === 'new' ? v.ceiling : newMethodCeiling,
      kind: v.kind,
      fixGuidance,
    };
  });
  return {
    kernelVersion,
    escomplexVersion,
    summary: {
      total: compareResult.total,
      regressions: compareResult.regressions,
      newViolations: compareResult.newViolations,
      drifted: compareResult.drifted,
      removed: compareResult.removed,
      skippedNoCoverage,
    },
    violations,
  };
}

function writeJsonReport(jsonPath, envelope) {
  const abs = path.isAbsolute(jsonPath)
    ? jsonPath
    : path.resolve(process.cwd(), jsonPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(envelope, null, 2)}\n`);
}

function printSummary(result, scanSummary) {
  console.log('\n--- CRAP Report ---');
  console.log(`Total methods scanned: ${result.total}`);
  console.log(`Regressions:           ${result.regressions}`);
  console.log(`New-method violations: ${result.newViolations}`);
  console.log(`Drifted (matched):     ${result.drifted}`);
  console.log(`Removed from baseline: ${result.removed}`);
  if (scanSummary?.skippedFilesNoCoverage) {
    console.log(
      `Files without coverage:${' '.repeat(1)}${scanSummary.skippedFilesNoCoverage}`,
    );
  }
  console.log('-------------------\n');

  for (const v of result.violations) {
    if (v.kind === 'new') {
      console.error(
        `[CRAP] ❌ NEW-METHOD over ceiling: ${v.file}::${v.method} (line ${v.startLine})`,
      );
      console.error(
        `       crap=${v.crap.toFixed(2)} > ceiling=${v.ceiling} (c=${v.cyclomatic}, cov=${v.coverage.toFixed(2)})`,
      );
    } else {
      console.error(
        `[CRAP] ❌ REGRESSION: ${v.file}::${v.method} (line ${v.startLine}${v.kind === 'drifted-regression' ? `, baseline line ${v.baselineStartLine}` : ''})`,
      );
      console.error(
        `       crap=${v.crap.toFixed(2)} > baseline=${v.baseline.toFixed(2)} (c=${v.cyclomatic}, cov=${v.coverage.toFixed(2)})`,
      );
    }
  }
  if (result.removed > 0) {
    console.log(
      `[CRAP] ℹ ${result.removed} baseline row(s) absent from current scan (deleted or moved):`,
    );
    for (const r of result.removedRows) {
      console.log(
        `       - ${r.file}::${r.method} (baseline line ${r.startLine})`,
      );
    }
  }
}

async function emitFriction(storyId, result, orchestration) {
  if (!storyId) return;
  const offenders = result.violations;
  if (offenders.length === 0) return;
  const provider = createProvider(orchestration);
  const emitter = createFrictionEmitter({ provider });
  const body = [
    '### 🚧 Friction — CRAP baseline regression',
    '',
    `Story \`#${storyId}\` — \`check-crap\` detected ${offenders.length} violating method(s):`,
    '',
    '| File | Method | Line | CRAP | Baseline / Ceiling | Kind |',
    '|---|---|---|---|---|---|',
    ...offenders.map((v) => {
      const compare =
        v.kind === 'new' ? `ceiling ${v.ceiling}` : v.baseline.toFixed(2);
      return `| \`${v.file}\` | \`${v.method}\` | ${v.startLine} | ${v.crap.toFixed(2)} | ${compare} | ${v.kind} |`;
    }),
    '',
    'Add tests to raise coverage, reduce cyclomatic complexity, or run `npm run crap:update` with a `baseline-refresh:` commit if the drift is justified.',
  ].join('\n');
  try {
    await emitter.emit({
      ticketId: storyId,
      markerKey:
        orchestration?.agentSettings?.maintainability?.crap?.friction
          ?.markerKey ?? 'crap-baseline-regression',
      body,
    });
  } catch (err) {
    console.warn(`[CRAP] friction emit failed: ${err?.message ?? err}`);
  }
}

async function main() {
  const args = parseCliArgs();
  const { settings, ...rest } = resolveConfig();
  const crap = getQuality({ agentSettings: settings }).crap;

  if (crap.enabled === false) {
    console.log('[CRAP] gate skipped (disabled)');
    return 0;
  }

  // Resolve --changed-since BEFORE the baseline / kernel-mismatch checks.
  // A bad ref must always surface (AC14); silent degradation to bootstrap
  // exit 0 when the ref is misspelled would defeat the entire purpose of
  // the flag.
  let scopeSet = null;
  if (args.changedSinceRef) {
    try {
      const changed = getChangedFiles({
        ref: args.changedSinceRef,
        cwd: process.cwd(),
      });
      scopeSet = new Set(changed);
      console.log(
        `[CRAP] --changed-since ${args.changedSinceRef}: ${scopeSet.size} changed file(s) in diff`,
      );
    } catch (err) {
      console.error(
        `[CRAP] ❌ ${err?.message ?? err}. Pass a resolvable ref or drop --changed-since for a full scan.`,
      );
      return 1;
    }
  }

  const baselinePath =
    args.baselinePath ?? getBaselines({ agentSettings: settings }).crap.path;
  const baseline = getCrapBaseline({ baselinePath });
  const runningEscomplex = resolveEscomplexVersion();
  const runningTs = resolveTsTranspilerVersion();
  const compat = evaluateBaselineCompatibility({
    baseline,
    runningKernelVersion: KERNEL_VERSION,
    runningEscomplexVersion: runningEscomplex,
    runningTsTranspilerVersion: runningTs,
  });
  if (!compat.ok) {
    if (compat.exitCode === 0) console.log(compat.message);
    else console.error(compat.message);
    return compat.exitCode;
  }
  for (const warning of compat.warnings ?? []) {
    console.warn(warning);
  }

  const targetDirs = Array.isArray(crap.targetDirs) ? crap.targetDirs : [];
  const requireCoverage = crap.requireCoverage !== false;
  const coveragePath =
    args.coveragePath ?? crap.coveragePath ?? 'coverage/coverage-final.json';
  const { newMethodCeiling, tolerance, refreshTag, overrides } =
    resolveCrapEnvOverrides(crap, process.env);
  if (overrides.length > 0) {
    console.log(`[CRAP] env overrides active: ${overrides.join(', ')}`);
  }

  const coverage = loadCoverage(path.resolve(process.cwd(), coveragePath));

  const scan = scanAndScore({
    targetDirs,
    coverage,
    requireCoverage,
    cwd: process.cwd(),
    scopeFiles: scopeSet,
  });

  const baselineRows = scopeSet
    ? filterRowsByFileScope(baseline.rows, scopeSet)
    : baseline.rows;

  const result = compareCrap({
    currentRows: scan.rows,
    baselineRows,
    newMethodCeiling,
    tolerance,
  });

  printSummary(result, scan);

  if (args.jsonPath) {
    const envelope = buildCrapReport({
      compareResult: result,
      scanSummary: scan,
      kernelVersion: KERNEL_VERSION,
      escomplexVersion: runningEscomplex,
      newMethodCeiling,
    });
    try {
      writeJsonReport(args.jsonPath, envelope);
      console.log(`[CRAP] structured report written: ${args.jsonPath}`);
    } catch (err) {
      console.warn(
        `[CRAP] failed to write --json report: ${err?.message ?? err}`,
      );
    }
  }

  if (result.regressions > 0 || result.newViolations > 0) {
    console.error(
      `[CRAP] ❌ check failed. Reduce complexity or add coverage on the flagged methods, or run \`npm run crap:update\` with a \`${refreshTag}\` commit if justified.`,
    );
    if (args.storyId) {
      await emitFriction(args.storyId, result, {
        ...rest,
        agentSettings: settings,
      });
    }
    return 1;
  }

  console.log('[CRAP] ✅ check passed.');
  return 0;
}

// cli-opt-out: Windows-aware main-guard and main().then(code => process.exit(code)) result-code path; runAsCli does not propagate main's return value.
// Only run main when invoked directly — keep the module importable from tests.
const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = new URL(import.meta.url).pathname;
    // Normalize: on Windows URL pathname has a leading slash before the drive.
    const normalizedSelf = /^\/[A-Za-z]:/.test(self) ? self.slice(1) : self;
    return path.resolve(normalizedSelf) === invoked;
  } catch {
    return false;
  }
})();

if (isDirect) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(
        `[CRAP] ❌ Fatal error: ${err?.stack ?? err?.message ?? err}`,
      );
      process.exit(1);
    });
}
