/**
 * base-sync-probe.js — under `delivery.close.baseSync: "on-conflict"`, may a
 * Story skip merging `origin/<baseBranch>`? Only a conflict-free merge whose
 * incoming and Story paths are disjoint skips: git then takes every path
 * from the one side that changed it and never runs a merge driver. Any
 * other answer, or any git failure, means merge as usual.
 */

import { resolveConfig } from '../config-resolver.js';
import {
  gitFetchWithRetry as defaultGitFetchWithRetry,
  gitSpawn as defaultGitSpawn,
} from '../git-utils.js';
import { syncBranchFromBase } from './sync-from-base.js';

function names(res) {
  return (res.stdout ?? '')
    .toString()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `merge-tree` exits 1 on a conflict; any other non-zero is an old git. */
function mergeTreeVerdict(spawn, cwd, origin) {
  const res = spawn(
    cwd,
    'merge-tree',
    '--write-tree',
    '--no-messages',
    origin,
    'HEAD',
  );
  if (res.status === 0) return null;
  return res.status === 1 ? 'conflict' : 'unsupported';
}

/** Raw, rename-free paths each side changed since the merge-base. */
function sidePaths(spawn, cwd, origin) {
  const mb = spawn(cwd, 'merge-base', origin, 'HEAD');
  const mergeBase = (mb.stdout ?? '').toString().trim();
  if (mb.status !== 0 || mergeBase.length === 0) return null;
  const diff = (to) =>
    spawn(cwd, 'diff', '--name-only', '--no-renames', mergeBase, to);
  const incoming = diff(origin);
  const story = diff('HEAD');
  if (incoming.status !== 0 || story.status !== 0) return null;
  return { mergeBase, incoming: names(incoming), story: names(story) };
}

/**
 * @param {{ cwd: string, baseBranch: string, gitSpawn?: typeof defaultGitSpawn, gitFetchWithRetry?: typeof defaultGitFetchWithRetry }} opts
 * @returns {Promise<
 *   | { skip: true, incoming: number, mergeBase: string }
 *   | { skip: false, reason: 'fetch-failed'|'already-current'|'conflict'|'unsupported'|'intersects', path?: string }
 * >}
 */
export async function probeBaseSync({
  cwd,
  baseBranch,
  gitSpawn: spawn = defaultGitSpawn,
  gitFetchWithRetry = defaultGitFetchWithRetry,
}) {
  const origin = `origin/${baseBranch}`;
  const fetch = await gitFetchWithRetry(cwd, 'origin', baseBranch);
  if (fetch.status !== 0) return { skip: false, reason: 'fetch-failed' };
  const current = spawn(cwd, 'merge-base', '--is-ancestor', origin, 'HEAD');
  if (current.status === 0) return { skip: false, reason: 'already-current' };
  const verdict = mergeTreeVerdict(spawn, cwd, origin);
  if (verdict) return { skip: false, reason: verdict };
  const sides = sidePaths(spawn, cwd, origin);
  if (!sides) return { skip: false, reason: 'unsupported' };
  const story = new Set(sides.story);
  const shared = sides.incoming.find((p) => story.has(p));
  if (shared) return { skip: false, reason: 'intersects', path: shared };
  return {
    skip: true,
    incoming: sides.incoming.length,
    mergeBase: sides.mergeBase,
  };
}

/** One human line for a probe answer, naming the decision and its reason. */
export function describeProbe(probe) {
  if (probe.skip) {
    return `skipped — merge is conflict-free and shares no path (${probe.incoming} incoming path(s))`;
  }
  const at = probe.path ? ` (${probe.path})` : '';
  return `merging — probe answered ${probe.reason}${at}`;
}

/**
 * The `baseSync` record the close envelope carries for a sync that ran.
 *
 * @param {{ mode: string, probe: object|null, kind?: string, changedPaths?: string[] }} args
 * @returns {{ mode: string, outcome: 'merged'|'already-current'|'skipped', reason: string, incoming: number }}
 */
function baseSyncDecision({ mode, probe, kind, changedPaths }) {
  if (probe?.skip) {
    return {
      mode,
      outcome: 'skipped',
      reason: 'conflict-free',
      incoming: probe.incoming,
    };
  }
  return {
    mode,
    outcome: kind === 'noop-already-current' ? 'already-current' : 'merged',
    reason: probe?.reason ?? mode,
    incoming: Array.isArray(changedPaths) ? changedPaths.length : 0,
  };
}

/** `delivery.close.baseSync`; an unresolvable config keeps today's `always`. */
function configuredMode(resolveConfigImpl, cwd) {
  try {
    return resolveConfigImpl({ cwd })?.delivery?.close?.baseSync ?? 'always';
  } catch {
    return 'always';
  }
}

/**
 * Close's sync: `syncBranchFromBase`, preceded under `on-conflict` by the
 * probe. A skip is a `synced` result of kind `skipped` that carries the
 * merge-base as `baselineRef`; every result carries its `decision`.
 *
 * @param {{ cwd: string, baseBranch: string, log?: (tag: string, msg: string) => void, resolveConfigImpl?: typeof resolveConfig, probeImpl?: typeof probeBaseSync, syncImpl?: typeof syncBranchFromBase }} opts
 * @returns {Promise<object>} `syncBranchFromBase`'s result plus `decision`.
 */
export async function syncFromBaseByMode({
  cwd,
  baseBranch,
  log = () => {},
  resolveConfigImpl = resolveConfig,
  probeImpl = probeBaseSync,
  syncImpl = syncBranchFromBase,
}) {
  const mode = configuredMode(resolveConfigImpl, cwd);
  const probe =
    mode === 'on-conflict' ? await probeImpl({ cwd, baseBranch }) : null;
  if (probe) log('SYNC', `baseSync on-conflict: ${describeProbe(probe)}`);
  if (probe?.skip) {
    const decision = baseSyncDecision({ mode, probe });
    const base = { changedPaths: [], preSyncHead: null };
    return {
      synced: true,
      kind: 'skipped',
      ...base,
      baselineRef: probe.mergeBase,
      decision,
    };
  }
  const result = await syncImpl({ cwd, baseBranch, log });
  return { ...result, decision: baseSyncDecision({ mode, probe, ...result }) };
}

/**
 * A handoff re-run's base-merge skip under `on-conflict`. Only a re-run (an
 * earlier invocation settled the step, `state.baseMergeSettled`) probes; a
 * skip pins the handoff's close gates to the merge-base, sets the envelope's
 * `baseMerge` and returns the step detail; anything else returns `null` and the step merges as usual.
 *
 * @param {{ config: object, state: object, cwd: string, baseBranch: string, probeBaseSync?: typeof probeBaseSync, progress: Function }} ctx
 * @returns {Promise<string|null>}
 */
export async function handoffRerunSkip(ctx) {
  const mode = ctx.config?.delivery?.close?.baseSync;
  if (mode !== 'on-conflict' || !ctx.state.baseMergeSettled) return null;
  const probe = await (ctx.probeBaseSync ?? probeBaseSync)({
    cwd: ctx.cwd,
    baseBranch: ctx.baseBranch,
  });
  ctx.progress('base-merge', `baseSync on-conflict: ${describeProbe(probe)}`);
  if (!probe.skip) return null;
  ctx.baselineRef = probe.mergeBase;
  ctx.baseMergeEnvelope = {
    baseMerge: { skipped: 'conflict-free', incoming: probe.incoming },
  };
  return `conflict-free and disjoint: ${probe.incoming} incoming path(s) from origin/${ctx.baseBranch} not merged`;
}
