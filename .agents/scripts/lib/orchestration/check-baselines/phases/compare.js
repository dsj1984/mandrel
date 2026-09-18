/**
 * Head-vs-base compare stage of check-baselines: scope, base read, per-kind
 * classifier, tolerance.
 *
 * @module lib/orchestration/check-baselines/phases/compare
 */

import { EXIT_CONFIG } from '../../../baselines/exit-codes.js';
import { readBaseFromGit } from '../../../baselines/git-base.js';
import { getKindModule } from '../../../baselines/kernel.js';
import { resolveScope } from '../../../baselines/scope.js';
import { Logger } from '../../../Logger.js';
import { DEFAULT_BASELINE_PATHS } from './parse-args.js';

function baselineRelativePath(kind, gateBlock) {
  const configured =
    typeof gateBlock?.baselinePath === 'string' &&
    gateBlock.baselinePath.length > 0
      ? gateBlock.baselinePath
      : null;
  return configured ?? DEFAULT_BASELINE_PATHS[kind];
}

export function resolveDispatchScope({ kind, env }) {
  return resolveScope({
    kind,
    envScope: env?.BASELINE_SCOPE,
    envRef: env?.BASELINE_REF,
  });
}

function emptyCompareResult(baseRef) {
  return { baseRef, baseRead: false };
}

/**
 * A failed base read is not an absent base: it fails closed as `EXIT_CONFIG`
 * rather than silently emptying the compare arm to a trusted exit 0.
 */
function buildBaseReadError({ kind, ref, file, cause }) {
  const detail = cause?.message ?? String(cause);
  const err = new Error(
    `[check-baselines:${kind}] could not read the base baseline at ` +
      `${ref}:${file} — the head-vs-base compare arm cannot run, so the gate ` +
      `fails closed rather than reporting zero regressions: ${detail}`,
  );
  err.code = 'EXIT_CONFIG';
  err.exitCode = EXIT_CONFIG;
  err.kind = kind;
  err.baseRef = ref;
  err.baselinePath = file;
  err.cause = cause;
  return err;
}

function readBaseBaselinePayload(scope, kind, gateBlock, cwd) {
  const rel = baselineRelativePath(kind, gateBlock);
  let raw;
  try {
    raw = readBaseFromGit(scope.ref, rel, { cwd });
  } catch (cause) {
    throw buildBaseReadError({ kind, ref: scope.ref, file: rel, cause });
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    // An unparseable (e.g. text-merged) base blob is a failed read too.
    throw buildBaseReadError({ kind, ref: scope.ref, file: rel, cause });
  }
}

export async function evaluateCompare({ kind, gateBlock, scope, cwd }) {
  if (scope.mode !== 'diff' || !scope.ref) return emptyCompareResult(null);
  const basePayload = readBaseBaselinePayload(scope, kind, gateBlock, cwd);
  if (!basePayload) return emptyCompareResult(scope.ref);
  const kindModule = getKindModule(kind);
  if (typeof kindModule.compare !== 'function') {
    return emptyCompareResult(scope.ref);
  }
  return { baseRef: scope.ref, baseRead: true, basePayload, kindModule };
}

/**
 * Rows scored under different `scoringSemantics` are incomparable (phantom
 * regressions), so a branch carrying a re-derived baseline skips compare
 * against an older base; floors still run.
 */
function baseIsComparable(headBaseline, basePayload) {
  const head = headBaseline?.scoringSemantics ?? null;
  const base = basePayload?.scoringSemantics ?? null;
  return head === base;
}

export function runCompareStage(headBaseline, cmp) {
  const empty = {
    regressions: [],
    improvements: [],
    unchanged: [],
    additions: [],
  };
  if (!cmp.baseRead || !cmp.basePayload || !cmp.kindModule) return empty;
  if (!baseIsComparable(headBaseline, cmp.basePayload)) {
    Logger.warn(
      `[${cmp.kindModule.name}] ⚠ base baseline was scored under different ` +
        `semantics (base=${cmp.basePayload.scoringSemantics ?? '<unstamped>'} ` +
        `head=${headBaseline?.scoringSemantics ?? '<unstamped>'}); its rows are ` +
        'not comparable, so the head-vs-base compare is skipped for this run. ' +
        'Floors still enforced. The ratchet resumes once the re-derived ' +
        'baseline is the base.',
    );
    return empty;
  }
  try {
    const baseRows = Array.isArray(cmp.basePayload.rows)
      ? cmp.basePayload.rows
      : [];
    const result = cmp.kindModule.compare(
      { rows: headBaseline.rows },
      { rows: baseRows },
    );
    return {
      regressions: result?.regressions ?? [],
      improvements: result?.improvements ?? [],
      unchanged: result?.unchanged ?? [],
      additions: result?.additions ?? [],
    };
  } catch {
    return empty;
  }
}

function tolerantNumericFields(head, base) {
  if (!head || !base) return [];
  return Object.entries(head)
    .filter(
      ([key, h]) => typeof h === 'number' && typeof base[key] === 'number',
    )
    .map(([key, h]) => ({ key, head: h, base: base[key] }));
}

function regressionExceedsTolerance(reg, threshold) {
  const fields = tolerantNumericFields(reg.head, reg.base);
  if (fields.length === 0) return true;
  return fields.some(({ head, base }) => Math.abs(head - base) >= threshold);
}

/**
 * Apply per-gate tolerance to raw compare output. `{ kind: 'absolute',
 * value: N }` demotes near-floor regressions to `unchanged`.
 */
export function applyTolerance(compareOutput, tolerance) {
  if (!tolerance || tolerance.kind !== 'absolute') return compareOutput;
  const threshold = Number(tolerance.value);
  if (!Number.isFinite(threshold) || threshold <= 0) return compareOutput;
  const kept = [];
  const demoted = [];
  for (const reg of compareOutput.regressions) {
    if (regressionExceedsTolerance(reg, threshold)) kept.push(reg);
    else demoted.push(reg);
  }
  return {
    ...compareOutput,
    regressions: kept,
    unchanged: [...compareOutput.unchanged, ...demoted],
  };
}
