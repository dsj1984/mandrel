/**
 * One-shot baseline refresh acknowledgment, scoped to the rows a tagged
 * commit actually refreshed.
 *
 * @module lib/orchestration/check-baselines/phases/refresh-ack
 */

import { resolveKindRefreshOverrides } from '../../../baselines/env-overrides.js';
import {
  readBaseFromGit,
  readRangeCommitsTouchingFile,
} from '../../../baselines/git-base.js';
import { getKindModule } from '../../../baselines/kernel.js';
import { Logger } from '../../../Logger.js';
import { applyTolerance } from './compare.js';
import { DEFAULT_BASELINE_PATHS } from './parse-args.js';

/** Commit-subject substring that acknowledges a deliberate refresh. */
const REFRESH_TAG = 'baseline-refresh:';

function resolveBaselinePath(kind, gateBlock) {
  const configured =
    typeof gateBlock?.baselinePath === 'string' && gateBlock.baselinePath.length
      ? gateBlock.baselinePath
      : null;
  return configured ?? DEFAULT_BASELINE_PATHS[kind] ?? null;
}

/**
 * Refresh trigger: env `<KIND>_REFRESH=1`, or a commit in `<baseRef>..HEAD`
 * whose subject contains the tag (a substring, so commitlint still passes) and
 * whose diff touches the kind's baseline. One-shot: after merge the tag leaves
 * the range. A kind with no known baseline path skips the commit arm.
 *
 * @returns {{ triggered: boolean, reasons: string[], envAcknowledged: boolean,
 *   refreshCommits: { sha: string, subject: string }[], baselinePath: string | null }}
 */
function resolveRefreshTrigger({ kind, gateBlock, cmp, cwd, env }) {
  const reasons = [];
  const { acknowledged: envAcknowledged, overrides } =
    resolveKindRefreshOverrides(kind, env);
  if (envAcknowledged) reasons.push(...overrides);

  const baselinePath = resolveBaselinePath(kind, gateBlock);
  const refreshCommits = [];
  const baseRef = cmp?.baseRef ?? null;
  if (baseRef && typeof baselinePath === 'string' && baselinePath.length) {
    const commits = readRangeCommitsTouchingFile(baseRef, baselinePath, {
      cwd,
    });
    for (const commit of commits) {
      if (!commit.subject.includes(REFRESH_TAG)) continue;
      refreshCommits.push(commit);
      reasons.push(
        `refresh commit "${commit.subject}" (subject contains ${JSON.stringify(REFRESH_TAG)}, touches ${baselinePath})`,
      );
    }
  }

  return {
    triggered: reasons.length > 0,
    reasons,
    envAcknowledged,
    refreshCommits,
    baselinePath,
  };
}

/**
 * Baseline rows at a ref; `null` (acknowledge nothing) when unreadable. An
 * absent blob reads as `{ rows: [] }` so a baseline-creating commit's `sha^`
 * read still works.
 *
 * @returns {{ rows: Array<object> }|null}
 */
function readRowsAtRef(ref, baselinePath, cwd) {
  let raw;
  try {
    raw = readBaseFromGit(ref, baselinePath, { cwd });
  } catch {
    return null;
  }
  if (raw === null) return { rows: [] };
  try {
    const payload = JSON.parse(raw);
    return Array.isArray(payload?.rows) ? { rows: payload.rows } : null;
  } catch {
    return null;
  }
}

/**
 * Row keys the tagged commit itself rewrote (`sha^ → sha`, no tolerance). The
 * blob at the commit is a whole-file snapshot that also carries rows earlier
 * untagged commits lowered; only this diff attributes a row to the commit.
 *
 * @returns {Set<string>|null} null (acknowledge nothing) when unusable.
 */
function keysTouchedByCommit({ mod, rowsAtSha, rowsAtParent }) {
  try {
    const result = mod.compare({ rows: rowsAtSha }, { rows: rowsAtParent });
    return new Set(
      [
        ...(result?.regressions ?? []),
        ...(result?.improvements ?? []),
        ...(result?.additions ?? []),
      ].map((entry) => entry.key),
    );
  } catch {
    return null;
  }
}

/**
 * Classify head rows against a refresh commit's rows with the kind's own
 * `compare()` and tolerance. Keys always come out of `compare()`: `keyField`
 * is not the compare key (CRAP keys `path::method@startLine`). `ok` =
 * no worse since refresh; `drifted` = worse; additions are in neither.
 *
 * @returns {{ ok: string[], drifted: string[] } | null} null when the
 *   classifier is unusable, which acknowledges nothing.
 */
function classifyAgainstRefresh({ mod, headRows, refreshRows, tolerance }) {
  try {
    const result = mod.compare({ rows: headRows }, { rows: refreshRows });
    const tolerated = applyTolerance(
      {
        regressions: result?.regressions ?? [],
        improvements: result?.improvements ?? [],
        unchanged: result?.unchanged ?? [],
        additions: result?.additions ?? [],
      },
      tolerance ?? null,
    );
    return {
      ok: [...tolerated.improvements, ...tolerated.unchanged].map((r) => r.key),
      drifted: tolerated.regressions.map((r) => r.key),
    };
  } catch {
    return null;
  }
}

/**
 * Regression keys a tagged commit acknowledges: in its blob, not drifted worse
 * since, and actually rewritten by that commit. Fails closed at every step.
 *
 * @returns {Set<string>}
 */
function acknowledgeableKeys({
  kind,
  headBaseline,
  refreshCommits,
  baselinePath,
  cwd,
  tolerance,
}) {
  const acknowledgeable = new Set();
  if (refreshCommits.length === 0) return acknowledgeable;
  if (typeof baselinePath !== 'string' || baselinePath.length === 0)
    return acknowledgeable;

  let mod;
  try {
    mod = getKindModule(kind);
  } catch {
    return acknowledgeable;
  }
  if (typeof mod?.compare !== 'function') return acknowledgeable;

  const headRows = Array.isArray(headBaseline?.rows) ? headBaseline.rows : [];
  // Newest-first: an older refresh never reopens a key a newer one ruled on.
  const decided = new Set();
  for (const { sha } of refreshCommits) {
    const atSha = readRowsAtRef(sha, baselinePath, cwd);
    const atParent = readRowsAtRef(`${sha}^`, baselinePath, cwd);
    if (atSha === null || atParent === null) continue;
    const touched = keysTouchedByCommit({
      mod,
      rowsAtSha: atSha.rows,
      rowsAtParent: atParent.rows,
    });
    if (touched === null) continue;
    const verdict = classifyAgainstRefresh({
      mod,
      headRows,
      refreshRows: atSha.rows,
      tolerance,
    });
    if (verdict === null) continue;
    for (const key of verdict.ok) {
      if (decided.has(key) || !touched.has(key)) continue;
      decided.add(key);
      acknowledgeable.add(key);
    }
    for (const key of verdict.drifted) decided.add(key);
  }
  return acknowledgeable;
}

function partitionRegressions(regressions, isAcknowledgeable) {
  const acknowledged = [];
  const kept = [];
  for (const reg of regressions) {
    if (isAcknowledgeable(reg)) acknowledged.push(reg);
    else kept.push(reg);
  }
  return { acknowledged, kept };
}

function logAcknowledgment({ kind, reasons, acknowledged, kept }) {
  const held =
    kept.length > 0
      ? `${kept.length} regression(s) NOT acknowledged (outside the refreshed rows, or drifted further after the refresh) and still fail the gate; `
      : '';
  Logger.warn(
    `[${kind}] ⚠ ${reasons.join('; ')} — ` +
      `${acknowledged.length} regression(s) acknowledged for this run only; ` +
      `${held}floors still enforced. This does not persist: once the refresh is ` +
      'the new base the ratchet re-enforces at full strength.',
  );
}

/**
 * When triggered, demote acknowledged regressions to `unchanged` for this run
 * only (floors still apply; nothing persists). The commit-tag arm is scoped to
 * rewritten rows; the env arm stays whole-run, as an explicit operator act
 * with no commit to anchor to.
 *
 * @returns {{ compareOutput: object, acknowledged: boolean, acknowledgedKeys: string[] }}
 */
export function applyRefreshAcknowledgment(kind, compareOutput, ctx) {
  const trigger = resolveRefreshTrigger({ ...ctx, kind });
  if (!trigger.triggered || compareOutput.regressions.length === 0) {
    return { compareOutput, acknowledged: false, acknowledgedKeys: [] };
  }

  let isAcknowledgeable;
  if (trigger.envAcknowledged) {
    isAcknowledgeable = () => true;
  } else {
    const keys = acknowledgeableKeys({
      kind,
      headBaseline: ctx.headBaseline,
      refreshCommits: trigger.refreshCommits,
      baselinePath: trigger.baselinePath,
      cwd: ctx.cwd,
      tolerance: ctx.gateBlock?.tolerance ?? null,
    });
    isAcknowledgeable = (reg) => keys.has(reg.key);
  }

  const { acknowledged, kept } = partitionRegressions(
    compareOutput.regressions,
    isAcknowledgeable,
  );
  if (acknowledged.length === 0) {
    return { compareOutput, acknowledged: false, acknowledgedKeys: [] };
  }

  logAcknowledgment({ kind, reasons: trigger.reasons, acknowledged, kept });

  return {
    acknowledged: true,
    acknowledgedKeys: acknowledged.map((reg) => reg.key),
    compareOutput: {
      ...compareOutput,
      regressions: kept,
      unchanged: [...compareOutput.unchanged, ...acknowledged],
    },
  };
}
