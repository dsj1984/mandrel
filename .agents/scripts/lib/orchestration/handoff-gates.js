/**
 * handoff-gates.js — the handoff's view of close's own gate list, so argv,
 * env and evidence keys never drift from close.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASELINES_GATE_NAMES,
  buildDefaultGates,
  OVER_BUDGET_BLOCK_HINT,
  overBudgetPolicy,
  QUALITY_PREVIEW_GATE_NAMES,
} from '../close-validation/gates.js';
import { getPostSeatChecks } from '../config/handoff.js';
import { COVERAGE_OVER_BUDGET_EXIT_CODE } from '../coverage-capture.js';
import {
  COVERAGE_DEFERRED_REASONS,
  deferCoverage,
  deferralEnvelope,
} from '../coverage-deferral.js';
import {
  hashCommandConfig,
  recordPass,
  treeFingerprint,
} from '../validation-evidence.js';

const EVIDENCE_GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'evidence-gate.js',
);

/** Close's gate list, built with the inputs its validation phase passes. */
function closeGates(ctx) {
  return buildDefaultGates({
    config: ctx.config,
    baseBranch: ctx.baseBranch,
    baselineRef: ctx.baselineRef,
    cwd: ctx.cwd,
    evidenceCwd: ctx.evidenceCwd,
    storyId: ctx.storyId,
    packageScripts: ctx.scripts,
    presentBaselines: ctx.presentBaselines,
    getChangedFilesImpl: ctx.getChangedFilesFn,
    gitSpawnImpl: ctx.git,
  });
}

/**
 * Gates whose argv ignores the changed-file set, so a baselines-only seat
 * keeps their credit. Not `format`: its scoped argv names the changed files.
 */
const CARRYABLE_GATES = new Set(['lint', 'typecheck']);

/**
 * With `postSeatChecks` declared, `lint` runs bare: its credit is held until
 * those checks pass at HEAD (story-handoff's `releaseHeldLint`).
 */
function holdsLint(ctx, gate) {
  return gate.name === 'lint' && getPostSeatChecks(ctx.config).length > 0;
}

/** The argv a preflight check runs: bare when held, else deposited. */
function preflightArgv(ctx, gate, run) {
  if (holdsLint(ctx, gate)) {
    return { cmd: run.cmd, args: run.args, held: true };
  }
  return {
    cmd: 'node',
    args: [
      EVIDENCE_GATE,
      '--standalone',
      '--scope-id',
      String(ctx.storyId),
      '--gate',
      gate.name,
      '--worktree',
      ctx.cwd,
      '--cwd',
      ctx.evidenceCwd,
      '--',
      run.cmd,
      ...run.args,
    ],
  };
}

/**
 * Close's preflight entries wrapped in `evidence-gate.js` with the argv close
 * executes; a disabled or scoped-out gate deposits nothing.
 */
export function creditedPreflight(ctx) {
  const checks = [];
  for (const gate of closeGates(ctx).filter((g) =>
    ['typecheck', 'lint', 'format'].includes(g.name),
  )) {
    const run = ctx.scopeGate({
      gate,
      spawnCwd: ctx.cwd,
      log: (m) => ctx.progress('preflight', m),
    });
    if (run.skip) continue;
    checks.push({
      key: gate.name,
      ...preflightArgv(ctx, gate, run),
      deposit: { cmd: run.cmd, args: run.args },
      tolerateNoFilesProcessed: run.tolerateNoFilesProcessed,
    });
  }
  return checks;
}

/** Record a passed carryable check's credit, hashed as close hashes it. */
export function recordPreflightCredit(ctx, check) {
  if (!CARRYABLE_GATES.has(check.key)) return;
  ctx.state.preflightCredits[check.key] = {
    head: ctx.head,
    configHash: hashCommandConfig({ ...check.deposit, cwd: ctx.cwd }),
  };
}

/** Re-key one credit onto the seated HEAD; best-effort, like close's rerun. */
export function carryCredit(ctx, gateName, credit) {
  try {
    recordPass(
      {
        storyId: ctx.storyId,
        gateName,
        sha: ctx.head,
        configHash: credit.configHash,
        inputFingerprint: treeFingerprint(ctx.cwd, ctx.git),
      },
      { cwd: ctx.evidenceCwd, standalone: true },
    );
    return { ...credit, head: ctx.head };
  } catch (err) {
    ctx.progress(
      'seat',
      `⚠️ ${gateName} credit not carried: ${err?.message ?? err}`,
    );
    return credit;
  }
}

/** Re-key each credit deposited at `priorHead` onto the seated HEAD. */
export function carryPreflightCredits(ctx, priorHead) {
  const credits = ctx.state.preflightCredits ?? {};
  for (const [gateName, credit] of Object.entries(credits)) {
    if (credit?.head === priorHead) {
      credits[gateName] = carryCredit(ctx, gateName, credit);
    }
  }
}

/**
 * Did the credited run defer coverage to CI at this HEAD?
 *
 * @param {{ head: string, state: { coverageDeferredHead?: string } }} ctx
 * @returns {boolean}
 */
export function isCoverageDeferred(ctx) {
  return Boolean(ctx.head) && ctx.state.coverageDeferredHead === ctx.head;
}

/**
 * Did the depositor — the capture or the `test` run — declare its slice over
 * this host's budget?
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isOverBudgetExit(status) {
  return status === COVERAGE_OVER_BUDGET_EXIT_CODE;
}

/**
 * An over-budget depositor's step result: deferred to CI (no credit, the
 * coverage-reading gates skipped) or `blocked`, by `coverage.onOverBudget`.
 *
 * @param {object} ctx @param {string} name @param {object} extra
 * @returns {object}
 */
export function settleOverBudget(ctx, name, extra) {
  const exit = `exit ${COVERAGE_OVER_BUDGET_EXIT_CODE}`;
  if (overBudgetPolicy(ctx.config) === 'defer-to-ci') {
    deferCoverage(ctx.state, ctx.head, COVERAGE_DEFERRED_REASONS.overBudget);
    return {
      name,
      outcome: 'deferred',
      detail: `coverage deferred to CI (${exit}, onOverBudget: defer-to-ci) — no suite ran and no credit was deposited`,
      ...extra,
    };
  }
  return {
    name,
    outcome: 'failed',
    detail: `${ctx.depositor} over budget (${exit}) under delivery.quality.gates.coverage.onOverBudget: block`,
    reason: OVER_BUDGET_BLOCK_HINT,
    stop: 'blocked',
    ...extra,
  };
}

/** The envelope's `coverage` field, present only after a deferral. */
export function coverageEnvelope(ctx) {
  if (!isCoverageDeferred(ctx)) return {};
  return { coverage: deferralEnvelope(ctx.state.coverageDeferredReason) };
}

/**
 * A real credit ends a deferral; the seat it skipped CRAP on is re-opened,
 * so the captured HEAD still seats its CRAP rows.
 *
 * @param {{ coverageDeferredHead?: string, seatHead?: string }} state
 */
export function clearCoverageDeferral(state) {
  if (state.coverageDeferredHead === undefined) return;
  delete state.coverageDeferredHead;
  delete state.coverageDeferredReason;
  delete state.seatHead;
}

/** A seat commit keeps a deferral its parent HEAD held. */
export function carryCoverageDeferral(state, priorHead, head) {
  if (state.coverageDeferredHead === priorHead) {
    state.coverageDeferredHead = head;
  }
}

/** Post-capture re-scores until the run is credited or deferred at HEAD. */
export function postCaptureSettled(ctx) {
  return ctx.state.creditHead === ctx.head || isCoverageDeferred(ctx);
}

/** Seat kinds that read the coverage artifact, which a deferral never writes. */
const ARTIFACT_SEATS = new Set(['crap', 'coverage']);

/** CRAP and coverage seating need a fresh artifact. */
export function seatableKinds(ctx, kinds) {
  const deferred = isCoverageDeferred(ctx);
  return kinds.filter((kind) => !deferred || !ARTIFACT_SEATS.has(kind));
}

/**
 * `quality-preview-crap` (capture depositor only) and every baselines entry;
 * after a deferral, none that reads the coverage artifact.
 */
function postCaptureGates(ctx) {
  const names = new Set(Object.values(BASELINES_GATE_NAMES));
  if (ctx.depositor === 'coverage-capture') {
    names.add(QUALITY_PREVIEW_GATE_NAMES.crap);
  }
  const keep = postCaptureFilter(names, isCoverageDeferred(ctx));
  return closeGates(ctx).filter(keep);
}

/** A registered, unskipped post-capture gate, minus artifact readers after a deferral. */
function postCaptureFilter(names, deferred) {
  return (g) =>
    names.has(g.name) && !g.skip && !(deferred && g.readsCoverageArtifact);
}

/** The kinds a baselines entry scores; `null` without `--gate` (every kind). */
function gateKinds(gate) {
  const i = gate.args.indexOf('--gate');
  return i === -1 ? null : gate.args[i + 1];
}

/** The gate name, plus the kinds a baselines entry scores. */
function describeGate(gate) {
  const kinds = gateKinds(gate);
  return kinds ? `${gate.name} (kinds: ${kinds})` : gate.name;
}

/** Does a baselines entry score duplication? (No `--gate` scores every kind.) */
function scoresDuplication(gate) {
  if (gate.name === QUALITY_PREVIEW_GATE_NAMES.crap) return false;
  return (gateKinds(gate) ?? 'duplication').includes('duplication');
}

/** A non-zero post-capture exit as the handoff's finding. */
function failure(gate, res) {
  return {
    gate: gate.name,
    finding: `${describeGate(gate)} finding (exit ${res.status}) — fix and commit, then re-run`,
    evidencePath: res.evidencePath,
    scoresDuplication: scoresDuplication(gate),
    baselineRef: gate.env?.BASELINE_REF,
  };
}

/** Run each post-capture gate through `run`; the first non-zero exit is the finding. */
export async function scorePostCapture(ctx, run) {
  const gates = postCaptureGates(ctx);
  for (const gate of gates) {
    const env = gate.env ? { ...ctx.env, ...gate.env } : undefined;
    const res = await run(
      `post-capture-${gate.name}`,
      gate.cmd,
      gate.args,
      env,
    );
    if (res.status !== 0) return { gates, failed: failure(gate, res) };
  }
  return { gates, failed: null };
}
