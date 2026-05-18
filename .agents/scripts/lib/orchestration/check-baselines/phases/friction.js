/**
 * friction.js — Phase 5 of the check-baselines pipeline (Story #2466).
 *
 * Centralised friction emission. The dispatcher is the single emission
 * site: per (kind, severity) tuple, exactly one friction event with the
 * canonical payload `{tool:'check-baselines', kind, severity, file?,
 * method?, delta?, baseRef}`.
 *
 * Severities:
 *   - `floor`            — at least one floor breach.
 *   - `regression`       — at least one head-vs-base regression.
 *   - `schema`           — head baseline failed schema validation / read.
 *   - `kernel-mismatch`  — baseline kernelVersion ≠ running kernel.
 *
 * @module lib/orchestration/check-baselines/phases/friction
 */

import { emitFrictionSignal } from '../../../gates/friction.js';

function buildSchemaEvent(envelope, schemaError) {
  return { ...envelope, severity: 'schema', message: schemaError.message };
}

function buildFloorEvent(envelope, breaches) {
  const first = breaches?.[0];
  const value = first?.value;
  const floor = first?.floor;
  const delta =
    typeof value === 'number' && typeof floor === 'number'
      ? value - floor
      : null;
  return {
    ...envelope,
    severity: 'floor',
    file: first?.component ?? null,
    method: first?.axis ?? null,
    delta,
  };
}

function buildRegressionEvent(envelope, regressions) {
  const first = regressions?.[0];
  return {
    ...envelope,
    severity: 'regression',
    file: first?.key ?? null,
    method: null,
    delta: null,
  };
}

function buildKernelMismatchEvent(envelope, gateReport) {
  return {
    ...envelope,
    severity: 'kernel-mismatch',
    file: null,
    method: null,
    delta: null,
    baselineKernelVersion: gateReport.kernelBaseline,
    runningKernelVersion: gateReport.kernelCurrent,
  };
}

async function dispatchFrictionEvent({ args, category, details, payload }) {
  await emitFrictionSignal({
    storyId: args.storyId,
    epicId: args.epicId,
    category,
    tool: 'check-baselines',
    details,
    payload,
    logLabel: 'check-baselines',
  });
}

async function emitSchemaFriction({ args, envelope, schemaError, emitted }) {
  const ev = buildSchemaEvent(envelope, schemaError);
  emitted.push(ev);
  await dispatchFrictionEvent({
    args,
    category: 'baseline-schema-error',
    details: schemaError.message,
    payload: ev,
  });
}

async function emitFloorFriction({ args, envelope, gateReport, emitted }) {
  if ((gateReport?.breachCount ?? 0) === 0) return;
  const ev = buildFloorEvent(envelope, gateReport.breaches);
  emitted.push(ev);
  await dispatchFrictionEvent({
    args,
    category: 'baseline-floor-breach',
    details: `kind=${gateReport.kind}; breaches=${gateReport.breachCount}`,
    payload: ev,
  });
}

async function emitRegressionFriction({ args, envelope, gateReport, emitted }) {
  if ((gateReport?.regressionCount ?? 0) === 0) return;
  const ev = buildRegressionEvent(envelope, gateReport.regressions);
  emitted.push(ev);
  await dispatchFrictionEvent({
    args,
    category: 'baseline-regression',
    details:
      `kind=${gateReport.kind}; regressions=${gateReport.regressionCount}; ` +
      `baseRef=${envelope.baseRef ?? 'none'}`,
    payload: ev,
  });
}

async function emitKernelFriction({ args, envelope, gateReport, emitted }) {
  if (gateReport?.kernelMatch !== false) return;
  const ev = buildKernelMismatchEvent(envelope, gateReport);
  emitted.push(ev);
  await dispatchFrictionEvent({
    args,
    category: 'baseline-kernel-mismatch',
    details:
      `kind=${gateReport.kind}; baseline=${gateReport.kernelBaseline}; ` +
      `running=${gateReport.kernelCurrent}`,
    payload: ev,
  });
}

export async function emitGateFriction({ gateReport, schemaError, args }) {
  const emitted = [];
  if (!args.friction) return emitted;
  const baseRef = gateReport?.baseRef ?? null;
  const kind = gateReport?.kind ?? schemaError?.kind;
  const envelope = { tool: 'check-baselines', kind, baseRef };

  if (schemaError) {
    await emitSchemaFriction({ args, envelope, schemaError, emitted });
    return emitted;
  }
  await emitFloorFriction({ args, envelope, gateReport, emitted });
  await emitRegressionFriction({ args, envelope, gateReport, emitted });
  await emitKernelFriction({ args, envelope, gateReport, emitted });
  return emitted;
}
