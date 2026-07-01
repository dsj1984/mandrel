/**
 * pipeline.js — Phase 7 of the check-baselines pipeline (Story #2466).
 *
 * Orchestrates the per-kind dispatch: filter enabled kinds, fan-out via
 * `Promise.all`, aggregate exit codes through the shared helper, run
 * friction emission, and assemble the final structured report.
 *
 * Extracted from `check-baselines.js` without behavior change.
 *
 * @module lib/orchestration/check-baselines/phases/pipeline
 */

import {
  aggregate as aggregateExitCodes,
  EXIT_FLOOR,
  EXIT_PASS,
  EXIT_REGRESSION,
  EXIT_SCHEMA,
} from '../../../baselines/exit-codes.js';
import { getQuality, resolveConfig } from '../../../config-resolver.js';
import { resolveDispatchScope } from './compare.js';
import { evaluateKind } from './evaluate.js';
import { emitGateFriction } from './friction.js';
import { HELP_TEXT, helpReport, KNOWN_KINDS, parseArgs } from './parse-args.js';
import { formatReport } from './report.js';

export function selectEnabledGates(quality) {
  const gates = quality?.gates ?? {};
  const out = [];
  for (const kind of KNOWN_KINDS) {
    const block = gates[kind];
    if (!block || typeof block !== 'object') continue;
    if (block.enabled === false) continue;
    out.push(kind);
  }
  return out;
}

function emptyReport(cwd) {
  return {
    schemaVersion: '1',
    cwd,
    gates: [],
    totalBreaches: 0,
    totalRegressions: 0,
    kernelDriftCount: 0,
    schemaErrors: [],
  };
}

function pickWantedKinds(quality, gateFilter) {
  const allKinds = selectEnabledGates(quality);
  if (!gateFilter || gateFilter.length === 0) return allKinds;
  return allKinds.filter((k) => gateFilter.includes(k));
}

function dispatchPerKind({ wanted, quality, env, cwd, configPath }) {
  return Promise.all(
    wanted.map((kind) => {
      const gateBlock = quality.gates[kind];
      const scope = resolveDispatchScope({ kind, quality, env });
      return evaluateKind({ kind, gateBlock, scope, cwd, configPath, env });
    }),
  );
}

/**
 * Map a per-kind gate result to its exit code. Regression contributes to
 * EXIT_REGRESSION only when the gate has an explicit tolerance policy.
 */
function exitCodeForGate(result) {
  if ((result.regressionCount ?? 0) > 0 && result.tolerance) {
    return EXIT_REGRESSION;
  }
  if (result.breachCount > 0) return EXIT_FLOOR;
  return EXIT_PASS;
}

async function accumulateSchemaError(result, ctx) {
  ctx.report.schemaErrors.push({
    kind: result.kind,
    tag: result.schemaError.tag,
    message: result.schemaError.message,
  });
  ctx.perKindExitCodes.push(EXIT_SCHEMA);
  const events = await emitGateFriction({
    gateReport: null,
    schemaError: { ...result.schemaError, kind: result.kind },
    args: ctx.args,
  });
  ctx.frictionEvents.push(...events);
}

async function accumulateGateResult(result, ctx) {
  ctx.report.gates.push(result);
  ctx.report.totalBreaches += result.breachCount;
  ctx.report.totalRegressions += result.regressionCount ?? 0;
  if (!result.kernelMatch) ctx.report.kernelDriftCount += 1;
  ctx.perKindExitCodes.push(exitCodeForGate(result));
  const events = await emitGateFriction({ gateReport: result, args: ctx.args });
  ctx.frictionEvents.push(...events);
}

async function consumePerKindResults(perKindResults, args, report) {
  const ctx = { args, report, perKindExitCodes: [], frictionEvents: [] };
  for (const result of perKindResults) {
    if (result.schemaError) {
      await accumulateSchemaError(result, ctx);
      continue;
    }
    await accumulateGateResult(result, ctx);
  }
  return {
    exitCode: aggregateExitCodes(...ctx.perKindExitCodes),
    frictionEvents: ctx.frictionEvents,
  };
}

export async function runCheckBaselines({
  argv,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const args = parseArgs(argv ?? []);
  if (args.help) {
    return {
      exitCode: 0,
      report: helpReport(),
      output: HELP_TEXT,
      frictionEvents: [],
    };
  }
  const config = resolveConfig({
    cwd,
    configPath: args.configPath ?? undefined,
  });
  const quality = getQuality({ delivery: config.delivery });
  const wanted = pickWantedKinds(quality, args.gates);
  const perKindResults = await dispatchPerKind({
    wanted,
    quality,
    env,
    cwd,
    configPath: args.configPath ?? undefined,
  });
  const report = emptyReport(cwd);
  const { exitCode, frictionEvents } = await consumePerKindResults(
    perKindResults,
    args,
    report,
  );
  return {
    exitCode,
    report,
    output: formatReport(report, args.format),
    frictionEvents,
  };
}
