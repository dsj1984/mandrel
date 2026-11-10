/**
 * closeout-audit — report every landed Story whose close-out did not finish,
 * and (on `execute`) repair each drifted check through the seam that already
 * owns it. Probes, repairs and the lock are injected; the evaluation is pure.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readDeferralMarker } from '../coverage-deferral.js';
import { gh as defaultGh } from '../gh-exec.js';
import { deleteBranchRemote } from '../git-branch-cleanup.js';
import {
  gitSpawn as defaultGitSpawn,
  getStoryBranch,
  parseStoryBranch,
} from '../git-utils.js';
import { AGENT_LABELS } from '../label-constants.js';
import { buildProtectionCtx } from '../single-story-sweep/protection-ctx.js';
import {
  acquireSweepLock,
  resolveSweepLockPath,
} from '../single-story-sweep/sweep-lock.js';
import { sweepMergedBranches } from '../single-story-sweep.js';
import { purgeStoryTempArtifacts } from '../temp-retention.js';
import { ColumnSync, columnForLabels } from './column-sync.js';
import { probeBranch, probePr, probeTicket } from './deliver-recover.js';
import { isPrMerged } from './merge-poll.js';
import { sweepStaleStoryWorktrees } from './plan-runner/worktree-sweep.js';
import { NEXT_COMMANDS } from './story-deliver-terminal.js';

/** Repair order: `story-state` first, its land tail clears most of the rest. */
export const CHECKS = Object.freeze([
  'story-state',
  'board-status',
  'remote-branch',
  'local-branch',
  'worktree',
  'scratch',
]);

export const DEFAULT_SINCE_HOURS = 24;

// shortcut: one page of 100 recent merged PRs, raise it if a window holds more.
const MERGED_PR_PAGE = 100;

const auditCommand = (id) =>
  `node .agents/scripts/closeout-audit.js --story ${id} --execute`;

function repairCommandFor(check, storyId) {
  if (check === 'story-state') return NEXT_COMMANDS.confirmMerge(storyId);
  if (check === 'board-status') return NEXT_COMMANDS.resync(storyId);
  return auditCommand(storyId);
}

function row(check, storyId, status, evidence) {
  return {
    check,
    status,
    evidence,
    repair: status === 'drift' ? repairCommandFor(check, storyId) : null,
    repaired: false,
  };
}

function storyStateRow(storyId, { ticket, pr }) {
  if (!ticket?.ok) {
    return row(
      'story-state',
      storyId,
      'unknown',
      `ticket unreadable: ${ticket?.error}`,
    );
  }
  const issue = String(ticket.issueState ?? 'unknown').toLowerCase();
  const label = ticket.stateLabel ?? 'none';
  const marker = readDeferralMarker(pr?.body);
  const evidence =
    `issue=${issue} label=${label} pr=#${pr.number} merged` +
    (marker ? `; Coverage-deferred: ${marker}` : '');
  const ok = issue === 'closed' && label === AGENT_LABELS.DONE;
  return row('story-state', storyId, ok ? 'ok' : 'drift', evidence);
}

function boardRow(storyId, { ticket, board }) {
  const expected = ticket?.ok ? columnForLabels(ticket.labels) : null;
  if (!board?.ok || !expected || !board.column) {
    const why = board?.ok === false ? board.error : 'no Status to compare';
    return row('board-status', storyId, 'unknown', `board unreadable: ${why}`);
  }
  const ok = board.column === expected;
  return row(
    'board-status',
    storyId,
    ok ? 'ok' : 'drift',
    `Status=${board.column} expected=${expected}`,
  );
}

function presenceRow(check, storyId, present, evidence) {
  return row(check, storyId, present ? 'drift' : 'ok', evidence);
}

/**
 * Pure: one row per check from a Story's probe readings.
 *
 * @param {number} storyId
 * @param {object} r `{ ticket, pr, board, branch, remote, scratch }`
 * @returns {object[]}
 */
export function evaluateStory(storyId, r) {
  const branchName = getStoryBranch(storyId);
  if (!isPrMerged(r.pr)) {
    const why = r.pr?.error
      ? `PR probe failed: ${r.pr.error}`
      : `no merged ${branchName} PR — not landed`;
    return CHECKS.map((c) => row(c, storyId, 'unknown', why));
  }
  const remote = r.remote?.ok
    ? presenceRow(
        'remote-branch',
        storyId,
        Boolean(r.remote.sha),
        r.remote.sha
          ? `origin/${branchName} at ${r.remote.sha}`
          : `origin/${branchName} absent`,
      )
    : row(
        'remote-branch',
        storyId,
        'unknown',
        `ls-remote failed: ${r.remote?.error}`,
      );
  const scratch = r.scratch?.error
    ? row('scratch', storyId, 'unknown', `temp scan failed: ${r.scratch.error}`)
    : presenceRow(
        'scratch',
        storyId,
        r.scratch.paths.length > 0,
        r.scratch.paths.length
          ? r.scratch.paths.join(', ')
          : 'no per-Story temp artifacts',
      );
  return [
    storyStateRow(storyId, r),
    boardRow(storyId, r),
    remote,
    presenceRow(
      'local-branch',
      storyId,
      r.branch.local,
      r.branch.local ? `refs/heads/${branchName}` : 'no local ref',
    ),
    presenceRow(
      'worktree',
      storyId,
      Boolean(r.branch.worktreePath),
      r.branch.worktreePath ?? 'no worktree',
    ),
    scratch,
  ];
}

async function auditStory(storyId, probes) {
  const pr = await probes.pr(storyId);
  const ticket = await probes.ticket(storyId);
  const readings = {
    ticket,
    pr,
    board: await probes.board(storyId),
    branch: await probes.branch(storyId),
    remote: await probes.remote(storyId),
    scratch: await probes.scratch(storyId),
  };
  return {
    storyId,
    pr: pr?.number ?? null,
    readings,
    checks: evaluateStory(storyId, readings),
  };
}

async function safeRepair(fn, entry) {
  try {
    return (await fn(entry)) ?? { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

async function repairStory(before, { probes, repairs }) {
  const reasons = new Map();
  let current = before;
  for (const check of CHECKS) {
    if (current.checks.find((c) => c.check === check)?.status !== 'drift')
      continue;
    const res = await safeRepair(repairs[check], current);
    if (!res.ok) reasons.set(check, res.reason ?? 'refused');
    if (check === 'story-state')
      current = await auditStory(before.storyId, probes);
  }
  const after = await auditStory(before.storyId, probes);
  return markOutcome(before, after, (check) =>
    reasons.has(check)
      ? `repair refused: ${reasons.get(check)}`
      : 'still drifted after repair',
  );
}

function markOutcome(before, after, reasonFor) {
  const checks = after.checks.map((c) => {
    const was = before.checks.find((b) => b.check === c.check)?.status;
    if (c.status === 'drift' && was === 'drift') {
      return { ...c, evidence: `${c.evidence}; ${reasonFor(c.check)}` };
    }
    return { ...c, repaired: was === 'drift' && c.status === 'ok' };
  });
  return { ...after, checks };
}

export function summarize(stories) {
  const all = stories.flatMap((s) => s.checks);
  const count = (pred) => all.filter(pred).length;
  return {
    stories: stories.length,
    ok: count((c) => c.status === 'ok'),
    drift: count((c) => c.status === 'drift'),
    unknown: count((c) => c.status === 'unknown'),
    repaired: count((c) => c.repaired),
  };
}

/**
 * Audit each Story; on `execute`, repair drift under one lock and re-audit.
 *
 * @param {{ storyIds: number[], scope: object, probes: object, repairs?: object,
 *   execute?: boolean, withLock?: Function }} args
 * @returns {Promise<object>} the `closeout-audit` envelope.
 */
export async function runCloseoutAudit({
  storyIds,
  scope,
  probes,
  repairs,
  execute = false,
  withLock,
}) {
  let stories = [];
  for (const id of storyIds) stories.push(await auditStory(id, probes));
  const drifted = stories.some((s) =>
    s.checks.some((c) => c.status === 'drift'),
  );
  if (execute && drifted) {
    const locked = await withLock(async () => {
      const out = [];
      for (const s of stories)
        out.push(await repairStory(s, { probes, repairs }));
      return out;
    });
    stories = locked.locked
      ? locked.value
      : stories.map((s) =>
          markOutcome(
            s,
            s,
            () => `repair skipped: sweep lock ${locked.reason}`,
          ),
        );
  }
  const clean = stories.map(({ readings, ...s }) => s);
  return {
    kind: 'closeout-audit',
    scope,
    stories: clean,
    summary: summarize(clean),
  };
}

/** 0 nothing drifted (or all repaired), 2 drift remains. */
export function exitCodeFor(envelope) {
  return envelope.summary.drift > 0 ? 2 : 0;
}

export function renderAudit(envelope) {
  const lines = [];
  for (const s of envelope.stories) {
    lines.push(`Story #${s.storyId} (PR ${s.pr ? `#${s.pr}` : 'none'})`);
    for (const c of s.checks) {
      const mark = c.repaired ? 'repaired' : c.status;
      lines.push(`  ${c.check.padEnd(14)} ${mark.padEnd(8)} ${c.evidence}`);
      if (c.status === 'drift')
        lines.push(`  ${''.padEnd(14)} fix: ${c.repair}`);
    }
  }
  const t = envelope.summary;
  lines.push(
    `${t.stories} Story(ies): ${t.drift} drift, ${t.unknown} unknown, ${t.repaired} repaired.`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Pure scope filter: exact `story-<id>` heads merged at or after the cutoff.
 *
 * @param {Array<{ headRefName?: string, mergedAt?: string }>} rows
 * @param {{ sinceHours: number, nowMs: number }} window
 * @returns {number[]}
 */
export function selectMergedStoryIds(rows, { sinceHours, nowMs }) {
  const cutoff = nowMs - sinceHours * 3_600_000;
  const ids = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = parseStoryBranch(r?.headRefName);
    const merged = Date.parse(r?.mergedAt ?? '');
    if (id !== null && Number.isFinite(merged) && merged >= cutoff) ids.add(id);
  }
  return [...ids];
}

export async function listMergedStoryIds({
  gh = defaultGh,
  baseBranch,
  sinceHours,
  nowMs = Date.now(),
}) {
  const rows = await gh.pr.list(
    [
      '--state',
      'merged',
      '--base',
      baseBranch,
      '--limit',
      String(MERGED_PR_PAGE),
    ],
    ['number', 'headRefName', 'mergedAt'],
  );
  return selectMergedStoryIds(rows, { sinceHours, nowMs });
}

/** Live probes over the main checkout; every one settles, none throws. */
export function buildProbes({
  cwd,
  config,
  provider,
  gh = defaultGh,
  gitSpawnFn = defaultGitSpawn,
  purgeFn = purgeStoryTempArtifacts,
  logger,
}) {
  const branchOf = (id) => getStoryBranch(id);
  return {
    ticket: (id) => probeTicket({ provider, storyId: id }),
    pr: async (id) => {
      const pr = await probePr({ storyBranch: branchOf(id), gh });
      if (!isPrMerged(pr)) return pr;
      const view = await gh.pr.view(pr.number, ['body']).catch(() => null);
      return { ...pr, body: view?.body ?? null };
    },
    board: async (id) => {
      if (typeof provider?.graphql !== 'function')
        return { ok: false, error: 'no GraphQL transport' };
      try {
        const column = await new ColumnSync({
          provider,
          logger,
          config,
        }).readCurrentColumn(id);
        return { ok: true, column };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
    branch: (id) =>
      probeBranch({ cwd, storyBranch: branchOf(id), config, gitSpawnFn }),
    // ls-remote, not the tracking ref: a stale tracking ref would read as drift forever.
    remote: (id) => {
      const res = gitSpawnFn(
        cwd,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${branchOf(id)}`,
      );
      if (res.status !== 0)
        return {
          ok: false,
          error: (res.stderr || `exit ${res.status}`).trim(),
        };
      return {
        ok: true,
        sha:
          String(res.stdout ?? '')
            .trim()
            .split(/\s+/)[0] || null,
      };
    },
    scratch: async (id) => {
      const res = await purgeFn({ storyId: id, config, dryRun: true, logger });
      if (res.errors?.length) return { error: res.errors[0] };
      return { paths: res.purged.map((p) => p.path) };
    },
  };
}

function runScript({ cwd, spawnFn }, script, storyId) {
  const res = spawnFn(
    process.execPath,
    [path.join(cwd, '.agents', 'scripts', script), '--story', String(storyId)],
    {
      cwd,
      stdio: ['ignore', process.stderr, process.stderr],
    },
  );
  return res.status === 0
    ? { ok: true }
    : { ok: false, reason: `${script} exited ${res.status}` };
}

function refusalFromSweep(result, branch) {
  if (result?.reaped?.includes(branch)) return { ok: true };
  const prot = result?.protected?.find((p) => p.branch === branch);
  if (prot) return { ok: false, reason: prot.reason };
  if (result?.contentMerged?.some((p) => p.branch === branch))
    return { ok: false, reason: 'content-merged, left for /clean-git' };
  const fail = result?.failures?.find((f) => f.branch === branch);
  return {
    ok: false,
    reason:
      fail?.stderr ||
      result?.error ||
      result?.reason ||
      'not a merged sweep candidate',
  };
}

/** Each check's existing repair seam, wrapped to `{ ok, reason? }`. */
export function buildRepairs({
  cwd,
  config,
  provider,
  logger,
  spawnFn = spawnSync,
  deleteRemoteFn = deleteBranchRemote,
  sweepBranchesFn = sweepMergedBranches,
  sweepWorktreesFn = sweepStaleStoryWorktrees,
  purgeFn = purgeStoryTempArtifacts,
}) {
  const ctx = { cwd, spawnFn };
  return {
    'story-state': (e) =>
      runScript(ctx, 'single-story-confirm-merge.js', e.storyId),
    'board-status': (e) => runScript(ctx, 'resync-status-column.js', e.storyId),
    'remote-branch': (e) => {
      const { sha } = e.readings.remote;
      const merged = e.readings.pr.headSha;
      if (merged && sha !== merged)
        return {
          ok: false,
          reason: `origin head ${sha} is not the merged head ${merged}`,
        };
      const res = deleteRemoteFn(getStoryBranch(e.storyId), { cwd });
      return res.deleted
        ? { ok: true }
        : { ok: false, reason: res.stderr || res.reason };
    },
    'local-branch': async (e) => {
      const branch = getStoryBranch(e.storyId);
      const result = await sweepBranchesFn({
        cwd,
        baseBranch: config?.project?.baseBranch ?? 'main',
        include: [branch],
        logger,
        protectionCtx: buildProtectionCtx({ cwd, provider }),
      });
      return refusalFromSweep(result, branch);
    },
    worktree: async (e) => {
      const result = await sweepWorktreesFn({
        provider,
        repoRoot: cwd,
        logger,
      });
      const skip = result?.skipped?.find((s) => s.storyId === e.storyId);
      return skip ? { ok: false, reason: skip.reason } : { ok: true };
    },
    scratch: async (e) => {
      const res = await purgeFn({ storyId: e.storyId, config, logger });
      return res.errors?.length
        ? { ok: false, reason: res.errors[0] }
        : { ok: true };
    },
  };
}

/** The sweep lock boot-sweep and init share, held across every repair. */
export function buildWithLock({ cwd, config, acquireFn = acquireSweepLock }) {
  return async (fn) => {
    const lock = acquireFn({
      lockPath: resolveSweepLockPath({
        cwd,
        tempRoot: config?.project?.paths?.tempRoot ?? 'temp',
      }),
      timeoutMs: config?.delivery?.worktreeIsolation?.sweepLockMs ?? 60_000,
    });
    if (!lock.acquired) return { locked: false, reason: lock.reason };
    try {
      return { locked: true, value: await fn() };
    } finally {
      lock.release();
    }
  };
}
