/**
 * evaluate.js — Phase 4 of the check-baselines pipeline (Story #2466).
 *
 * Runs the per-kind pipeline: load → floor → compare → tolerance → report.
 * Extracted from `check-baselines.js` without behavior change.
 *
 * @module lib/orchestration/check-baselines/phases/evaluate
 */

import {
  resolveBundleSizeEnvOverrides,
  resolveMaintainabilityRefreshOverrides,
} from '../../../baselines/env-overrides.js';
import { readRangeSubjectsTouchingFile } from '../../../baselines/git-base.js';
import {
  checkKernelVersion,
  getKindModule,
} from '../../../baselines/kernel.js';
import * as reader from '../../../baselines/reader.js';
import { Logger } from '../../../Logger.js';
import { isIgnoredByGlobs } from '../../../maintainability-utils.js';
import { applyTolerance, evaluateCompare, runCompareStage } from './compare.js';
import { applyFloors, flattenBreaches } from './floors.js';
import { DEFAULT_BASELINE_PATHS } from './parse-args.js';

/** Default refresh-tag substring when the gate omits `refreshTag`. */
const DEFAULT_REFRESH_TAG = 'baseline-refresh:';

/**
 * Defense-in-depth against an `ignoreGlobs`-poisoned baseline (Epic #4326
 * incident). The generation path already drops `ignoreGlobs`-matched files
 * before they reach `rows` (both the canonical `buildDefaultMaintainabilityScorer`
 * and the story-close `buildKindScorer`), so a freshly-generated baseline's
 * `rollup["*"]` never includes an ignored file. But the floor check trusts the
 * *stored* `rollup["*"]`: if a baseline is poisoned by some other route — a
 * stale branch's older tooling, a hand-edit, a future generation bug — an
 * ignored file's metric can still drag the global floor axis (e.g.
 * maintainability `min`) below its floor and block every downstream close.
 *
 * This recomputes the global `*` aggregate over the baseline rows that are NOT
 * matched by the gate's `ignoreGlobs`, using the kind's own canonical
 * `rollup()` aggregator, so the floor axis reflects only the files the gate is
 * meant to police. It is a **no-op for a correctly-generated baseline** (no
 * ignored file is present in `rows`, so the filtered set is identical and the
 * stored `rollup["*"]` is returned unchanged) and only affects the `*`
 * component the incident poisons; named-component rollups are left as stored.
 * The compare/regression stage is untouched — this only reshapes the floor
 * input. All three `ignoreGlobs`-configured gates (maintainability, crap,
 * duplication) are `path`-keyed, so the shared path matcher applies uniformly.
 *
 * Kept module-local (not exported): the poison-exclusion behaviour is covered
 * end-to-end through `evaluateKind` by the `check-baselines.min-floor` suite,
 * so there is no external consumer to justify widening the surface.
 *
 * @param {{ kind: string, baseline: { rollup?: object, rows?: object[] }, ignoreGlobs?: string[], cwd?: string }} args
 * @returns {object} the effective rollup to feed the floor check
 */
function rollupExcludingIgnored({ kind, baseline, ignoreGlobs, cwd }) {
  const rollup = baseline?.rollup;
  if (!Array.isArray(ignoreGlobs) || ignoreGlobs.length === 0) return rollup;
  const rows = baseline?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return rollup;
  let mod;
  try {
    mod = getKindModule(kind);
  } catch {
    return rollup;
  }
  if (mod?.keyField !== 'path' || typeof mod.rollup !== 'function')
    return rollup;
  const kept = rows.filter((row) => {
    const p = row?.path;
    return typeof p !== 'string' || !isIgnoredByGlobs(p, ignoreGlobs, cwd);
  });
  // Nothing ignored is present → the stored rollup already excludes ignored
  // files (the correct-baseline fast path); return it untouched.
  if (kept.length === rows.length) return rollup;
  const recomputed = mod.rollup(kept);
  return { ...rollup, '*': recomputed?.['*'] ?? rollup?.['*'] };
}

function loadHeadBaseline(kind, cwd, configPath) {
  try {
    return { baseline: reader.load(kind, { cwd, configPath }) };
  } catch (err) {
    const message = err?.message ?? String(err);
    const tag = /schema validation failed/i.test(message) ? 'schema' : 'read';
    return { schemaError: { tag, message } };
  }
}

/**
 * One-shot bundle-size refresh/acknowledge (Story #151). When
 * `BUNDLE_SIZE_REFRESH=1` is set, demote every `bundle-size` regression to
 * `unchanged` for this run only — floors still apply, so a genuine budget
 * breach is still caught. The flag is read fresh on every invocation and
 * never persisted, so the ratchet returns to full strength automatically on
 * the very next run (no lingering loosened tolerance to remember to reset).
 *
 * No-op for every other kind.
 */
function applyBundleSizeAcknowledgment(kind, compareOutput, env) {
  if (kind !== 'bundle-size') return { compareOutput, acknowledged: false };
  const { acknowledged, overrides } = resolveBundleSizeEnvOverrides(env);
  if (!acknowledged || compareOutput.regressions.length === 0) {
    return { compareOutput, acknowledged: false };
  }
  Logger.warn(
    `[bundle-size] ⚠ ${overrides.join(', ')} — ` +
      `${compareOutput.regressions.length} regression(s) acknowledged for this run only; ` +
      'floors still enforced. This does not persist: the next run without ' +
      'BUNDLE_SIZE_REFRESH re-enforces the ratchet at full strength.',
  );
  return {
    acknowledged: true,
    compareOutput: {
      ...compareOutput,
      regressions: [],
      unchanged: [...compareOutput.unchanged, ...compareOutput.regressions],
    },
  };
}

/**
 * Resolve the maintainability refresh trigger (Story #4731). Two paths, either
 * of which acknowledges — mirroring the bundle-size acknowledge but adding the
 * commit-tagged trigger the breach message already documents:
 *
 *   1. Env parity: `MAINTAINABILITY_REFRESH=1` (the manual override).
 *   2. Commit tag: a commit in the compared range `<baseRef>..HEAD` whose
 *      subject contains the configured `refreshTag` AND whose diff touches the
 *      maintainability baseline file. One-shot by construction — once merged,
 *      the refreshed baseline becomes the base and the tag leaves the range.
 *
 * The tag is matched as a plain substring of a conventional commit subject, so
 * commitlint stays satisfied (e.g. `chore(baselines): baseline-refresh: …`).
 *
 * @returns {{ triggered: boolean, reasons: string[] }}
 */
function resolveMaintainabilityRefreshTrigger({ gateBlock, cmp, cwd, env }) {
  const reasons = [];
  const { acknowledged: envAck, overrides } =
    resolveMaintainabilityRefreshOverrides(env);
  if (envAck) reasons.push(...overrides);

  const baseRef = cmp?.baseRef ?? null;
  if (baseRef) {
    const refreshTag =
      typeof gateBlock?.refreshTag === 'string' && gateBlock.refreshTag.length
        ? gateBlock.refreshTag
        : DEFAULT_REFRESH_TAG;
    const baselinePath =
      typeof gateBlock?.baselinePath === 'string' &&
      gateBlock.baselinePath.length
        ? gateBlock.baselinePath
        : DEFAULT_BASELINE_PATHS.maintainability;
    const subjects = readRangeSubjectsTouchingFile(baseRef, baselinePath, {
      cwd,
    });
    const match = subjects.find((s) => s.includes(refreshTag));
    if (match) {
      reasons.push(
        `refresh commit "${match}" (subject contains ${JSON.stringify(refreshTag)}, touches ${baselinePath})`,
      );
    }
  }

  return { triggered: reasons.length > 0, reasons };
}

/**
 * One-shot maintainability refresh/acknowledge (Story #4731). When triggered
 * (env flag OR a `baseline-refresh:`-tagged range commit touching the baseline),
 * demote every maintainability head-vs-base regression to `unchanged` for this
 * run only — floors still apply, so a row below its `min` floor still breaches.
 * The trigger is read fresh every run and never persisted: post-merge the
 * refreshed baseline is the new base and the tag leaves the range, so the
 * ratchet returns to full strength automatically.
 *
 * No-op for every other kind.
 */
function applyMaintainabilityAcknowledgment(kind, compareOutput, ctx) {
  if (kind !== 'maintainability') {
    return { compareOutput, acknowledged: false };
  }
  const { triggered, reasons } = resolveMaintainabilityRefreshTrigger(ctx);
  if (!triggered || compareOutput.regressions.length === 0) {
    return { compareOutput, acknowledged: false };
  }
  Logger.warn(
    `[maintainability] ⚠ ${reasons.join('; ')} — ` +
      `${compareOutput.regressions.length} regression(s) acknowledged for this run only; ` +
      'floors still enforced. This does not persist: once the refresh is the ' +
      'new base the ratchet re-enforces at full strength.',
  );
  return {
    acknowledged: true,
    compareOutput: {
      ...compareOutput,
      regressions: [],
      unchanged: [...compareOutput.unchanged, ...compareOutput.regressions],
    },
  };
}

function buildGateReport({
  kind,
  gateBlock,
  baseline,
  findings,
  breaches,
  compareOutput,
  cmp,
  acknowledged,
}) {
  const kernel = checkKernelVersion(kind, baseline.kernelVersion);
  return {
    kind,
    enabled: true,
    kernelMatch: kernel.match,
    kernelCurrent: kernel.current,
    kernelBaseline: baseline.kernelVersion,
    tolerance: gateBlock.tolerance ?? null,
    floors: gateBlock.floors ?? {},
    components: findings,
    breachCount: breaches.length,
    breaches,
    regressions: compareOutput.regressions,
    improvements: compareOutput.improvements,
    unchanged: compareOutput.unchanged,
    additions: compareOutput.additions ?? [],
    regressionCount: compareOutput.regressions.length,
    baseRef: cmp.baseRef ?? null,
    generatedAt: baseline.generatedAt,
    acknowledged,
  };
}

export async function evaluateKind({
  kind,
  gateBlock,
  scope,
  cwd,
  configPath,
  env = process.env,
}) {
  const headLoad = loadHeadBaseline(kind, cwd, configPath);
  if (headLoad.schemaError) return { kind, schemaError: headLoad.schemaError };
  const baseline = headLoad.baseline;
  const floorRollup = rollupExcludingIgnored({
    kind,
    baseline,
    ignoreGlobs: gateBlock.ignoreGlobs,
    cwd,
  });
  const findings = applyFloors(kind, floorRollup, gateBlock.floors ?? {});
  const breaches = flattenBreaches(findings);
  const cmp = await evaluateCompare({ kind, gateBlock, scope, cwd });
  const rawCompare = runCompareStage(baseline, cmp);
  const toleratedCompare = applyTolerance(
    rawCompare,
    gateBlock.tolerance ?? null,
  );
  const bundleAck = applyBundleSizeAcknowledgment(kind, toleratedCompare, env);
  const miAck = applyMaintainabilityAcknowledgment(
    kind,
    bundleAck.compareOutput,
    { gateBlock, cmp, cwd, env },
  );
  const compareOutput = miAck.compareOutput;
  const acknowledged = bundleAck.acknowledged || miAck.acknowledged;
  return buildGateReport({
    kind,
    gateBlock,
    baseline,
    findings,
    breaches,
    compareOutput,
    cmp,
    acknowledged,
  });
}
