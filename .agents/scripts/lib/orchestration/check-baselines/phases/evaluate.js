/**
 * Per-kind check-baselines pipeline: load → floor → compare → tolerance →
 * acknowledgment → report.
 *
 * @module lib/orchestration/check-baselines/phases/evaluate
 */

import {
  checkBaselineSemantics,
  checkKernelVersion,
  getKindModule,
} from '../../../baselines/kernel.js';
import * as reader from '../../../baselines/reader.js';
import { isIgnoredByGlobs } from '../../../maintainability-utils.js';
import { applyTolerance, evaluateCompare, runCompareStage } from './compare.js';
import { applyFloors, flattenBreaches } from './floors.js';
import { applyRefreshAcknowledgment } from './refresh-ack.js';

/**
 * Recompute the `*` floor rollup without `ignoreGlobs` rows, in case a
 * baseline was poisoned by some route other than generation (which already
 * drops them); an ignored file could otherwise breach a global floor. A no-op
 * for a correct baseline; compare is untouched.
 *
 * @param {{ kind: string, baseline: { rollup?: object, rows?: object[] }, ignoreGlobs?: string[], cwd?: string }} args
 * @returns {object}
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

function buildGateReport({
  kind,
  gateBlock,
  baseline,
  findings,
  breaches,
  compareOutput,
  cmp,
  ack,
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
    // Without this a compare arm that never ran looks identical to a clean run.
    baseRead: cmp.baseRead === true,
    generatedAt: baseline.generatedAt,
    acknowledged: ack.acknowledged,
    // Acknowledgment can be partial; name which regressions it cleared.
    acknowledgedKeys: ack.acknowledgedKeys,
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
  // Rows from superseded scoring semantics pass schema but are incomparable;
  // fail closed.
  const semanticsError = checkBaselineSemantics(kind, baseline);
  if (semanticsError) {
    return {
      kind,
      schemaError: { tag: 'semantics', message: semanticsError },
    };
  }
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
  const ack = applyRefreshAcknowledgment(kind, toleratedCompare, {
    gateBlock,
    cmp,
    cwd,
    env,
    headBaseline: baseline,
  });
  return buildGateReport({
    kind,
    gateBlock,
    baseline,
    findings,
    breaches,
    compareOutput: ack.compareOutput,
    cmp,
    ack,
  });
}
