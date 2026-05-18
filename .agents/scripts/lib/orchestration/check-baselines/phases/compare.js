/**
 * compare.js — Phase 3 of the check-baselines pipeline (Story #2466).
 *
 * Owns the head-vs-base compare stage: scope resolution, base-baseline
 * read, per-kind classifier dispatch, and tolerance application.
 *
 * Extracted from `check-baselines.js` without behavior change.
 *
 * @module lib/orchestration/check-baselines/phases/compare
 */

import { readBaseFromGit } from '../../../baselines/git-base.js';
import { getKindModule } from '../../../baselines/kernel.js';
import { resolveScope } from '../../../baselines/scope.js';
import { DEFAULT_BASELINE_PATHS } from './parse-args.js';

function baselineRelativePath(kind, gateBlock) {
  const configured =
    typeof gateBlock?.baselinePath === 'string' &&
    gateBlock.baselinePath.length > 0
      ? gateBlock.baselinePath
      : null;
  return configured ?? DEFAULT_BASELINE_PATHS[kind];
}

export function resolveDispatchScope({ kind, quality, env }) {
  const cfg = quality?.gateScoping ?? {};
  return resolveScope({
    kind,
    configScope: cfg.scope,
    configRef: cfg.diffRef,
    cliFlags: {
      envScope: env?.BASELINE_SCOPE,
      envRef: env?.BASELINE_REF,
    },
  });
}

function emptyCompareResult(baseRef) {
  return { baseRef, baseRead: false };
}

function readBaseBaselinePayload(scope, kind, gateBlock, cwd) {
  const rel = baselineRelativePath(kind, gateBlock);
  let raw;
  try {
    raw = readBaseFromGit(scope.ref, rel, { cwd });
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
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

export function runCompareStage(headBaseline, cmp) {
  const empty = {
    regressions: [],
    improvements: [],
    unchanged: [],
    additions: [],
  };
  if (!cmp.baseRead || !cmp.basePayload || !cmp.kindModule) return empty;
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
