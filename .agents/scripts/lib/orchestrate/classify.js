/**
 * classify.js — one state per open PR from a normalised snapshot, and the
 * terse inventory envelope built around it. Pure: every read happened before.
 */

import { conflictState } from './conflicts.js';
import { failureSignature, findInherited } from './inherited-failure.js';

/** A not-green PR with no push or check activity for this long is stale. */
const STALE_MS = 45 * 60_000;

const RED_SHOWN = 2;
const CONFLICTS_SHOWN = 10;
const BUDGET_BYTES = 16384;
const OVERLAPS_KEPT = 10;

/**
 * Rollup over the required checks (every check when the required set is
 * unknown). Green needs every required name present, done and not red.
 *
 * @param {Array<{ name: string, phase: string, red: boolean }>} checks
 * @param {string[]|null} required
 */
function rollup(checks, required) {
  const want = required ? new Set(required) : null;
  const relevant = want ? checks.filter((c) => want.has(c.name)) : checks;
  const red = relevant.some((c) => c.red);
  const running = relevant.some((c) => c.phase === 'running');
  const queued = relevant.some((c) => c.phase === 'queued');
  const present = new Set(relevant.map((c) => c.name));
  const complete = want
    ? [...want].every((n) => present.has(n))
    : relevant.length > 0;
  return {
    red,
    running,
    queued,
    green: complete && !red && !running && !queued,
  };
}

/** The ejection is stale once the head moved past the commit it removed. */
function headMoved(pr) {
  const event = pr.queueEvent;
  if (event?.headSha) return pr.headSha !== event.headSha;
  return Date.parse(pr.pushedAt ?? '') > Date.parse(event?.at ?? '');
}

function isEjected(pr, queueReadable) {
  return (
    queueReadable &&
    pr.inQueue === false &&
    pr.queueEvent?.type === 'removed' &&
    !/merged/i.test(pr.queueEvent.reason ?? '')
  );
}

/**
 * The first rule that holds wins: ejected, conflicted-real / -driver-only,
 * red-inherited, red-own-failure, waiting-on-runner, green-not-queued,
 * stale, moving.
 *
 * @param {object} pr normalised snapshot row
 * @param {{ queueReadable: boolean, inheritedPrs: Set<number>,
 *   required: string[]|null, now: number }} ctx
 * @returns {{ state: string, checks: ReturnType<typeof rollup>, conflict?: object }}
 */
function classifyPr(pr, ctx) {
  const checks = rollup(pr.checks, ctx.required);
  const done = (state, extra) => ({ state, checks, ...extra });
  if (isEjected(pr, ctx.queueReadable)) return done('ejected');
  if (pr.conflicting) {
    const conflict = conflictState(pr.conflict);
    return done(conflict.state, { conflict });
  }
  if (checks.red) {
    return done(
      ctx.inheritedPrs.has(pr.number) ? 'red-inherited' : 'red-own-failure',
    );
  }
  return done(quietState(pr, checks, ctx));
}

/** The states below red: waiting-on-runner, green-not-queued, stale, moving. */
function quietState(pr, checks, ctx) {
  if (checks.queued && !checks.running) return 'waiting-on-runner';
  const unqueued = ctx.queueReadable && pr.inQueue === false && !pr.autoMerge;
  if (checks.green && unqueued && !pr.draft) return 'green-not-queued';
  const idleMs = ctx.now - Date.parse(pr.activityAt ?? '');
  return !checks.green && idleMs > STALE_MS ? 'stale' : 'moving';
}

/**
 * @param {{ cmd: string, args?: string[] }|null} requeueCommand
 * @param {number} number
 */
function substitute(requeueCommand, number) {
  if (!requeueCommand) return null;
  return {
    cmd: requeueCommand.cmd,
    args: (requeueCommand.args ?? []).map((a) =>
      a.replaceAll('{pr}', String(number)),
    ),
  };
}

function requeueOf(pr, { green, vetoHeld, requeueCommand }) {
  const blockedBy = [];
  if (!headMoved(pr)) blockedBy.push('head-not-moved');
  if (!green) blockedBy.push('checks-not-green');
  if (vetoHeld) blockedBy.push('release-veto');
  return {
    eligible: blockedBy.length === 0,
    blockedBy,
    command: substitute(requeueCommand, pr.number),
  };
}

/**
 * Pairs of open PRs changing a common path, largest first.
 *
 * @param {Array<{ number: number, paths: string[] }>} prs
 */
function findOverlaps(prs) {
  const pairs = [];
  for (let i = 0; i < prs.length; i += 1) {
    const mine = new Set(prs[i].paths);
    for (let j = i + 1; j < prs.length; j += 1) {
      const shared = prs[j].paths.filter((p) => mine.has(p));
      if (shared.length > 0) {
        pairs.push({
          prs: [prs[i].number, prs[j].number],
          shared: shared.length,
          paths: shared.slice(0, 2),
        });
      }
    }
  }
  return pairs.sort((a, b) => b.shared - a.shared).slice(0, OVERLAPS_KEPT);
}

function redSigs(pr, required) {
  const want = required ? new Set(required) : null;
  return pr.checks
    .filter((c) => c.red && (!want || want.has(c.name)))
    .map(failureSignature);
}

function conflictFields({ paths }) {
  return {
    conflicted: paths ? paths.slice(0, CONFLICTS_SHOWN) : null,
    conflictedCount: paths ? paths.length : null,
  };
}

function prEntry(pr, verdict, opts) {
  const vetoed = opts.vetoLabel ? pr.labels.includes(opts.vetoLabel) : false;
  const entry = {
    number: pr.number,
    state: verdict.state,
    storyId: pr.storyId,
    author: pr.author,
    assignees: pr.assignees,
    head: pr.headSha?.slice(0, 7) ?? null,
    pathCount: pr.pathCount,
  };
  if (verdict.state.startsWith('red-')) entry.red = pr.sigs.slice(0, RED_SHOWN);
  if (verdict.conflict) Object.assign(entry, conflictFields(verdict.conflict));
  if (vetoed) entry.veto = opts.vetoHeld ? 'held' : 'clear';
  if (verdict.state === 'ejected') {
    entry.requeue = requeueOf(pr, {
      green: verdict.checks.green,
      vetoHeld: vetoed && opts.vetoHeld,
      requeueCommand: opts.requeueCommand,
    });
  }
  return entry;
}

/**
 * The inventory envelope, `changes[]` left empty for the ledger to fill.
 *
 * @param {object} snapshot normalised reads (see `inventory.js`)
 * @param {{ now: number, vetoLabel?: string|null, vetoHeld?: boolean,
 *   requeueCommand?: object|null }} opts
 */
export function buildEnvelope(snapshot, opts) {
  const { required, queueReadable } = snapshot;
  const prs = snapshot.prs.map((pr) => ({
    ...pr,
    sigs: redSigs(pr, required),
  }));
  const baseSigs = redSigs({ checks: snapshot.base.checks }, required);
  const { inheritedPrs, inherited } = findInherited(prs, baseSigs);
  const ctx = { queueReadable, inheritedPrs, required, now: opts.now };
  return fitBudget({
    kind: 'orchestrate-inventory',
    base: {
      branch: snapshot.base.branch,
      sha: snapshot.base.sha?.slice(0, 7) ?? null,
      red: baseSigs,
    },
    runners: snapshot.runners,
    prs: prs.map((pr) => prEntry(pr, classifyPr(pr, ctx), opts)),
    overlaps: findOverlaps(prs),
    inherited,
    landed: snapshot.merged.filter((m) => m.storyId !== null),
    changes: [],
    degraded: snapshot.degraded,
  });
}

/** Trims applied in order, each only while the envelope is over budget. */
const TRIMS = [
  (e) => {
    for (const o of e.overlaps) o.paths = [];
  },
  (e) => {
    for (const p of e.prs) {
      if (p.red) p.red = p.red.slice(0, 1);
      if (p.conflicted) p.conflicted = p.conflicted.slice(0, 3);
    }
  },
  (e) => {
    for (const i of e.inherited) i.sig = i.sig.slice(0, 40);
  },
];

const overBudget = (e) => Buffer.byteLength(JSON.stringify(e)) > BUDGET_BYTES;

function fitBudget(envelope) {
  for (const trim of TRIMS) {
    if (!overBudget(envelope)) break;
    trim(envelope);
    envelope.trimmed = true;
  }
  return envelope;
}
