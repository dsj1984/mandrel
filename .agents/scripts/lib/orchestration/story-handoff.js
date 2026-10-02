/**
 * story-handoff.js — the story-worker's whole post-implementation tail as one
 * deterministic sequence: blocking preflight (lint, quality-preview, baselined
 * ratchets) → base merge → the one credited run → baseline seating → push +
 * remote-ref check → held review. It runs
 * exactly what deliver-digest § 5 and deliver-reference § Held review define,
 * changing nothing close credits or adopts, and settles one envelope:
 *
 * - `ready` (exit 0) — hand off.
 * - `fix-required` (exit 2) — the worker can fix it by editing the branch;
 *   labels untouched.
 * - `blocked` (exit 1) — the worker cannot: a rejected push, an unreachable
 *   remote, an unconfirmed base branch or an unregistered baseline merge
 *   driver. Flips `agent::blocked` and posts a `friction` comment.
 *
 * Idempotent: a re-run skips every step whose result is still valid for the
 * current HEAD, judged by the step's output signal, never its exit code alone.
 * Never runs close, opens a PR or writes any label but `agent::blocked`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnCaptureAsync } from '../child-exec.js';
import { resolveLintCommand } from '../close-validation/commands.js';
import {
  isCrapGateEnabled,
  resolveCreditedDepositor,
} from '../close-validation/gates.js';
import {
  orchestrationLogDir,
  storyReviewDepositPath,
} from '../config/temp-paths.js';
import { LOCK_WAIT_EXPIRED_EXIT_CODE } from '../full-suite-lock.js';
import { syncBranchFromBase } from '../git/sync-from-base.js';
import { getStoryBranch, gitSpawn } from '../git-utils.js';
import { readPackageScripts } from '../npm-scripts.js';
import { TIMEOUT_EXIT_CODE } from '../process-group.js';
import { probeHeldReviewDiff } from './review-deposit.js';
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
  // Only a digest-fresh verdict is credit: the incremental / affected
  // `no changed files … — skipping capture` lines ran no suite at all.
  captureFresh:
    /\bis fresh(?: \((?:incremental|affected)\))? — skipping capture/,
  testRan: /✓ test passed/,
  testFresh: /⏭ test skipped/,
  seated: /seated:\s*(\d+)/,
  gateFail: /\(gate fail\)/,
  offending: /^[+!] /,
});

/** CI's standalone ratchets; each runs only when its baseline is committed. */
const RATCHETS = Object.freeze([
  {
    key: 'dead-exports',
    script: 'check-dead-exports.js',
    args: [],
    baseline: 'baselines/dead-exports.json',
  },
  {
    key: 'dead-exports-production',
    script: 'check-dead-exports.js',
    args: ['--production'],
    baseline: 'baselines/dead-exports-production.json',
  },
  {
    key: 'arch-cycles',
    script: 'check-arch-cycles.js',
    args: [],
    baseline: 'baselines/arch-cycles.json',
  },
  {
    key: 'cyclomatic',
    script: 'check-cyclomatic.js',
    args: [],
    baseline: 'baselines/cyclomatic.json',
  },
]);

const MAX_OFFENDING_LINES = 10;

const SEAT_SCRIPTS = Object.freeze({
  crap: 'update-crap-baseline.js',
  maintainability: 'update-maintainability-baseline.js',
});

/**
 * A settled step. `stop` carries the envelope status that ends the run.
 *
 * @typedef {{ name: string, outcome: 'ran'|'skipped'|'failed'|'error',
 *   detail: string, evidencePath?: string|null, conflictFiles?: string[],
 *   stop?: 'fix-required'|'blocked', reason?: string }} StepResult
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
 * Run one child, write its combined output to the step's evidence log.
 *
 * @param {object} ctx
 * @param {string} logName
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<{ status: number, output: string, evidencePath: string }>}
 */
async function runLogged(ctx, logName, cmd, args) {
  ctx.progress(logName, `${cmd} ${args.join(' ')}`);
  const res = await ctx.runCommand(cmd, args, { cwd: ctx.cwd });
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n');
  const evidencePath = ctx.writeEvidence(logName, output);
  return { status: res.status, output, evidencePath };
}

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
  if (status === TIMEOUT_EXIT_CODE) {
    return `suite timed out (exit ${status}) — usually host contention; re-run the handoff`;
  }
  return `red suite (exit ${status}) — fix the failing tests, commit, re-run`;
}

/**
 * Lint, quality-preview, then each ratchet whose baseline is committed.
 *
 * @param {object} ctx
 * @returns {Array<{ key: string, cmd: string, args: string[], gated?: boolean }>}
 */
function preflightChecks(ctx) {
  const [lintCmd, ...lintArgs] = resolveLintCommand(ctx.config)
    .split(/\s+/)
    .filter(Boolean);
  const ratchets = RATCHETS.filter((r) =>
    fs.existsSync(path.join(ctx.cwd, r.baseline)),
  ).map((r) => ({
    key: r.key,
    cmd: 'node',
    args: [path.join(SCRIPTS_DIR, r.script), ...r.args],
    gated: true,
  }));
  return [
    { key: 'lint', cmd: lintCmd, args: lintArgs },
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
 *
 * @param {{ key: string, gated?: boolean }} check
 * @param {{ status: number, output: string }} run
 * @returns {string|null} the finding, `null` when the check passed.
 */
function preflightFinding(check, run) {
  const gateFailed = check.gated === true && SIGNALS.gateFail.test(run.output);
  if (run.status === 0 && !gateFailed) return null;
  const offending = check.gated
    ? run.output
        .split(/\r?\n/)
        .filter((line) => SIGNALS.offending.test(line))
        .slice(0, MAX_OFFENDING_LINES)
    : [];
  const rows = offending.length > 0 ? `: ${offending.join('; ')}` : '';
  return `${check.key}${check.gated ? ' ratchet' : ''} finding${rows} — fix and commit, then re-run`;
}

/** @param {object} ctx @returns {Promise<StepResult>} */
async function stepPreflight(ctx) {
  const name = 'preflight';
  if (ctx.state.preflightHead === ctx.head) {
    return skipped(
      name,
      `preflight already passed at ${ctx.head.slice(0, 12)}`,
    );
  }
  const checks = preflightChecks(ctx);
  for (const check of checks) {
    const run = await runLogged(
      ctx,
      `preflight-${check.key}`,
      check.cmd,
      check.args,
    );
    const finding = preflightFinding(check, run);
    if (finding) {
      return fixRequired(name, finding, { evidencePath: run.evidencePath });
    }
  }
  ctx.state.preflightHead = ctx.head;
  return ran(name, `${checks.map((c) => c.key).join(', ')} clean`);
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
  const sync = await ctx.syncFromBase({
    cwd: ctx.cwd,
    baseBranch: ctx.baseBranch,
    log: ctx.progress,
  });
  if (sync.synced) {
    ctx.head = headSha(ctx) ?? ctx.head;
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
      { conflictFiles: sync.conflictFiles },
    );
  }
  return fixRequired(name, `merge failed: ${sync.stderr}`.trim());
}

/**
 * The depositor close will credit, from the one shared predicate.
 *
 * @param {{ config: object, scripts: Record<string, string>|null, cwd: string, getChangedFilesImpl?: Function }} args
 * @returns {'coverage-capture'|'test'}
 */
function selectCreditedDepositor({ config, ...probe }) {
  const baseBranch = config?.project?.baseBranch ?? 'main';
  return resolveCreditedDepositor({ config, baseBranch, ...probe });
}

/** @param {object} ctx @returns {Promise<StepResult>} */
async function stepCreditedRun(ctx) {
  const name = 'credited-run';
  if (ctx.state.creditHead === ctx.head) {
    return skipped(
      name,
      `${ctx.depositor} credit already deposited at ${ctx.head.slice(0, 12)}`,
      { depositor: ctx.depositor },
    );
  }
  const capture = ctx.depositor === 'coverage-capture';
  const run = capture
    ? await runLogged(ctx, 'credited-run', 'node', [
        path.join(SCRIPTS_DIR, 'coverage-capture.js'),
        '--cwd',
        ctx.cwd,
      ])
    : await runLogged(ctx, 'credited-run', 'node', [
        path.join(SCRIPTS_DIR, 'evidence-gate.js'),
        '--standalone',
        '--scope-id',
        String(ctx.storyId),
        '--gate',
        'test',
        '--worktree',
        ctx.cwd,
        '--',
        'npm',
        'test',
      ]);
  const extra = { evidencePath: run.evidencePath, depositor: ctx.depositor };
  if (run.status !== 0) {
    return fixRequired(name, describeSuiteFailure(run.status), extra);
  }
  const [ranSignal, freshSignal] = capture
    ? [SIGNALS.captureRan, SIGNALS.captureFresh]
    : [SIGNALS.testRan, SIGNALS.testFresh];
  if (ranSignal.test(run.output)) {
    ctx.state.creditHead = ctx.head;
    return ran(name, `${ctx.depositor} deposited credit`, extra);
  }
  if (freshSignal.test(run.output)) {
    ctx.state.creditHead = ctx.head;
    return skipped(name, `${ctx.depositor} credit already fresh`, extra);
  }
  return fixRequired(
    name,
    `${ctx.depositor} exited 0 but printed no credit signal, so it deposited nothing`,
    extra,
  );
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

/** @param {object} ctx @returns {Promise<StepResult>} */
async function commitSeatedRows(ctx, total, evidencePath) {
  const name = 'seat';
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
      { evidencePath: ctx.writeEvidence('seat-commit', detail) },
    );
  }
  const creditedPrior = ctx.state.creditHead === ctx.head;
  ctx.head = headSha(ctx) ?? ctx.head;
  ctx.state.seatHead = ctx.head;
  // The capture stamp digests scorable sources only, so a baseline-JSON-only
  // commit keeps the credit it already holds.
  if (creditedPrior && ctx.depositor === 'coverage-capture') {
    ctx.state.creditHead = ctx.head;
  }
  return ran(name, `seated ${total} row(s) and committed them`, {
    evidencePath,
  });
}

/**
 * The gates whose baselines take a `--seat-missing` pass: CRAP by close's own
 * predicate, MI unless explicitly disabled (both default on).
 *
 * @param {object} config
 * @returns {Array<keyof typeof SEAT_SCRIPTS>}
 */
function seatKinds(config) {
  const mi = config?.delivery?.quality?.gates?.maintainability?.enabled;
  return [
    ...(isCrapGateEnabled(config) ? ['crap'] : []),
    ...(mi === false ? [] : ['maintainability']),
  ];
}

/** @param {object} ctx @returns {Promise<StepResult>} */
async function stepSeat(ctx) {
  const name = 'seat';
  if (ctx.state.seatHead === ctx.head) {
    return skipped(name, `nothing to seat at ${ctx.head.slice(0, 12)}`);
  }
  const kinds = seatKinds(ctx.config);
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
        { evidencePath: run.evidencePath },
      );
    }
    total += Number(match[1]);
  }
  if (total === 0) {
    ctx.state.seatHead = ctx.head;
    return skipped(name, 'seated: 0 — nothing to seat', { evidencePath });
  }
  return commitSeatedRows(ctx, total, evidencePath);
}

/**
 * @param {object} ctx
 * @returns {{ reachable: boolean, sha: string|null, detail: string }}
 */
function remoteBranchSha(ctx) {
  const res = ctx.git(
    ctx.cwd,
    'ls-remote',
    'origin',
    `refs/heads/${ctx.branch}`,
  );
  if (res?.status !== 0) {
    return {
      reachable: false,
      sha: null,
      detail: `${res?.stderr ?? ''}`.trim(),
    };
  }
  const sha = (res.stdout ?? '').toString().trim().split(/\s+/)[0] || null;
  return { reachable: true, sha, detail: '' };
}

const PORCELAIN_STATUS = /^\s*[ MADRCUT?!]{1,2}\s/;

const REMOTE_REJECTED =
  /\[remote rejected\]|permission to \S+ denied|returned error: 403/i;
const REF_BEHIND = /\[rejected\].*\((non-fast-forward|fetch first)\)/;
const REMOTE_UNREACHABLE =
  /could not resolve host|unable to access|could not read from remote|connection (refused|timed out|reset)|network is unreachable/i;
const PUSH_FAILURES = [
  [REMOTE_REJECTED, 'push-rejected'],
  [REMOTE_UNREACHABLE, 'remote-unreachable'],
  [REF_BEHIND, 'ref-behind'],
];

/**
 * A push the remote refused or could not be reached is blocked; a branch
 * behind its remote or a failing `pre-push` hook is the worker's to fix.
 *
 * @param {string} output
 * @returns {'push-rejected'|'remote-unreachable'|'ref-behind'|null}
 */
function classifyPushFailure(output) {
  for (const [pattern, reason] of PUSH_FAILURES) {
    if (pattern.test(output)) return reason;
  }
  return null;
}

/**
 * @param {object} ctx
 * @param {{ output: string, evidencePath: string|null }} push
 * @returns {StepResult}
 */
function pushFailure(ctx, push) {
  const reason = classifyPushFailure(push.output);
  const evidence = { evidencePath: push.evidencePath };
  if (reason === 'ref-behind') {
    return fixRequired(
      'push',
      `origin/${ctx.branch} has commits HEAD lacks — git fetch origin ${ctx.branch}, git merge origin/${ctx.branch}, re-run`,
      evidence,
    );
  }
  return reason
    ? blocked('push', reason, `git push failed (${reason})`, evidence)
    : fixRequired(
        'push',
        'git push failed locally (a pre-push hook?) — fix the cause with a NEW commit, re-run',
        evidence,
      );
}

/** @param {object} ctx @returns {Promise<StepResult>} */
async function stepPush(ctx) {
  const name = 'push';
  const before = remoteBranchSha(ctx);
  if (!before.reachable) {
    return blocked(name, 'remote-unreachable', before.detail);
  }
  if (before.sha === ctx.head) {
    return skipped(name, `origin/${ctx.branch} already at HEAD`);
  }
  const push = await runLogged(ctx, 'push', 'git', [
    'push',
    '-u',
    'origin',
    ctx.branch,
  ]);
  if (push.status !== 0) return pushFailure(ctx, push);
  const after = remoteBranchSha(ctx);
  if (after.sha !== ctx.head) {
    return blocked(
      name,
      'push-unconfirmed',
      `origin/${ctx.branch} reads ${after.sha ?? 'nothing'} after the push, not HEAD ${ctx.head}`,
      { evidencePath: push.evidencePath },
    );
  }
  return ran(name, `pushed ${ctx.branch} → ${ctx.head.slice(0, 12)}`, {
    evidencePath: push.evidencePath,
  });
}

/**
 * @param {object} deposit
 * @param {string|null} depositPath
 * @param {StepResult} settled
 * @returns {StepResult}
 */
function reviewVerdict(deposit, depositPath, settled) {
  if (deposit?.halted) {
    return fixRequired(
      'review',
      'held review found a CRITICAL — fix, commit, re-run the handoff',
      { evidencePath: depositPath },
    );
  }
  return settled;
}

/** @param {object} ctx @returns {Promise<StepResult>} */
async function stepReview(ctx) {
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
      skipped(name, 'held review already matches this diff'),
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

/**
 * The run's step order. On the evidence-gate path the `test` credit is keyed
 * on the tree, so seating (static MI) goes first and cannot void it; the
 * capture stamp digests scorable sources only, so a baseline seat after it
 * keeps the stamp fresh.
 *
 * @param {'coverage-capture'|'test'} depositor
 * @returns {Array<(ctx: object) => Promise<StepResult>>}
 */
function stepOrder(depositor) {
  const middle =
    depositor === 'test'
      ? [stepSeat, stepCreditedRun]
      : [stepCreditedRun, stepSeat];
  return [stepPreflight, stepBaseMerge, ...middle, stepPush, stepReview];
}

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
    );
  }
  if (!ctx.head) {
    return fixRequired('precheck', 'HEAD does not resolve');
  }
  const dirty = changedPaths(ctx.git, ctx.cwd);
  if (dirty.length > 0) {
    return fixRequired(
      'precheck',
      `uncommitted changes (${dirty.slice(0, 5).join(', ')}) — commit the implementation, then re-run`,
    );
  }
  return null;
}

/**
 * @param {string} statePath
 * @returns {{ preflightHead?: string, creditHead?: string, seatHead?: string }}
 */
function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))?.state ?? {};
  } catch {
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
  const provider = createProviderFn(config);
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
 *   runCommand?: (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ status: number, stdout: string, stderr: string }>,
 *   syncFromBase?: typeof syncBranchFromBase,
 *   probeReview?: typeof probeHeldReviewDiff,
 *   computeReview: (input: { storyId: number, cwd: string, config: object }) => Promise<{ written: boolean, path?: string, reason?: string, deposit?: object }>,
 *   readPackageScriptsFn?: typeof readPackageScripts,
 *   getChangedFilesFn?: typeof import('../changed-files.js').getChangedFiles,
 *   block?: (args: { storyId: number, config: object, reason: string, detail: string }) => Promise<void>,
 *   createProviderFn?: Function,
 *   progress?: (tag: string, msg: string) => void,
 *   logDir?: string,
 * }} deps
 * @returns {Promise<{ envelope: object, exitCode: number }>}
 */
export async function runStoryHandoff({ storyId, cwd, config }, deps) {
  const {
    git = gitSpawn,
    runCommand = spawnCaptureAsync,
    syncFromBase = syncBranchFromBase,
    probeReview = probeHeldReviewDiff,
    computeReview,
    readPackageScriptsFn = readPackageScripts,
    getChangedFilesFn,
    createProviderFn,
    progress = () => {},
    logDir = orchestrationLogDir(config),
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
  const statePath = path.join(logDir, `story-handoff-${storyId}.json`);
  const branch = getStoryBranch(storyId);
  const ctx = {
    storyId,
    cwd,
    config,
    branch,
    baseBranch: config?.project?.baseBranch ?? 'main',
    git,
    runCommand,
    syncFromBase,
    probeReview,
    computeReview,
    progress,
    state: readState(statePath),
    review: null,
    reviewPath: storyReviewDepositPath(storyId, config),
    depositor: selectCreditedDepositor({
      config,
      scripts: readPackageScriptsFn(cwd),
      cwd,
      getChangedFilesImpl: getChangedFilesFn,
    }),
    writeEvidence: (name, text) => {
      const file = path.join(logDir, `story-handoff-${storyId}-${name}.log`);
      fs.writeFileSync(file, text ?? '', 'utf8');
      return file;
    },
  };
  ctx.head = headSha(ctx);

  const steps = [];
  let stop = precheck(ctx);
  if (stop) steps.push(stop);
  for (const step of stop ? [] : stepOrder(ctx.depositor)) {
    const result = await step(ctx);
    steps.push(result);
    progress(result.name, `${result.outcome} — ${result.detail}`);
    if (result.stop) {
      stop = result;
      break;
    }
  }

  const status = stop?.stop ?? HANDOFF_STATUS.READY;
  if (status === HANDOFF_STATUS.BLOCKED) {
    await block({ storyId, config, reason: stop.reason, detail: stop.detail });
  }
  const envelope = {
    kind: 'story-handoff',
    storyId,
    branch,
    headSha: ctx.head,
    status,
    depositor: ctx.depositor,
    steps: steps.map(({ stop: _stop, ...rest }) => rest),
    review: ctx.review,
    ...(stop
      ? {
          failedStep: stop.name,
          evidencePath: stop.evidencePath ?? null,
          ...(stop.reason ? { reason: stop.reason } : {}),
          ...(stop.conflictFiles ? { conflictFiles: stop.conflictFiles } : {}),
        }
      : {}),
  };
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ state: ctx.state, envelope }, null, 2)}\n`,
    'utf8',
  );
  return { envelope, exitCode: EXIT_CODES[status] };
}
