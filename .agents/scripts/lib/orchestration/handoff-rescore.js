/**
 * handoff-rescore.js — the handoff runs close's own duplication re-score
 * before any credit, so close's later re-score over the same tree no-ops;
 * and names the duplication rows a branch raised in a post-capture finding.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getQuality } from '../config-resolver.js';
import { DEFAULT_BASELINE_REL_PATH } from './story-close/duplication-close-rescore.js';

/** Re-score reasons that settle `skipped`; every other reason is an error. */
const SKIP_REASONS = new Set(['gate-disabled', 'no-changed-files']);

const pct = (v) => (v === null || v === undefined ? 'none' : `${v}%`);

/**
 * @param {Array<{ path: string, before: number|null, after: number|null }>} moved
 * @returns {string}
 */
function describeMoved(moved) {
  return moved
    .map((m) => `${m.path} ${pct(m.before)} → ${pct(m.after)}`)
    .join(', ');
}

/** @returns {{ outcome: string, detail: string }} */
function settle(ctx, result, readHead) {
  if (result?.committed) {
    ctx.head = readHead() ?? ctx.head;
    return {
      outcome: 'ran',
      detail: `re-scored ${describeMoved(result.moved ?? [])}; committed untagged ${result.sha}`,
    };
  }
  if (result?.reason === 'unchanged') {
    return { outcome: 'ran', detail: 'unchanged' };
  }
  if (SKIP_REASONS.has(result?.reason)) {
    return { outcome: 'skipped', detail: result.reason };
  }
  return { outcome: 'error', detail: result?.reason ?? 'no result' };
}

/**
 * Run the re-score once per HEAD; best-effort, it never stops the run. An
 * `error` records nothing, so a re-run retries.
 *
 * @param {object} ctx the handoff context; `ctx.head` moves on a commit and
 *   `ctx.runDuplicationRescore` is close's `runDuplicationCloseRescore`.
 * @param {() => string|null} readHead
 * @returns {Promise<{ outcome: string, detail: string }>}
 */
export async function rescoreDuplication(ctx, readHead) {
  const prior = ctx.state.duplicationRescore;
  if (prior?.head === ctx.head) {
    return {
      outcome: 'skipped',
      detail: `already re-scored at ${ctx.head.slice(0, 12)}`,
    };
  }
  const log = (m) => ctx.progress('duplication-rescore', m);
  let result;
  try {
    result = await ctx.runDuplicationRescore({
      cwd: ctx.cwd,
      worktreePath: ctx.cwd,
      storyId: ctx.storyId,
      baseBranch: ctx.baseBranch,
      storyBranch: ctx.branch,
      baselineRef: ctx.baselineRef,
      config: ctx.config,
      logger: { info: log, warn: log },
    });
  } catch (err) {
    return { outcome: 'error', detail: `threw: ${err?.message ?? err}` };
  }
  const settled = settle(ctx, result, readHead);
  if (settled.outcome !== 'error') {
    ctx.state.duplicationRescore = {
      head: ctx.head,
      partners: result?.partners ?? {},
    };
  }
  return settled;
}

/** @returns {string} the configured duplication baseline path. */
function baselineRelPath(config) {
  try {
    return (
      getQuality(config)?.gates?.duplication?.baselinePath ??
      DEFAULT_BASELINE_REL_PATH
    );
  } catch {
    return DEFAULT_BASELINE_REL_PATH;
  }
}

/** Path → percentage; `null` on any read or parse failure. */
function rowsOf(text) {
  try {
    const rows = JSON.parse(text)?.rows;
    if (!Array.isArray(rows)) return null;
    return new Map(rows.map((r) => [r?.path, r?.percentage ?? null]));
  } catch {
    return null;
  }
}

/**
 * The duplication rows the worktree's baseline raised over `baselineRef`,
 * each with its recorded clone partners. Descriptive only: check-baselines
 * stays the verdict, so an unreadable side yields `[]`.
 *
 * @param {object} ctx the handoff context.
 * @param {{ baselineRef?: string, limit: number, readFile?: (p: string) => string }} opts
 * @returns {string[]}
 */
function raisedDuplicationRows(
  ctx,
  {
    baselineRef = `origin/${ctx.baseBranch}`,
    limit,
    readFile = (p) => fs.readFileSync(p, 'utf8'),
  },
) {
  const relPath = baselineRelPath(ctx.config);
  const base = ctx.git(ctx.cwd, 'show', `${baselineRef}:${relPath}`);
  const baseRows = base?.status === 0 ? rowsOf(base.stdout ?? '') : null;
  let headRows = null;
  try {
    headRows = rowsOf(readFile(path.resolve(ctx.cwd, relPath)));
  } catch {
    headRows = null;
  }
  if (!baseRows || !headRows) return [];
  const partners = ctx.state.duplicationRescore?.partners ?? {};
  const lines = [];
  for (const [file, head] of headRows) {
    const before = baseRows.get(file) ?? null;
    if (head === null || (before !== null && head <= before)) continue;
    const clones = partners[file]?.length
      ? ` (clones: ${partners[file].join(', ')})`
      : '';
    lines.push(`${file} ${pct(before)} → ${pct(head)}${clones}`);
  }
  return lines.slice(0, limit);
}

/**
 * The post-capture finding's suffix naming raised duplication rows; `''` for
 * a gate that does not score duplication or when nothing was raised.
 *
 * @param {object} ctx
 * @param {{ scoresDuplication?: boolean, baselineRef?: string }} failed
 * @param {number} limit
 * @returns {string}
 */
export function raisedDuplicationSuffix(ctx, failed, limit) {
  if (!failed.scoresDuplication) return '';
  const raised = raisedDuplicationRows(ctx, {
    baselineRef: failed.baselineRef,
    limit,
  });
  return raised.length > 0
    ? `; raised duplication rows: ${raised.join('; ')}`
    : '';
}
