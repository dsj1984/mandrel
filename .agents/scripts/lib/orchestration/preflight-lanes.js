/**
 * preflight-lanes.js — the handoff preflight's opt-in concurrent path
 * (`delivery.execution.preflightConcurrency` above 1): one unadmitted base
 * lane plus up to N − 1 lanes that run close's independent deposited gates
 * under a zero-wait suite admission. Findings settle in check order.
 */

import { isIndependentGate } from '../close-validation/gates.js';
import {
  ADMISSION_REFUSED_EXIT_CODE,
  isFullSuiteLockEnabled,
  SUITE_RESERVATION_ENV,
} from '../full-suite-lock.js';
import {
  hashCommandConfig,
  recordPass,
  shouldSkip,
  treeFingerprint,
} from '../validation-evidence.js';

const MISS_REASONS = Object.freeze({
  [ADMISSION_REFUSED_EXIT_CODE]: 'admission refused',
});

/**
 * The lane count to run, or `null` for the serial loop. Above 1 but
 * unbounded by admission, one progress line names why it stays serial.
 *
 * @param {object} ctx
 * @returns {number|null}
 */
export function requestedLanes(ctx) {
  const n = ctx.config?.delivery?.execution?.preflightConcurrency ?? 1;
  if (!(n > 1)) return null;
  const why = serialReason(ctx);
  if (!why) return n;
  ctx.progress(
    'preflight',
    `running serially (preflightConcurrency ${n}): ${why}`,
  );
  return null;
}

function serialReason(ctx) {
  if (!isFullSuiteLockEnabled({ config: ctx.config, env: ctx.env })) {
    return 'suite admission is off';
  }
  if (ctx.env?.[SUITE_RESERVATION_ENV]) {
    return 'the handoff already runs inside a suite reservation';
  }
  return null;
}

/** A deposited close gate close itself runs in its independent bucket. */
function isLaneEligible(check) {
  return Boolean(check.deposit) && isIndependentGate(check.key);
}

/**
 * Run `checks` over the base lane and `requested − 1` admitted lanes. No lane
 * aborts a sibling; a check an admitted lane could not admit returns to the
 * queue in check order and that lane retires.
 *
 * @param {object} ctx
 * @param {object[]} checks
 * @param {number} requested
 * @param {(check: object, env?: object) => Promise<object|null>} runCheck
 * @returns {Promise<{ findings: object[], admitted: string[] }>}
 */
export async function runPreflightLanes(ctx, checks, requested, runCheck) {
  const queue = checks.map((check, index) => ({ check, index }));
  const findings = new Array(checks.length).fill(null);
  const admitted = [];
  const take = (eligible) => {
    const at = queue.findIndex(({ check }) => eligible(check));
    return at === -1 ? null : queue.splice(at, 1)[0];
  };
  const any = () => true;
  const baseLane = async () => {
    for (let item = take(any); item; item = take(any)) {
      findings[item.index] = await runCheck(item.check);
    }
  };
  const admittedLane = async () => {
    for (let item = take(isLaneEligible); item; item = take(isLaneEligible)) {
      const out = await admitAndRun(ctx, item.check, runCheck);
      if (out.miss) {
        queue.splice(
          queue.findLastIndex((e) => e.index < item.index) + 1,
          0,
          item,
        );
        ctx.progress(
          'preflight',
          `↩ ${item.check.key} back to the serial lane: ${out.miss}`,
        );
        return;
      }
      admitted.push(item.index);
      findings[item.index] = out.finding;
    }
  };
  // The base lane starts first, so it takes the first check.
  const lanes = [baseLane()];
  for (let i = 1; i < requested; i++) lanes.push(admittedLane());
  await settleAll(lanes);
  // A check handed back after the base lane drained still runs, in order.
  await baseLane();
  checks.forEach((check, i) => {
    if (findings[i] === null && check.deposit && !check.held) {
      reconcileDeposit(ctx, check);
    }
  });
  return {
    findings: findings.filter(Boolean),
    admitted: admitted.sort((a, b) => a - b).map((i) => checks[i].key),
  };
}

/** Every lane settles before the first rejection, if any, is rethrown. */
async function settleAll(lanes) {
  const settled = await Promise.allSettled(lanes);
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * Admit `check` under close's argv with no wait and run it inside the
 * reservation, so a nested admission spawns inside it.
 *
 * @returns {Promise<{ finding: object|null }|{ miss: string }>}
 */
async function admitAndRun(ctx, check, runCheck) {
  const crash = {};
  let out;
  try {
    out = await ctx.admitSuite(
      admissionOptions(ctx, check),
      guardedRun(ctx, check, runCheck, crash),
    );
  } catch (err) {
    // Only an admission-side throw hands the check back; its own throw escapes.
    return admissionMiss(crash, err);
  }
  return typeof out === 'number' ? exitMiss(out) : out;
}

/** Close's argv for `check`, admitted with no wait. */
function admissionOptions(ctx, check) {
  return {
    argv: [check.deposit.cmd, ...check.deposit.args],
    cwd: ctx.cwd,
    env: ctx.env,
    config: ctx.config,
    log: () => {},
    lockOptions: { waitMs: 0 },
  };
}

/** Run `check` inside the reservation, flagging its own throw on `crash`. */
function guardedRun(ctx, check, runCheck, crash) {
  return async ({ env }) => {
    try {
      return { finding: await runCheck(check, { ...ctx.env, ...env }) };
    } catch (err) {
      crash.err = err;
      crash.thrown = true;
      throw err;
    }
  };
}

function admissionMiss(crash, err) {
  if (crash.thrown) throw crash.err;
  return { miss: `admission failed: ${err?.message ?? err}` };
}

function exitMiss(out) {
  return {
    miss: `${MISS_REASONS[out] ?? 'not admitted without a wait'} (exit ${out})`,
  };
}

/**
 * Re-record a passed deposit two overlapping `evidence-gate.js` writes may
 * have lost, hashed as close hashes it; best-effort, like `carryCredit`.
 */
function reconcileDeposit(ctx, check) {
  const configHash = hashCommandConfig({ ...check.deposit, cwd: ctx.cwd });
  const opts = { cwd: ctx.evidenceCwd, standalone: true };
  const key = { storyId: ctx.storyId, gateName: check.key, configHash };
  try {
    if (shouldSkip({ ...key, currentSha: ctx.head }, opts).skip) return;
    recordPass(
      {
        ...key,
        sha: ctx.head,
        inputFingerprint: treeFingerprint(ctx.cwd, ctx.git),
      },
      opts,
    );
  } catch (err) {
    ctx.progress(
      'preflight',
      `⚠️ ${check.key} deposit not re-recorded: ${err?.message ?? err}`,
    );
  }
}
