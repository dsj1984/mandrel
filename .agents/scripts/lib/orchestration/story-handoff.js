/**
 * story-handoff.js — the story-worker's whole post-implementation tail as one
 * deterministic sequence: base merge (starting the held review) → duplication
 * re-score → blocking preflight (lint and format deposited as close's credit,
 * quality-preview, baselined ratchets) → the one credited run, which a halted
 * review skips or aborts → baseline seating → close's post-capture CRAP and
 * baselines scoring → push + remote-ref check → review awaited. It runs exactly what deliver-digest § 5 and deliver-reference
 * define, with close's own gate identities, and settles one envelope:
 *
 * - `ready` (exit 0) — hand off.
 * - `fix-required` (exit 2) — the worker can fix it by editing the branch;
 *   labels untouched.
 * - `blocked` (exit 1) — the worker cannot: a rejected push, an unreachable
 *   remote, an unconfirmed base branch, an unregistered baseline merge
 *   driver or a suite that lost workers to host memory (exit 77). Flips `agent::blocked` and posts a `friction` comment.
 *
 * Idempotent: a re-run skips every step whose result is still valid for the
 * current HEAD, judged by the step's output signal, never its exit code alone.
 * Never runs close, opens a PR or writes any label but `agent::blocked`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnStreamAsync } from '../child-exec.js';
import {
  createLockEventChannel,
  summarizeLockEvents,
} from '../close-lock-events.js';
import { resolveTestGateArgv } from '../close-validation/commands.js';
import {
  isCrapGateEnabled,
  resolveCreditedDepositor,
} from '../close-validation/gates.js';
import { isBiomeNoFilesProcessed } from '../close-validation/process.js';
import { applyChangedFileScope } from '../close-validation/runner.js';
import { skipBranchDeposit } from '../close-validation/skip-branch-test.js';
import { getPostSeatChecks } from '../config/handoff.js';
import { getQuality } from '../config/quality.js';
import {
  orchestrationLogDir,
  storyReviewDepositPath,
} from '../config/temp-paths.js';
import { COVERAGE_HOST_RESOURCES_EXIT_CODE } from '../coverage-capture.js';
import { extractFailureRows } from '../failure-rows.js';
import {
  ADMISSION_REFUSED_EXIT_CODE,
  LOCK_WAIT_EXPIRED_EXIT_CODE,
  withSuiteAdmission,
} from '../full-suite-lock.js';
import { handoffRerunSkip } from '../git/base-sync-probe.js';
import { syncBranchFromBase } from '../git/sync-from-base.js';
import { remoteBranchSha } from '../git-branch-lifecycle.js';
import { getStoryBranch, gitSpawn } from '../git-utils.js';
import { readPackageScripts } from '../npm-scripts.js';
import {
  emitHandoffRecord,
  handoffCause,
  nextHandoffAttempt,
} from '../observability/handoff-telemetry.js';
import {
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../observability/runtime-friction.js';
import { TIMEOUT_EXIT_CODE } from '../process-group.js';
import { PROJECT_ROOT } from '../project-root.js';
import { STANDALONE_RATCHETS } from '../standalone-ratchets.js';
import { describeBlocking } from '../suite-admission.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { defaultSleep } from '../util/sleep.js';
import { hashCommandConfig } from '../validation-evidence.js';
import { runStreamed } from './evidence-stream.js';
import {
  carryCoverageDeferral,
  carryCredit,
  carryPreflightCredits,
  clearCoverageDeferral,
  coverageEnvelope,
  creditedPreflight,
  isCoverageDeferred,
  isOverBudgetExit,
  postCaptureSettled,
  recordPreflightCredit,
  scorePostCapture,
  seatableKinds,
  settleOverBudget,
} from './handoff-gates.js';
import {
  raisedDuplicationSuffix,
  rescoreDuplication,
} from './handoff-rescore.js';
import { handoffStatePath } from './handoff-state.js';
import { settleSuiteOfRecord } from './handoff-suite-of-record.js';
import { requestedLanes, runPreflightLanes } from './preflight-lanes.js';
import { probeHeldReviewDiff } from './review-deposit.js';
import { runDuplicationCloseRescore } from './story-close/duplication-close-rescore.js';
import { createStoryProgress, handoffStepName } from './story-progress.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './ticketing.js';

const SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const HANDOFF_STATUS = Object.freeze({
  READY: 'ready',
  FIX_REQUIRED: 'fix-required',
  BLOCKED: 'blocked',
});

const EXIT_CODES = Object.freeze({
  [HANDOFF_STATUS.READY]: 0,
  [HANDOFF_STATUS.BLOCKED]: 1,
  [HANDOFF_STATUS.FIX_REQUIRED]: 2,
});

/** The § 5 output signals — a depositor that prints none deposited nothing. */
const SIGNALS = Object.freeze({
  captureRan: /Wrote content-digest capture stamp/,
  // A `no changed files … — skipping capture` line ran no suite: not credit.
  captureFresh:
    /\bis fresh(?: \((?:incremental|affected)\))? — skipping capture/,
  testRan: /✓ test passed/,
  testFresh: /⏭ test skipped/,
  seated: /seated:\s*(\d+)/,
  gateFail: /\(gate fail\)/,
  offending: /^[+!] /,
});

const MAX_OFFENDING_LINES = 10;

const LOCK_POLL_MS = 1_000;

const SEAT_SCRIPTS = Object.freeze({
  coverage: 'update-coverage-baseline.js',
  crap: 'update-crap-baseline.js',
  maintainability: 'update-maintainability-baseline.js',
});

/**
 * A settled step. `stop` carries the envelope status that ends the run;
 * `cause` its handoff-telemetry cause.
 *
 * @typedef {{ name: string, outcome: 'ran'|'skipped'|'deferred'|'failed'|'error'|'aborted',
 *   detail: string, evidencePath?: string|null, conflictFiles?: string[],
 *   stop?: 'fix-required'|'blocked', reason?: string, cause?: string,
 *   durationMs?: number|null, skippedByCredit?: boolean }} StepResult
 */

const ran = (name, detail, extra = {}) => ({
  name,
  outcome: 'ran',
  detail,
  ...extra,
});
const skipped = (name, detail, extra = {}) => ({
  name,
  outcome: 'skipped',
  detail,
  ...extra,
});
/** A skip that reuses a result already recorded for this HEAD. */
const creditSkip = (name, detail, extra = {}) =>
  skipped(name, detail, { ...extra, skippedByCredit: true });
const fixRequired = (name, detail, extra = {}) => ({
  name,
  outcome: 'failed',
  detail,
  stop: HANDOFF_STATUS.FIX_REQUIRED,
  ...extra,
});
const blocked = (name, reason, detail, extra = {}) => ({
  name,
  outcome: 'failed',
  detail,
  reason,
  cause: reason,
  stop: HANDOFF_STATUS.BLOCKED,
  ...extra,
});

/**
 * @param {Function} git
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null} trimmed stdout, `null` on a non-zero exit.
 */
function gitLine(git, cwd, args) {
  const res = git(cwd, ...args);
  if (res?.status !== 0) return null;
  return (res.stdout ?? '').toString().trim();
}

/** @param {object} ctx */
function headSha(ctx) {
  return gitLine(ctx.git, ctx.cwd, ['rev-parse', 'HEAD']);
}

/**
 * A child's env with `AP_AGENTRC_CWD` pinned to the Story worktree and
 * `MANDREL_HANDOFF_STEP` naming the running step, layered last so a stale
 * inherited value cannot win: a gate judges the branch by the branch's own
 * `.agentrc.json`, and a consumer check can key on the step.
 *
 * @param {object} ctx
 * @param {Record<string, string|undefined>} [env] defaults to `ctx.env`.
 * @returns {Record<string, string|undefined>}
 */
function worktreeEnv(ctx, env) {
  return {
    ...(env ?? ctx.env),
    AP_AGENTRC_CWD: ctx.cwd,
    MANDREL_HANDOFF_STEP: ctx.stepName,
  };
}

/**
 * Run one child with its combined output streamed live into the step's
 * evidence log (announced, and recorded in story-progress, before it spawns).
 *
 * @param {object} ctx
 * @param {string} logName
 * @param {string} cmd
 * @param {string[]} args
 * @param {Record<string, string|undefined>} [env] the child's whole env.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ status: number, output: string, evidencePath: string }>}
 */
async function runLogged(ctx, logName, cmd, args, env, signal) {
  ctx.progress(logName, `${cmd} ${args.join(' ')}`);
  const file = ctx.evidencePathFor(logName);
  ctx.storyProgress.evidence(file);
  return runStreamed({
    ...ctx.stream,
    runCommand: ctx.runCommand,
    progress: ctx.progress,
    cmd,
    args,
    opts: { cwd: ctx.cwd, env: worktreeEnv(ctx, env) },
    file,
    tag: logName,
    signal,
  });
}

const LOCK_PHASE_TEXT = Object.freeze({
  waiting: 'waiting for the full-suite lock',
  'still-waiting': 'still waiting for the full-suite lock',
  admitted: 'admitted — suite running',
  // Older children report `acquired`, the same state as `admitted`.
  acquired: 'acquired the full-suite lock',
  completed: 'suite completed',
  expired: 'gave up waiting for the full-suite lock',
});

/** @param {import('../full-suite-queue.js').LockProgress} event */
function describeLockProgress(event) {
  const head = LOCK_PHASE_TEXT[event.phase] ?? `lock ${event.phase}`;
  if (event.phase === 'completed') return `${head} (${durations(event)})`;
  const parts = [
    `waited ${event.waitedSeconds}s of a ${event.waitBudgetSeconds}s budget`,
  ];
  if (event.blocking)
    parts.push(`blocked: ${describeBlocking(event.blocking)}`);
  const { holder, queueAhead } = event;
  if (holder) {
    parts.push(
      `holder ${holder.ownerId ?? 'unknown'}, pid ${holder.pid ?? 'unknown'}, lock age ${holder.ageSeconds ?? 'unknown'}s`,
    );
  }
  if (Number.isInteger(queueAhead)) parts.push(`${queueAhead} ahead in queue`);
  return `${head} (${parts.join('; ')})`;
}

function durations({ waitMs, executionMs }) {
  const seconds = (ms) => `${Math.round((ms ?? 0) / 1000)}s`;
  return `waited ${seconds(waitMs)}, ran ${seconds(executionMs)}`;
}

/**
 * Tail a fresh lock-event channel while `run(env)` runs, forwarding each
 * `lock-progress` event once; never the child's output, which can be forged.
 * `timings` summarizes every event drained (the lock wait and suite spawns).
 *
 * @returns {Promise<{ result: any, timings: ReturnType<typeof summarizeLockEvents> }>}
 */
async function withLockProgress(ctx, run) {
  const channel = ctx.createLockChannel();
  const events = [];
  const forward = () => {
    for (const event of channel.drain()) {
      events.push(event);
      if (event.kind === 'lock-progress') {
        ctx.progress('LOCK', describeLockProgress(event));
      }
    }
  };
  let running = true;
  // Not awaited: the final drain below forwards anything it would have.
  (async () => {
    while (running) {
      await ctx.sleep(ctx.lockPollMs);
      if (running) forward();
    }
  })().catch(() => {});
  let result;
  try {
    result = await run({ ...ctx.env, ...channel.env });
  } finally {
    running = false;
    forward();
    channel.dispose();
  }
  return { result, timings: summarizeLockEvents(events) };
}

const SUITE_FAILURE_CAUSES = Object.freeze({
  [LOCK_WAIT_EXPIRED_EXIT_CODE]: 'lock-wait-expired',
  [ADMISSION_REFUSED_EXIT_CODE]: 'host-admission',
  [TIMEOUT_EXIT_CODE]: 'suite-timeout',
});

/**
 * The suite exit codes § 5 distinguishes from a red run.
 *
 * @param {number} status
 * @returns {string}
 */
function describeSuiteFailure(status) {
  if (status === LOCK_WAIT_EXPIRED_EXIT_CODE) {
    return `suite deferred (exit ${status}): another full suite holds the host lock — re-run the handoff once it frees`;
  }
  if (status === ADMISSION_REFUSED_EXIT_CODE) {
    return `suite refused (exit ${status}): its declared delivery.execution.workloads weight exceeds capacity — fix the declaration, then re-run`;
  }
  if (status === TIMEOUT_EXIT_CODE) {
    return `suite timed out (exit ${status}) — usually host contention; re-run the handoff`;
  }
  return `red suite (exit ${status}) — fix the failing tests, commit, re-run`;
}

/**
 * Typecheck, lint and format (deposited), quality-preview, then each ratchet whose
 * baseline is committed.
 *
 * @param {object} ctx
 * @returns {Array<{ key: string, cmd: string, args: string[], gated?: boolean, deposit?: object }>}
 */
function preflightChecks(ctx) {
  const covered = new Set(getQuality(ctx.config).ratchets.coveredByLint);
  const ratchets = STANDALONE_RATCHETS.filter((r) =>
    fs.existsSync(path.join(ctx.cwd, r.baseline)),
  ).map((r) => ({
    key: r.key,
    cmd: 'node',
    args: [path.join(SCRIPTS_DIR, r.script), ...r.args],
    gated: true,
    coveredByLint: covered.has(r.key),
  }));
  return [
    ...creditedPreflight(ctx),
    {
      key: 'quality-preview',
      cmd: 'node',
      args: [
        path.join(SCRIPTS_DIR, 'quality-preview.js'),
        '--changed-since',
        `origin/${ctx.baseBranch}`,
      ],
    },
    ...ratchets,
  ];
}

/**
 * A ratchet also fails on `(gate fail)`; its finding names the `+`/`!` rows.
 * Any other check quotes the failure rows its output carries.
 *
 * @param {{ key: string, gated?: boolean }} check
 * @param {{ status: number, output: string }} run
 * @returns {string|null} the finding, `null` when the check passed.
 */
function preflightFinding(check, run) {
  const gateFailed = check.gated === true && SIGNALS.gateFail.test(run.output);
  if (run.status === 0 && !gateFailed) return null;
  // Close downgrades biome's all-paths-ignored exit the same way.
  if (check.tolerateNoFilesProcessed && isBiomeNoFilesProcessed(run.output)) {
    return null;
  }
  const offending = check.gated
    ? run.output
        .split(/\r?\n/)
        .filter((line) => SIGNALS.offending.test(line))
        .slice(0, MAX_OFFENDING_LINES)
    : extractFailureRows(run.output, { max: MAX_OFFENDING_LINES });
  const rows = offending.length > 0 ? `: ${offending.join('; ')}` : '';
  return `${check.key}${check.gated ? ' ratchet' : ''} finding${rows} — fix and commit, then re-run`;
}

/**
 * Runs every check — serially, or over admitted lanes when
 * `preflightConcurrency` asks (preflight-lanes.js) — then settles one
 * `fix-required` listing each finding in check order; a passed carryable
 * check keeps its credit either way.
 *
 * @param {object} ctx @returns {Promise<StepResult>}
 */
async function stepPreflight(ctx) {
  const name = 'preflight';
  if (ctx.state.preflightHead === ctx.head) {
    return creditSkip(
      name,
      `preflight already passed at ${ctx.head.slice(0, 12)}`,
    );
  }
  ctx.state.preflightCredits = {};
  delete ctx.state.heldLint;
  let checks;
  try {
    checks = preflightChecks(ctx);
  } catch (err) {
    return fixRequired(
      name,
      `could not resolve close's typecheck/lint/format gates: ${err?.message ?? err}`,
      { cause: 'preflight-unresolved' },
    );
  }
  let findings = [];
  const pass = { checks, lint: null, covered: [] };
  const lanes = requestedLanes(ctx);
  let extra = {};
  if (lanes) {
    const run = await runPreflightLanes(ctx, checks, lanes, (check, env) =>
      runPreflightCheck(ctx, check, pass, env),
    );
    findings = run.findings;
    extra = { concurrency: { requested: lanes, admitted: run.admitted } };
  } else {
    for (const check of checks) {
      const finding = await runPreflightCheck(ctx, check, pass);
      if (finding) findings.push(finding);
    }
  }
  if (findings.length > 0) {
    const { check, evidencePath } = findings[0];
    return fixRequired(name, findings.map((f) => f.detail).join('\n'), {
      evidencePath,
      findings,
      check,
      cause: preflightCause(check),
      ...extra,
    });
  }
  ctx.state.preflightHead = ctx.head;
  return ran(name, preflightSummary(pass), extra);
}

/** A baselined ratchet's finding is a `ratchet`; any other check is its own key. */
function preflightCause(key) {
  return STANDALONE_RATCHETS.some((r) => r.key === key) ? 'ratchet' : key;
}

/**
 * Runs one check unless this pass's lint covers it; records the lint result
 * and credits a passed check.
 *
 * @returns {Promise<{ check: string, detail: string, evidencePath?: string }|null>}
 */
async function runPreflightCheck(ctx, check, pass, env) {
  const cover = lintCovers(check, pass);
  if (cover === 'covered') {
    pass.covered.push(check.key);
    ctx.progress(
      'preflight',
      `⏭ ${check.key} covered by lint (delivery.quality.ratchets.coveredByLint)`,
    );
  }
  if (cover) return null;
  const run = await runLogged(
    ctx,
    `preflight-${check.key}`,
    check.cmd,
    check.args,
    env,
  );
  const detail = preflightFinding(check, run);
  if (check.key === 'lint') pass.lint = detail ? 'failed' : 'passed';
  if (!detail) {
    creditCheck(ctx, check);
    return null;
  }
  return { check: check.key, detail, evidencePath: run.evidencePath };
}

/**
 * Why a covered ratchet does not spawn: `covered` once this pass's whole-tree
 * lint exited 0, `lint-failed` once it failed (its finding stands). Anything
 * else — no such lint, or not yet reached — runs the ratchet.
 *
 * @param {{ key: string, coveredByLint?: boolean }} check
 * @param {{ checks: Array<{ key: string, wholeTree?: boolean }>, lint: 'passed'|'failed'|null }} pass
 * @returns {'covered'|'lint-failed'|null}
 */
function lintCovers(check, { checks, lint }) {
  if (!check.coveredByLint || lint === null) return null;
  if (!checks.some((c) => c.key === 'lint' && c.wholeTree)) return null;
  return lint === 'passed' ? 'covered' : 'lint-failed';
}

/** The clean checks, then the ratchets lint covered, named apart. */
function preflightSummary({ checks, covered }) {
  const clean = checks.map((c) => c.key).filter((k) => !covered.includes(k));
  const note =
    covered.length > 0 ? `; covered by lint: ${covered.join(', ')}` : '';
  return `${clean.join(', ')} clean${note}`;
}

/** A held `lint` waits for the post-seat checks; any other check credits now. */
function creditCheck(ctx, check) {
  if (!check.held) return recordPreflightCredit(ctx, check);
  ctx.state.heldLint = {
    head: ctx.head,
    configHash: hashCommandConfig({ ...check.deposit, cwd: ctx.cwd }),
  };
}

/** A baselines-only seat commit re-keys a held `lint`; any other commit drops it. */
function carryHeldLint(state, priorHead, head) {
  if (state.heldLint?.head === priorHead) state.heldLint.head = head;
}

/** Record a held `lint` once every post-seat check passed at HEAD. */
function releaseHeldLint(ctx) {
  const held = ctx.state.heldLint;
  if (held?.head !== ctx.head) return;
  ctx.state.preflightCredits.lint = carryCredit(ctx, 'lint', held);
  delete ctx.state.heldLint;
}

/** A baseline-only conflict the shared sync resolved is named. */
function mergedDetail(sync, baseBranch) {
  const resolved = sync.resolvedBaselineFiles ?? [];
  const suffix =
    resolved.length > 0
      ? `; baseline-only conflict resolved to the base: ${resolved.join(', ')}`
      : '';
  return `${sync.kind} from origin/${baseBranch}${suffix}`;
}

/** @param {object} ctx @returns {Promise<StepResult>} */
async function stepBaseMerge(ctx) {
  const name = 'base-merge';
  const skip = await handoffRerunSkip(ctx);
  if (skip) {
    startReview(ctx);
    return skipped(name, skip);
  }
  const sync = await ctx.syncFromBase({
    cwd: ctx.cwd,
    baseBranch: ctx.baseBranch,
    log: ctx.progress,
  });
  if (sync.synced) {
    ctx.state.baseMergeSettled = true;
    ctx.head = headSha(ctx) ?? ctx.head;
    startReview(ctx);
    return sync.kind === 'noop-already-current'
      ? skipped(name, `origin/${ctx.baseBranch} already merged`)
      : ran(name, mergedDetail(sync, ctx.baseBranch));
  }
  if (sync.kind === 'merge-driver-missing') {
    return blocked(name, 'merge-driver-unregistered', sync.stderr);
  }
  if (sync.kind === 'fetch-failed') {
    return blocked(
      name,
      'base-branch-unconfirmed',
      `could not fetch origin/${ctx.baseBranch}: ${sync.stderr}`.trim(),
    );
  }
  if (sync.kind === 'conflict') {
    return fixRequired(
      name,
      `merging origin/${ctx.baseBranch} conflicts; the merge was aborted, so the tree is clean — merge it yourself, resolve, commit, re-run`,
      { conflictFiles: sync.conflictFiles, cause: 'base-merge-conflict' },
    );
  }
  return fixRequired(name, `merge failed: ${sync.stderr}`.trim(), {
    cause: 'base-merge-failed',
  });
}

/**
 * The depositor close will credit, from the one shared predicate.
 *
 * @param {{ config: object, scripts: Record<string, string>|null, cwd: string, getChangedFilesImpl?: Function }} args
 * @returns {{ depositor: 'coverage-capture'|'test', skipBranch: boolean }}
 */
function selectCreditedDepositor({ config, ...probe }) {
  const baseBranch = config?.project?.baseBranch ?? 'main';
  return resolveCreditedDepositor({ config, baseBranch, ...probe });
}

/**
 * The `test` deposit's evidence-gate argv tail and step label: on the skip
 * branch the scoped run (or the full suite, naming why), else close's argv.
 */
function testDeposit(ctx) {
  if (!ctx.skipBranch) {
    const { cmd, args } = resolveTestGateArgv(ctx.config);
    return { argv: ['--', cmd, ...args], label: ctx.depositor };
  }
  const deposit = skipBranchDeposit({
    config: ctx.config,
    cwd: ctx.cwd,
    baseBranch: ctx.baseBranch,
    gitSpawnImpl: ctx.git,
  });
  if (deposit.fallback)
    ctx.progress('credited-run', `full suite: ${deposit.fallback}`);
  return deposit;
}

/** The depositor's node argv and its step label. */
function depositorArgv(ctx) {
  if (ctx.depositor === 'coverage-capture') {
    const script = path.join(SCRIPTS_DIR, 'coverage-capture.js');
    return { args: [script, '--cwd', ctx.cwd], label: ctx.depositor };
  }
  const deposit = testDeposit(ctx);
  const args = [
    path.join(SCRIPTS_DIR, 'evidence-gate.js'),
    '--standalone',
    '--scope-id',
    String(ctx.storyId),
    '--gate',
    'test',
    '--worktree',
    ctx.cwd,
    // Credited under close's `test` identity, whichever argv runs.
    ...deposit.argv,
  ];
  return { args, label: deposit.label };
}

/** @param {object} ctx @param {AbortSignal} signal @returns {Promise<StepResult>} */
async function creditedRun(ctx, signal) {
  const name = 'credited-run';
  if (ctx.state.creditHead === ctx.head) {
    return creditSkip(
      name,
      `${ctx.depositor} credit already deposited at ${ctx.head.slice(0, 12)}`,
      { depositor: ctx.depositor },
    );
  }
  const ciOwned = settleSuiteOfRecord(ctx, name);
  if (ciOwned) return ciOwned;
  const capture = ctx.depositor === 'coverage-capture';
  const { args, label } = depositorArgv(ctx);
  const { result: run, timings } = await withLockProgress(ctx, (env) =>
    runLogged(ctx, 'credited-run', 'node', args, env, signal),
  );
  const { lockWait, suiteTimings, spawns } = timings;
  const extra = {
    evidencePath: run.evidencePath,
    depositor: ctx.depositor,
    lockWait,
    suiteTimings,
  };
  if (signal.aborted) {
    return {
      name,
      outcome: 'aborted',
      detail: 'aborted: the held review found a CRITICAL mid-run; no credit',
      ...extra,
    };
  }
  if (run.status !== 0) return settleSuiteExit(ctx, name, run, extra);
  const [ranSignal, freshSignal] = capture
    ? [SIGNALS.captureRan, SIGNALS.captureFresh]
    : [SIGNALS.testRan, SIGNALS.testFresh];
  const credit = { head: ctx.head, lockWait, suiteTimings, spawns };
  if (ranSignal.test(run.output)) {
    recordCredit(ctx, credit);
    return ran(name, `${label} deposited credit`, extra);
  }
  if (freshSignal.test(run.output)) {
    recordCredit(ctx, credit);
    return creditSkip(name, `${label} credit already fresh`, extra);
  }
  return fixRequired(
    name,
    `${ctx.depositor} exited 0 but printed no credit signal, so it deposited nothing`,
    { ...extra, cause: 'no-credit-signal' },
  );
}

const HOST_COUNT_KEYS = Object.freeze([
  'testsPassed',
  'testsFailed',
  'workersLost',
  'peakWorkerRssMb',
]);

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** One output line's `hostResources` object, else `null`; never throws. */
function hostResourcesFromLine(line) {
  try {
    const parsed = JSON.parse(line);
    return isPlainObject(parsed) && isPlainObject(parsed.hostResources)
      ? parsed.hostResources
      : null;
  } catch {
    return null;
  }
}

/**
 * The consumer's optional counts: the last output line that parses as a JSON
 * object with an object-valued `hostResources` key.
 *
 * @param {string} output
 * @returns {object|null}
 */
function parseHostResources(output) {
  const lines = String(output ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    const found = hostResourcesFromLine(line);
    if (found) return found;
  }
  return null;
}

/** @param {object|null} counts */
function countsSuffix(counts) {
  const parts = HOST_COUNT_KEYS.filter((k) => Number.isFinite(counts?.[k])).map(
    (k) => `${k}: ${counts[k]}`,
  );
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * A credited run that lost workers to host memory (exit 77): `blocked`, no
 * credit, one `host-resources` friction record. `ctx.hostResources` carries
 * the consumer's counts to the envelope.
 *
 * @param {object} ctx @param {string} name @param {string} output @param {object} extra
 * @returns {Promise<object>}
 */
async function settleHostResources(ctx, name, output, extra) {
  const counts = parseHostResources(output);
  if (counts) ctx.hostResources = counts;
  try {
    await ctx.emitFriction({
      storyId: ctx.storyId,
      category: RUNTIME_FRICTION_CATEGORIES.HOST_RESOURCES,
      tool: 'story-handoff',
      details: {
        exitCode: COVERAGE_HOST_RESOURCES_EXIT_CODE,
        depositor: ctx.depositor,
        head: ctx.head?.slice(0, 12) ?? null,
        ...(counts ? { hostResources: counts } : {}),
      },
      config: ctx.config,
    });
  } catch {
    // Telemetry never changes the envelope.
  }
  return {
    name,
    outcome: 'failed',
    detail: `suite lost workers to host memory (exit ${COVERAGE_HOST_RESOURCES_EXIT_CODE})${countsSuffix(counts)} — no test failed, so do not re-run it unchanged on this host: use fewer workers, a larger host, or, when CI runs the suite with a coverage floor, have the capture script declare the slice over budget (exit 76) under delivery.quality.gates.coverage.onOverBudget: "defer-to-ci"`,
    reason: 'host-resources',
    stop: 'blocked',
    ...extra,
  };
}

/** The envelope's `hostResources` field, present only when the consumer reported counts. */
function hostResourcesEnvelope(ctx) {
  return ctx.hostResources ? { hostResources: ctx.hostResources } : {};
}

/** A non-zero depositor exit: lost workers block, else {@link settleCodeExit}. */
function settleSuiteExit(ctx, name, { status, output }, extra) {
  return status === COVERAGE_HOST_RESOURCES_EXIT_CODE
    ? settleHostResources(ctx, name, output, extra)
    : settleCodeExit(ctx, name, status, extra);
}

/** An over-budget depositor settles by policy, anything else is a fix. */
function settleCodeExit(ctx, name, status, extra) {
  return isOverBudgetExit(status)
    ? settleOverBudget(ctx, name, extra)
    : fixRequired(name, suiteFailureDetail(ctx, status), {
        ...extra,
        cause: SUITE_FAILURE_CAUSES[status] ?? 'red-suite',
      });
}

/** A 124 records its HEAD, so a second one there stops recommending a re-run. */
function suiteFailureDetail(ctx, status) {
  if (status !== TIMEOUT_EXIT_CODE) return describeSuiteFailure(status);
  const repeated = ctx.state.timeoutHead === ctx.head;
  ctx.state.timeoutHead = ctx.head;
  return repeated
    ? `suite timed out again at this HEAD (exit ${status}) — a plain re-run will not help: raise delivery.quality.gates.coverage.timeoutMs, have the capture script declare the slice over budget (exit 76, onOverBudget), or run on a quieter host`
    : describeSuiteFailure(status);
}

/** Credit and its run's figures move together, keyed by the credited head. */
function recordCredit(ctx, creditTimings) {
  ctx.state.creditHead = creditTimings.head;
  ctx.state.creditTimings = creditTimings;
  clearCoverageDeferral(ctx.state);
}

/**
 * @param {Function} git
 * @param {string} cwd
 * @returns {string[]} paths `git status` reports changed.
 */
function changedPaths(git, cwd) {
  const res = git(cwd, 'status', '--porcelain');
  if (res?.status !== 0) return [];
  // The runner trims stdout, so the first ` M path` line may arrive as
  // `M path`: strip the status code by shape, never by a fixed width.
  return (res.stdout ?? '')
    .toString()
    .split(/\r?\n/)
    .map((line) => line.replace(PORCELAIN_STATUS, '').trim())
    .filter((p) => p.length > 0);
}

/**
 * @param {object} ctx
 * @param {{ total: number, evidencePath: string|null }} seated
 * @param {{ name: string, headKey: string }} step whose idempotency key it sets.
 * @returns {Promise<StepResult>}
 */
async function commitSeatedRows(
  ctx,
  { total, evidencePath },
  { name, headKey },
) {
  const paths = changedPaths(ctx.git, ctx.cwd);
  const add = ctx.git(ctx.cwd, 'add', '--', ...paths);
  const commit =
    add?.status === 0
      ? ctx.git(
          ctx.cwd,
          'commit',
          '-m',
          `chore(baselines): baseline-refresh: seat rows for new methods (refs #${ctx.storyId})`,
        )
      : add;
  if (commit?.status !== 0) {
    const detail = `${commit?.stderr ?? ''}${commit?.stdout ?? ''}`.trim();
    return fixRequired(
      name,
      `committing the seated rows failed: ${detail}`.trim(),
      {
        evidencePath: ctx.writeEvidence('seat-commit', detail),
        cause: 'seat-commit-failed',
      },
    );
  }
  const priorHead = ctx.head;
  const creditedPrior = ctx.state.creditHead === priorHead;
  ctx.head = headSha(ctx) ?? ctx.head;
  carryCoverageDeferral(ctx.state, priorHead, ctx.head);
  ctx.state[headKey] = ctx.head;
  // Both capture-stamp digests leave `baselines/` out, so a baseline-JSON-only
  // commit keeps the credit it already holds.
  if (creditedPrior && ctx.depositor === 'coverage-capture') {
    recordCredit(ctx, { ...ctx.state.creditTimings, head: ctx.head });
  }
  if (paths.every((p) => p.startsWith('baselines/'))) {
    carryPreflightCredits(ctx, priorHead);
    carryHeldLint(ctx.state, priorHead, ctx.head);
  }
  return ran(name, `seated ${total} row(s) and committed them`, {
    evidencePath,
  });
}

/** A coverage gate block that is present and not disabled, as close reads it. */
function isCoverageGateEnabled(config) {
  const block = config?.delivery?.quality?.gates?.coverage;
  return Boolean(block) && typeof block === 'object' && block.enabled !== false;
}

/**
 * The post-capture seat's kinds: CRAP by close's own predicate, coverage
 * when the capture deposits the artifact and its gate is enabled.
 *
 * @param {object} ctx
 * @returns {Array<keyof typeof SEAT_SCRIPTS>}
 */
function seatKinds(ctx) {
  return [
    ...(isCrapGateEnabled(ctx.config) ? ['crap'] : []),
    ...(seatsCoverage(ctx) ? ['coverage'] : []),
  ];
}

/** The capture deposits the artifact the coverage seat reads. */
function seatsCoverage(ctx) {
  return (
    ctx.depositor === 'coverage-capture' && isCoverageGateEnabled(ctx.config)
  );
}

/** Static MI needs no capture, so its seat runs before preflight. */
function staticSeatKinds(config) {
  const mi = config?.delivery?.quality?.gates?.maintainability?.enabled;
  return mi === false ? [] : ['maintainability'];
}

/** Seat `kinds` and commit any rows under `step.name`, keyed by `step.headKey`. */
async function seatAndCommit(ctx, kinds, step) {
  if (ctx.state[step.headKey] === ctx.head) {
    return creditSkip(step.name, `nothing to seat at ${ctx.head.slice(0, 12)}`);
  }
  const seated = await runSeats(ctx, step.name, kinds);
  if (seated.stop) return seated;
  if (seated.total === 0) {
    ctx.state[step.headKey] = ctx.head;
    return skipped(step.name, 'seated: 0 — nothing to seat', {
      evidencePath: seated.evidencePath,
    });
  }
  return commitSeatedRows(ctx, seated, step);
}

/** @param {object} ctx @returns {Promise<StepResult>} */
function stepSeatStatic(ctx) {
  return seatAndCommit(ctx, staticSeatKinds(ctx.config), {
    name: 'seat-static',
    headKey: 'staticSeatHead',
  });
}

/** @param {object} ctx @returns {Promise<StepResult>} */
function stepSeat(ctx) {
  return seatAndCommit(ctx, seatableKinds(ctx, seatKinds(ctx)), {
    name: 'seat',
    headKey: 'seatHead',
  });
}

/**
 * Each kind's `--seat-missing` pass; a refusal or a missing `seated: N` stops.
 *
 * @returns {Promise<StepResult|{ total: number, evidencePath: string|null }>}
 */
async function runSeats(ctx, name, kinds) {
  let total = 0;
  let evidencePath = null;
  for (const kind of kinds) {
    const run = await runLogged(ctx, `seat-${kind}`, 'node', [
      path.join(SCRIPTS_DIR, SEAT_SCRIPTS[kind]),
      '--seat-missing',
    ]);
    evidencePath = run.evidencePath;
    const match = SIGNALS.seated.exec(run.output);
    if (run.status !== 0 || !match) {
      return fixRequired(
        name,
        `${kind} --seat-missing ${run.status !== 0 ? `refused (exit ${run.status})` : 'printed no `seated: N`'} — read the log for the fix`,
        { evidencePath: run.evidencePath, cause: 'seat-refused' },
      );
    }
    total += Number(match[1]);
  }
  return { total, evidencePath };
}

const PORCELAIN_STATUS = /^\s*[ MADRCUT?!]{1,2}\s/;

// GitHub's ruleset engine failing mid-evaluation; it prints a `[remote
// rejected]` line too, so it must match first.
const RULESET_EVAL_FAILED = /fatal error in commit_refs_rules/i;
const REMOTE_REJECTED =
  /\[remote rejected\]|permission to \S+ denied|returned error: 403/i;
const REF_BEHIND = /\[rejected\].*\((non-fast-forward|fetch first)\)/;
const REMOTE_UNREACHABLE =
  /could not resolve host|unable to access|could not read from remote|connection (refused|timed out|reset)|network is unreachable/i;
const PUSH_FAILURES = [
  [RULESET_EVAL_FAILED, 'ruleset-eval-failed'],
  [REMOTE_REJECTED, 'push-rejected'],
  [REMOTE_UNREACHABLE, 'remote-unreachable'],
  [REF_BEHIND, 'ref-behind'],
];
// shortcut: a fixed stride (every 3-4 first-parent commits passed in the
// field); make it configurable only if a consumer needs a different one.
const PUSH_STRIDE = 3;

/**
 * A push the remote refused or could not be reached is blocked; a branch
 * behind its remote, a ruleset-evaluation failure or a failing `pre-push`
 * hook is the worker's to fix.
 *
 * @param {string} output
 * @returns {'ruleset-eval-failed'|'push-rejected'|'remote-unreachable'|'ref-behind'|null}
 */
function classifyPushFailure(output) {
  for (const [pattern, reason] of PUSH_FAILURES) {
    if (pattern.test(output)) return reason;
  }
  return null;
}

/** @param {object} ctx @param {object} evidence @returns {StepResult} */
function refBehind(ctx, evidence) {
  return fixRequired(
    'push',
    `origin/${ctx.branch} has commits HEAD lacks — git fetch origin ${ctx.branch}, git merge origin/${ctx.branch}, re-run`,
    { ...evidence, cause: 'ref-behind' },
  );
}

/** @param {object} ctx @param {string} sha */
const refPush = (ctx, sha) => [
  'push',
  'origin',
  `${sha}:refs/heads/${ctx.branch}`,
];

/** @param {object} ctx @param {string[]} range @param {object} evidence */
function rulesetFailure(ctx, range, evidence) {
  const shas = range.length > 0 ? range : ['<sha>'];
  const recipe = shas.map((sha) => `git ${refPush(ctx, sha).join(' ')}`);
  return fixRequired(
    'push',
    `GitHub ruleset evaluation failed (commit_refs_rules) even when stepped — push each first-parent commit oldest first: ${recipe.join('; ')}; then re-run`,
    { ...evidence, reason: 'ruleset-eval-failed' },
  );
}

/**
 * Every PUSH_STRIDE-th commit of the range before HEAD (each one in a short
 * range).
 *
 * @param {string[]} range
 * @returns {string[]}
 */
function stepTargets(range) {
  const last = range.length - 1;
  return range.filter(
    (_, i) => i < last && (last < PUSH_STRIDE || (i + 1) % PUSH_STRIDE === 0),
  );
}

const FIXABLE_PUSH = Object.freeze({
  'ref-behind': (ctx, evidence) => refBehind(ctx, evidence),
  'ruleset-eval-failed': (ctx, ev, range) => rulesetFailure(ctx, range, ev),
});

/**
 * @param {object} ctx
 * @param {{ output: string, evidencePath: string|null }} push
 * @param {string[]} [range] first-parent commits, oldest first.
 * @returns {StepResult}
 */
function pushFailure(ctx, push, range = []) {
  const reason = classifyPushFailure(push.output);
  const evidence = { evidencePath: push.evidencePath };
  const fixable = FIXABLE_PUSH[reason];
  if (fixable) return fixable(ctx, evidence, range);
  return reason
    ? blocked('push', reason, `git push failed (${reason})`, evidence)
    : fixRequired(
        'push',
        'git push failed locally (a pre-push hook?) — fix the cause with a NEW commit, re-run',
        { ...evidence, cause: 'push-hook' },
      );
}

/**
 * HEAD's first-parent commits, oldest first, on neither the base nor the
 * remote Story branch tip.
 *
 * @param {object} ctx
 * @param {string|null} tip
 * @returns {string[]}
 */
function firstParentRange(ctx, tip) {
  const res = ctx.git(
    ctx.cwd,
    'rev-list',
    '--first-parent',
    '--reverse',
    'HEAD',
    `^origin/${ctx.baseBranch}`,
    ...(tip ? [`^${tip}`] : []),
  );
  if (res?.status !== 0) return [];
  return `${res.stdout ?? ''}`.split(/\s+/).filter(Boolean);
}

/**
 * Retry a ruleset-evaluation failure as a stepped push: the step targets,
 * then the branch itself.
 *
 * @param {object} ctx
 * @param {string|null} tip the remote Story branch sha before the push.
 * @param {{ evidencePath: string|null }} first the failed first push.
 * @returns {Promise<{ failure: StepResult }|{ evidencePath: string, how: string }>}
 */
async function steppedPush(ctx, tip, first) {
  if (
    tip &&
    ctx.git(ctx.cwd, 'merge-base', '--is-ancestor', tip, 'HEAD')?.status !== 0
  ) {
    return { failure: refBehind(ctx, { evidencePath: first.evidencePath }) };
  }
  const range = firstParentRange(ctx, tip);
  const pushes = [
    ...stepTargets(range).map((sha) => refPush(ctx, sha)),
    ['push', '-u', 'origin', ctx.branch],
  ];
  let push;
  for (const [i, args] of pushes.entries()) {
    push = await runLogged(ctx, `push-step-${i + 1}`, 'git', args);
    if (push.status !== 0) return { failure: pushFailure(ctx, push, range) };
  }
  return {
    evidencePath: push.evidencePath,
    how: ` in a stepped push of ${pushes.length} step(s) after a ruleset-evaluation failure`,
  };
}

/** The branch push, retried stepped on a ruleset-evaluation failure. */
async function pushOrStep(ctx, tip) {
  const args = ['push', '-u', 'origin', ctx.branch];
  const push = await runLogged(ctx, 'push', 'git', args);
  if (push.status === 0) return { evidencePath: push.evidencePath, how: '' };
  if (classifyPushFailure(push.output) !== 'ruleset-eval-failed') {
    return { failure: pushFailure(ctx, push) };
  }
  return steppedPush(ctx, tip, push);
}

/** @param {object} ctx @returns {Promise<StepResult>} */
async function stepPush(ctx) {
  const name = 'push';
  const before = remoteBranchSha(ctx.cwd, ctx.branch, ctx.git);
  if (!before.reachable) {
    return blocked(name, 'remote-unreachable', before.detail);
  }
  if (before.sha === ctx.head) {
    return skipped(name, `origin/${ctx.branch} already at HEAD`);
  }
  const push = await pushOrStep(ctx, before.sha);
  if (push.failure) return push.failure;
  const after = remoteBranchSha(ctx.cwd, ctx.branch, ctx.git);
  if (after.sha !== ctx.head) {
    return blocked(
      name,
      'push-unconfirmed',
      `origin/${ctx.branch} reads ${after.sha ?? 'nothing'} after the push, not HEAD ${ctx.head}`,
      { evidencePath: push.evidencePath },
    );
  }
  const detail = `pushed ${ctx.branch} → ${ctx.head.slice(0, 12)}${push.how}`;
  return ran(name, detail, { evidencePath: push.evidencePath });
}

/**
 * @param {object} deposit
 * @param {string|null} depositPath
 * @param {StepResult} settled
 * @returns {StepResult}
 */
function reviewVerdict(deposit, depositPath, settled) {
  if (deposit?.halted) return haltedReview(deposit, depositPath);
  return settled;
}

/** No code change resolves a missing verdict, so that halt is blocked. */
function haltedReview(deposit, depositPath) {
  if (deposit.haltCause === 'no-verdict') {
    return blocked('review', 'review-no-verdict', deposit.blockerReason, {
      evidencePath: depositPath,
    });
  }
  return fixRequired(
    'review',
    'held review found a CRITICAL — fix, commit, re-run the handoff',
    { evidencePath: depositPath, cause: 'review-critical' },
  );
}

/** @param {object} ctx @returns {Promise<StepResult>} */
async function computeHeldReview(ctx) {
  const name = 'review';
  const held = ctx.probeReview({
    cwd: ctx.cwd,
    storyId: ctx.storyId,
    sha: ctx.head,
    baseBranch: ctx.baseBranch,
    gitSpawnFn: ctx.git,
    config: ctx.config,
  });
  if (held?.deposit) {
    ctx.review = held.deposit.severity ?? null;
    return reviewVerdict(
      held.deposit,
      ctx.reviewPath,
      creditSkip(name, 'held review already matches this diff'),
    );
  }
  let outcome;
  try {
    outcome = await ctx.computeReview({
      storyId: ctx.storyId,
      cwd: ctx.cwd,
      config: ctx.config,
    });
  } catch (err) {
    return {
      name,
      outcome: 'error',
      detail: `review provider threw (${err?.message ?? err}); close computes the review itself`,
    };
  }
  if (!outcome?.written) {
    return {
      name,
      outcome: 'error',
      detail: `no held review written: ${outcome?.reason ?? 'unknown'}; close computes the review itself`,
    };
  }
  ctx.review = outcome.deposit?.severity ?? null;
  return reviewVerdict(
    outcome.deposit,
    outcome.path ?? null,
    ran(name, 'held review computed and deposited', {
      evidencePath: outcome.path ?? null,
    }),
  );
}

/** Pinned to the head it resolves now; never rejects. */
function startReview(ctx) {
  const startedAt = ctx.now();
  ctx.reviewPending = computeHeldReview(ctx)
    .catch((err) => ({
      name: 'review',
      outcome: 'error',
      detail: `held review failed (${err?.message ?? err}); close computes the review itself`,
    }))
    .then((result) => {
      ctx.reviewMs = ctx.now() - startedAt;
      ctx.reviewSettled = result;
      return result;
    });
  return ctx.reviewPending;
}

/** A review that halts mid-run aborts the run. */
async function stepCreditedRun(ctx) {
  const abort = new AbortController();
  let halted = null;
  ctx.reviewPending?.then((result) => {
    if (!result.stop) return;
    halted = result;
    abort.abort();
  });
  const run = await creditedRun(ctx, abort.signal);
  return run.outcome === 'aborted' ? [run, halted] : run;
}

function stepReview(ctx) {
  return ctx.reviewPending;
}

/**
 * Close's own duplication re-score, before any credit is minted, so close's
 * re-score no-ops on the handed-off tree. Best-effort: never stops the run.
 *
 * @param {object} ctx @returns {Promise<StepResult>}
 */
async function stepDuplicationRescore(ctx) {
  const settled = await rescoreDuplication(ctx, () => headSha(ctx));
  return { name: 'duplication-rescore', ...settled };
}

/**
 * Pure scoring after depositor and seat: no lock, no suite, no evidence, so
 * close re-scores them and stays authoritative.
 *
 * @param {object} ctx @returns {Promise<StepResult>}
 */
async function stepPostCapture(ctx) {
  const name = 'post-capture';
  const { postCaptureHead } = ctx.state;
  if (postCaptureHead === ctx.head && postCaptureSettled(ctx)) {
    return creditSkip(name, `already clean at ${ctx.head.slice(0, 12)}`);
  }
  const { gates, failed } = await scorePostCapture(ctx, (...a) =>
    runLogged(ctx, ...a),
  );
  if (failed) {
    const rows = raisedDuplicationSuffix(ctx, failed, MAX_OFFENDING_LINES);
    return fixRequired(name, `${failed.finding}${rows}`, {
      evidencePath: failed.evidencePath,
      gate: failed.gate,
      cause: 'post-capture',
    });
  }
  const post = await runPostSeatChecks(ctx, (...a) => runLogged(ctx, ...a));
  if (post.failed) return postSeatFixRequired(name, post.failed);
  ctx.state.postCaptureHead = ctx.head;
  return settledPostCapture(name, gates, post);
}

/**
 * Run each `delivery.handoff.postSeatChecks` entry through `run`; the first
 * non-zero exit is the finding. Skipped under a coverage deferral.
 *
 * @returns {Promise<{ checks: object[], skipped?: boolean, failed: object|null }>}
 */
async function runPostSeatChecks(ctx, run) {
  const checks = getPostSeatChecks(ctx.config);
  if (checks.length === 0) return { checks, failed: null };
  if (isCoverageDeferred(ctx)) return { checks, skipped: true, failed: null };
  for (const [i, check] of checks.entries()) {
    const res = await run(`post-seat-${i + 1}`, check.cmd, check.args);
    if (res.status !== 0)
      return { checks, failed: postSeatFailure(check, res) };
  }
  releaseHeldLint(ctx);
  return { checks, failed: null };
}

/** A failed post-seat check as the handoff's finding. */
function postSeatFailure(check, res) {
  const label = [check.cmd, ...check.args].join(' ');
  return {
    gate: 'post-seat',
    finding: `post-seat check \`${label}\` failed (exit ${res.status}) — fix and commit, then re-run`,
    evidencePath: res.evidencePath,
  };
}

/** @param {string} name @param {{ finding: string, evidencePath: string, gate: string }} failed */
function postSeatFixRequired(name, failed) {
  return fixRequired(name, failed.finding, {
    evidencePath: failed.evidencePath,
    gate: failed.gate,
    cause: 'post-capture',
  });
}

/** The clean post-capture result, naming the post-seat checks' outcome. */
function settledPostCapture(name, gates, post) {
  const names = gates.map((g) => g.name);
  if (post.checks.length > 0) {
    names.push(
      post.skipped
        ? 'post-seat checks skipped (coverage deferred)'
        : `${post.checks.length} post-seat check(s)`,
    );
  }
  return names.length > 0
    ? ran(name, `${names.join(', ')} clean`)
    : skipped(name, 'no post-capture gate registered');
}

/** `step`, unless the review has already halted: then the halt is its result. */
function beforeRun(step) {
  const guarded = (ctx) =>
    ctx.reviewSettled?.stop ? ctx.reviewSettled : step(ctx);
  return Object.defineProperty(guarded, 'name', { value: step.name });
}

/** Append the settled review unless a step already recorded it. */
function appendReview(steps, review) {
  if (review && !steps.some((s) => s.name === 'review')) steps.push(review);
}

/**
 * The run's step order. The base merges first, so every check scores the
 * tree that is pushed. Static MI seats before preflight, so no check refuses
 * a new file for a row the handoff can derive. On the evidence-gate path the
 * `test` credit is keyed on the tree, so the seat goes first and cannot void
 * it; the capture stamp's digests leave `baselines/` out, so the CRAP and
 * coverage seat after the capture keeps the stamp fresh.
 *
 * @param {'coverage-capture'|'test'} depositor
 * @returns {Array<(ctx: object) => Promise<StepResult>>}
 */
function stepOrder(depositor) {
  const middle =
    depositor === 'test'
      ? [beforeRun(stepSeat), beforeRun(stepCreditedRun)]
      : [beforeRun(stepCreditedRun), stepSeat];
  return [
    stepBaseMerge,
    stepDuplicationRescore,
    stepSeatStatic,
    stepPreflight,
    ...middle,
    stepPostCapture,
    stepPush,
    stepReview,
  ];
}

/** `run`'s results, each carrying the call's wall time as `durationMs`. */
async function timed(ctx, run) {
  const startedAt = ctx.now();
  const results = await run();
  const durationMs = ctx.now() - startedAt;
  return results.map((r) => ({ ...r, durationMs }));
}

/**
 * The review ran concurrently with the credited run: its own wall time is
 * `ctx.reviewMs`, not the time spent awaiting it.
 */
function envelopeStep(ctx, { stop: _stop, ...rest }) {
  return rest.name === 'review' ? { ...rest, durationMs: ctx.reviewMs } : rest;
}

/**
 * Run the steps in order into `steps`; a step may settle several results.
 *
 * @returns {Promise<StepResult|null>} the result that stopped the run.
 */
async function runSteps(ctx, steps) {
  for (const step of stepOrder(ctx.depositor)) {
    ctx.stepName = handoffStepName(step);
    ctx.storyProgress.phase(ctx.stepName);
    const results = await timed(ctx, async () => [await step(ctx)].flat());
    for (const result of results) {
      steps.push(result);
      ctx.progress(result.name, `${result.outcome} — ${result.detail}`);
    }
    const stop = results.find((r) => r.stop);
    if (stop) return stop;
  }
  return null;
}

const PRECHECK = Object.freeze({ cause: 'precheck' });

/**
 * Refusals before any step: the handoff runs on the Story branch with the
 * implementation committed.
 *
 * @param {object} ctx
 * @returns {StepResult|null}
 */
function precheck(ctx) {
  const current = gitLine(ctx.git, ctx.cwd, ['branch', '--show-current']);
  if (current !== ctx.branch) {
    return fixRequired(
      'precheck',
      `checked-out branch is ${current || 'unknown'}, not ${ctx.branch} — re-run single-story-init.js (idempotent) and work in its workCwd`,
      PRECHECK,
    );
  }
  if (!ctx.head) {
    return fixRequired('precheck', 'HEAD does not resolve', PRECHECK);
  }
  const dirty = changedPaths(ctx.git, ctx.cwd);
  if (dirty.length > 0) {
    return fixRequired(
      'precheck',
      `uncommitted changes (${dirty.slice(0, 5).join(', ')}) — commit the implementation, then re-run`,
      PRECHECK,
    );
  }
  return null;
}

/**
 * `{}` when absent or corrupt; a corrupt file is reported.
 *
 * @param {string} statePath
 * @param {(tag: string, msg: string) => void} progress
 * @returns {{ baseMergeSettled?: boolean, preflightHead?: string, preflightCredits?: Record<string, { head: string, configHash: string }>, creditHead?: string, creditTimings?: object, seatHead?: string, staticSeatHead?: string, postCaptureHead?: string, duplicationRescore?: { head: string, partners: Record<string, string[]> } }}
 */
function readState(statePath, progress) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw)?.state ?? {};
  } catch (err) {
    progress(
      'STATE',
      `⚠️ ignoring corrupt ${statePath} (${err.message}) — every step re-runs`,
    );
    return {};
  }
}

/**
 * Flip `agent::blocked` and post the `friction` comment naming the reason.
 * Each write is best-effort: a failed write degrades, never masks the block.
 *
 * @param {{ storyId: number, config: object, reason: string, detail: string,
 *   createProviderFn: Function, warn: Function }} args
 */
async function defaultBlock({
  storyId,
  config,
  reason,
  detail,
  createProviderFn,
  warn,
}) {
  let provider;
  try {
    provider = createProviderFn(config);
  } catch (err) {
    warn(`failed to create provider: ${err?.message ?? err}`);
    return;
  }
  try {
    await upsertStructuredComment(
      provider,
      storyId,
      'friction',
      `### story-handoff blocked: ${reason}\n\n${detail}\n\nThe worker cannot fix this by editing the branch; an operator must clear it, then re-run \`story-handoff.js\`.`,
    );
  } catch (err) {
    warn(`failed to post friction comment: ${err?.message ?? err}`);
  }
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
  } catch (err) {
    warn(`failed to flip agent::blocked: ${err?.message ?? err}`);
  }
}

/**
 * @param {{ storyId: number, cwd: string, config: object }} input
 * @param {{
 *   git?: typeof gitSpawn,
 *   runCommand?: (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ status: number, stdout: string, stderr: string, timedOut?: boolean }>,
 *   syncFromBase?: typeof syncBranchFromBase,
 *   probeBaseSync?: typeof import('../git/base-sync-probe.js').probeBaseSync,
 *   probeReview?: typeof probeHeldReviewDiff,
 *   computeReview: (input: { storyId: number, cwd: string, config: object }) => Promise<{ written: boolean, path?: string, reason?: string, deposit?: object }>,
 *   readPackageScriptsFn?: typeof readPackageScripts,
 *   getChangedFilesFn?: typeof import('../changed-files.js').getChangedFiles,
 *   block?: (args: { storyId: number, config: object, reason: string, detail: string }) => Promise<void>,
 *   createProviderFn?: Function,
 *   progress?: (tag: string, msg: string) => void,
 *   logDir?: string,
 *   createLockChannel?: typeof createLockEventChannel,
 *   sleep?: (ms: number) => Promise<void>,
 *   lockPollMs?: number,
 *   env?: Record<string, string|undefined>,
 *   heartbeatMs?: number,
 *   commandTimeoutMs?: number|null,
 *   signalTarget?: import('node:events').EventEmitter,
 *   reraise?: (signal: string) => void,
 *   evidenceFs?: typeof fs,
 *   now?: () => number,
 *   evidenceCwd?: string,
 *   scopeGate?: typeof applyChangedFileScope,
 *   presentBaselines?: string[],
 *   runDuplicationRescore?: typeof runDuplicationCloseRescore,
 *   emitFriction?: typeof emitRuntimeFriction,
 *   writeSignal?: typeof import('../signals/write.js').appendSignal,
 *   readSignals?: typeof import('../signals/write.js').forEachLine,
 * }} deps `evidenceCwd` anchors close's evidence store (the main checkout);
 *   `runCommand` receives `onChunk`, `signal` and (when set)
 *   `timeoutMs` beside `cwd`/`env`; a runner that never calls `onChunk`
 *   still gets its whole output written at settle.
 * @returns {Promise<{ envelope: object, exitCode: number }>}
 */
export async function runStoryHandoff({ storyId, cwd, config }, deps) {
  const {
    git = gitSpawn,
    runCommand = spawnStreamAsync,
    syncFromBase = syncBranchFromBase,
    probeReview = probeHeldReviewDiff,
    computeReview,
    readPackageScriptsFn = readPackageScripts,
    getChangedFilesFn,
    createProviderFn,
    progress = () => {},
    logDir = orchestrationLogDir(config),
    createLockChannel = createLockEventChannel,
    sleep = defaultSleep,
    lockPollMs = LOCK_POLL_MS,
    env = process.env,
    heartbeatMs,
    commandTimeoutMs,
    signalTarget,
    reraise,
    evidenceFs,
    now = Date.now,
    evidenceCwd = PROJECT_ROOT,
    scopeGate = applyChangedFileScope,
    presentBaselines,
    runDuplicationRescore = runDuplicationCloseRescore,
    emitFriction = emitRuntimeFriction,
    admitSuite = withSuiteAdmission,
    writeSignal,
    readSignals,
  } = deps;
  const block =
    deps.block ??
    ((args) =>
      defaultBlock({
        ...args,
        createProviderFn,
        warn: (m) => progress('BLOCK', m),
      }));
  fs.mkdirSync(logDir, { recursive: true });
  const statePath = handoffStatePath(logDir, storyId);
  const branch = getStoryBranch(storyId);
  const evidencePathFor = (name) =>
    path.join(logDir, `story-handoff-${storyId}-${name}.log`);
  const storyProgress = createStoryProgress({
    storyId,
    stage: 'handoff',
    config,
  });
  const ctx = {
    storyId,
    cwd,
    config,
    branch,
    baseBranch: config?.project?.baseBranch ?? 'main',
    git,
    runCommand,
    syncFromBase,
    probeBaseSync: deps.probeBaseSync,
    probeReview,
    computeReview,
    progress,
    createLockChannel,
    sleep,
    lockPollMs,
    env,
    now,
    evidenceCwd,
    scopeGate,
    presentBaselines,
    getChangedFilesFn,
    runDuplicationRescore,
    emitFriction,
    admitSuite,
    state: readState(statePath, progress),
    review: null,
    reviewPending: null,
    reviewSettled: null,
    reviewMs: null,
    reviewPath: storyReviewDepositPath(storyId, config),
    scripts: readPackageScriptsFn(cwd),
    storyProgress,
    // Undefined fields take runStreamed's defaults.
    stream: {
      heartbeatMs,
      timeoutMs: commandTimeoutMs,
      signalTarget,
      reraise,
      fsImpl: evidenceFs,
    },
    evidencePathFor,
    writeEvidence: (name, text) => {
      const file = evidencePathFor(name);
      fs.writeFileSync(file, text ?? '', 'utf8');
      return file;
    },
  };
  const plan = selectCreditedDepositor({
    config,
    scripts: ctx.scripts,
    cwd,
    getChangedFilesImpl: getChangedFilesFn,
  });
  ctx.depositor = plan.depositor;
  ctx.skipBranch = plan.skipBranch;
  ctx.head = headSha(ctx);

  const steps = [];
  let stop;
  try {
    [stop] = await timed(ctx, async () => [precheck(ctx)].filter(Boolean));
    if (stop) steps.push(stop);
    else stop = await runSteps(ctx, steps);
  } catch (err) {
    // A runner fault is re-runnable, so it never flips agent::blocked.
    stop = fixRequired(
      ctx.stepName ?? 'precheck',
      `threw: ${err?.message ?? err}`,
      {
        cause: 'other',
      },
    );
    steps.push(stop);
    progress(stop.name, `${stop.outcome} — ${stop.detail}`);
  }
  appendReview(steps, await ctx.reviewPending);

  const status = stop?.stop ?? HANDOFF_STATUS.READY;
  const credited = steps.find((s) => s.name === 'credited-run');
  if (status === HANDOFF_STATUS.BLOCKED) {
    try {
      await block({
        storyId,
        config,
        reason: stop.reason,
        detail: stop.detail,
      });
    } catch (err) {
      progress('BLOCK', `block failed: ${err?.message ?? err}`);
    }
  }
  const envelope = {
    kind: 'story-handoff',
    storyId,
    branch,
    headSha: ctx.head,
    status,
    depositor: ctx.depositor,
    steps: steps.map((step) => envelopeStep(ctx, step)),
    review: ctx.review,
    lockWait: credited?.lockWait ?? null,
    suiteTimings: credited?.suiteTimings ?? null,
    reviewMs: ctx.reviewMs,
    ...coverageEnvelope(ctx),
    ...hostResourcesEnvelope(ctx),
    ...ctx.baseMergeEnvelope,
    ...(stop
      ? {
          failedStep: stop.name,
          cause: handoffCause(stop.cause),
          evidencePath: stop.evidencePath ?? null,
          ...(stop.reason ? { reason: stop.reason } : {}),
          ...(stop.conflictFiles ? { conflictFiles: stop.conflictFiles } : {}),
        }
      : {}),
    attempt: await nextHandoffAttempt({ storyId, config, readFn: readSignals }),
  };
  writeFileAtomic(
    statePath,
    `${JSON.stringify({ state: ctx.state, envelope }, null, 2)}\n`,
  );
  await emitHandoffRecord({
    storyId,
    envelope,
    config,
    writeFn: writeSignal,
    warn: (m) => progress('TELEMETRY', m),
  });
  return { envelope, exitCode: EXIT_CODES[status] };
}
