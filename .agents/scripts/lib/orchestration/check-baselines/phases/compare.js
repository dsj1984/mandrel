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

export function resolveDispatchScope({ kind, quality, env }) {
  const cfg = quality?.gateScoping ?? {};
  return resolveScope({
    kind,
    configScope: cfg.scope,
    configRef: cfg.diffRef,
    envScope: env?.BASELINE_SCOPE,
    envRef: env?.BASELINE_REF,
  });
}

function emptyCompareResult(baseRef) {
  return { baseRef, baseRead: false };
}

/**
 * Story #4914 — a base read that FAILS is not a base that is ABSENT.
 *
 * `readBaseFromGit` already draws that line itself: it returns `null` only
 * for git exit 128 ("path does not exist in this revision") and throws on
 * everything else. Swallowing the throw conflated the two, so a broken read
 * silently emptied the whole head-vs-base arm — regressions AND additions —
 * while the floors arm kept the run at exit 0. A gate that fails open is
 * worse than no gate, because it is trusted.
 *
 * So the read failure fails CLOSED as `EXIT_CONFIG` (3) — "the gate could
 * not even start", the same code `assertFloorAxesExist` uses for a
 * misconfigured floor axis. `check-baselines.js#main` maps any throw out of
 * the pipeline onto that code.
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
    // Story #5277 — the same distinction one line above, applied to the
    // second way a base read fails. `null` here means "no baseline at the base
    // ref", which empties the head-vs-base arm on purpose; an UNPARSEABLE base
    // blob is a read that failed, and reporting it as "no base" made a
    // corrupted or half-merged `baselines/*.json` on the base branch report
    // zero regressions at exit 0. Text-merged baselines are exactly how such a
    // blob gets onto the base branch, which is the failure this Story removes
    // upstream — this arm is what stops it being silent when it happens anyway.
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
 * Is the base baseline comparable to the head baseline (Story #4775)?
 *
 * A kind can change its SCORING SEMANTICS — how it derives a row's metric —
 * without moving `kernelVersion`. Across that boundary the same row can carry
 * a different score for reasons that have nothing to do with the branch's
 * changes, so a head-vs-base diff manufactures phantom regressions (and can
 * hide real ones behind them).
 *
 * The head-side stamp is already a fail-closed gate: a stale HEAD baseline
 * never reaches this point. What reaches here is the opposite and legitimate
 * case — a branch that DOES carry a re-derived baseline, compared against a
 * base that predates the change. The only honest verdict is "no comparison";
 * floors still run, so a genuine ceiling breach is still caught, and once the
 * refreshed baseline is the base the ratchet returns to full strength on the
 * very next run without anything to remember to reset.
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
