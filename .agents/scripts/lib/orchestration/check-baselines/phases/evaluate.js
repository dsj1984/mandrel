/**
 * evaluate.js — Phase 4 of the check-baselines pipeline (Story #2466).
 *
 * Runs the per-kind pipeline: load → floor → compare → tolerance → report.
 * Extracted from `check-baselines.js` without behavior change.
 *
 * @module lib/orchestration/check-baselines/phases/evaluate
 */

import { resolveBundleSizeEnvOverrides } from '../../../baselines/env-overrides.js';
import { checkKernelVersion } from '../../../baselines/kernel.js';
import * as reader from '../../../baselines/reader.js';
import { Logger } from '../../../Logger.js';
import { applyTolerance, evaluateCompare, runCompareStage } from './compare.js';
import { applyFloors, flattenBreaches } from './floors.js';

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
  const findings = applyFloors(kind, baseline.rollup, gateBlock.floors ?? {});
  const breaches = flattenBreaches(findings);
  const cmp = await evaluateCompare({ kind, gateBlock, scope, cwd });
  const rawCompare = runCompareStage(baseline, cmp);
  const toleratedCompare = applyTolerance(
    rawCompare,
    gateBlock.tolerance ?? null,
  );
  const { compareOutput, acknowledged } = applyBundleSizeAcknowledgment(
    kind,
    toleratedCompare,
    env,
  );
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
