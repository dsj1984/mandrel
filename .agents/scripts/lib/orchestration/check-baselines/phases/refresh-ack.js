/**
 * refresh-ack.js — the one-shot baseline refresh acknowledgment (Story #5179).
 *
 * Extracted from `evaluate.js`, where it grew from a bundle-size env flag
 * (Story #151) through a maintainability env-or-commit-tag pair (Story #4731)
 * into the kind-generic trigger (Story #4802). Story #5179 narrowed the
 * commit-tag arm from a whole-run blanket to the rows the tagged commit
 * actually refreshed, which is enough logic to own its own module.
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

/** Default refresh-tag substring when the gate omits `refreshTag`. */
const DEFAULT_REFRESH_TAG = 'baseline-refresh:';

function resolveBaselinePath(kind, gateBlock) {
  const configured =
    typeof gateBlock?.baselinePath === 'string' && gateBlock.baselinePath.length
      ? gateBlock.baselinePath
      : null;
  return configured ?? DEFAULT_BASELINE_PATHS[kind] ?? null;
}

function resolveRefreshTag(gateBlock) {
  return typeof gateBlock?.refreshTag === 'string' &&
    gateBlock.refreshTag.length
    ? gateBlock.refreshTag
    : DEFAULT_REFRESH_TAG;
}

/**
 * Resolve the one-shot refresh trigger for any ratcheted kind. Two paths, either
 * of which acknowledges:
 *
 *   1. Env parity: `<KIND>_REFRESH=1` (the manual override) — upper-snaked, so
 *      the two pre-existing names (`BUNDLE_SIZE_REFRESH`,
 *      `MAINTAINABILITY_REFRESH`) keep working unchanged.
 *   2. Commit tag: a commit in the compared range `<baseRef>..HEAD` whose
 *      subject contains the configured `refreshTag` AND whose diff touches that
 *      kind's baseline file. One-shot by construction — once merged, the
 *      refreshed baseline becomes the base and the tag leaves the range.
 *
 * The tag is matched as a plain substring of a conventional commit subject, so
 * commitlint stays satisfied (e.g. `chore(baselines): baseline-refresh: …`).
 *
 * The two arms are reported separately because Story #5179 scopes them
 * differently: see `applyRefreshAcknowledgment`.
 *
 * Fails closed: a kind whose baseline path is neither configured nor present in
 * `DEFAULT_BASELINE_PATHS` simply skips the commit-tag path rather than
 * throwing, leaving that arm un-acknowledged.
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
    const refreshTag = resolveRefreshTag(gateBlock);
    const commits = readRangeCommitsTouchingFile(baseRef, baselinePath, {
      cwd,
    });
    for (const commit of commits) {
      if (!commit.subject.includes(refreshTag)) continue;
      refreshCommits.push(commit);
      reasons.push(
        `refresh commit "${commit.subject}" (subject contains ${JSON.stringify(refreshTag)}, touches ${baselinePath})`,
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
 * Read the baseline rows as of one git ref.
 *
 * Returns `null` — never throws and never a partial row set — when the blob is
 * unreadable or unparseable at that ref. The caller treats `null` as "this
 * commit acknowledges nothing", which keeps the ratchet at full strength rather
 * than acknowledging on a guess.
 *
 * A blob that is genuinely ABSENT at the ref reads as `{ rows: [] }`, not
 * `null`. The distinction only matters for the `sha^` read below: the commit
 * that CREATES a baseline has no blob at its parent, and treating that as
 * unreadable would make the first refresh of any kind acknowledge nothing.
 * `readBaseFromGit` already draws exactly this line — `null` for git's exit
 * 128 "path does not exist in this revision", a throw for everything else — so
 * the two cases are distinguishable rather than guessed at.
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
 * Which row identities did the tagged commit itself REWRITE (Story #5277)?
 *
 * This is the half Story #5179 left open. It scoped the acknowledgment to the
 * rows present in the baseline blob *at* the tagged commit — but a blob is a
 * whole-file snapshot, so it also contains every row an EARLIER, untagged
 * commit on the same branch lowered. Such a row is present at the refresh
 * commit and unchanged at head, so it classified as `ok` and was acknowledged
 * by a commit that never touched it. The observed shape: a branch lowers a
 * maintainability row while refactoring, later refreshes an unrelated CRAP row
 * with a `baseline-refresh:` commit, and the first regression is waved through.
 *
 * Diffing `sha^ → sha` is what makes the acknowledgment a statement about the
 * COMMIT rather than about the branch's accumulated state. No tolerance is
 * applied: any movement at all means the commit re-scored that identity, which
 * is the only question being asked here.
 *
 * @returns {Set<string>|null} null when the diff is unusable, which
 *   acknowledges nothing from this commit.
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
 * Classify the head rows against one refresh commit's rows, using the kind's
 * own classifier and the gate's own tolerance.
 *
 * Row identity is deliberately never derived here. A kind's `keyField` names
 * the row property the kind is *about*, which is not always its compare key:
 * CRAP declares `keyField: 'path'` but keys rows as `path::method@startLine`,
 * because one file holds many methods. Reading `row[keyField]` would produce a
 * key matching no regression, silently acknowledging nothing for that kind.
 * `compare()` is the one thing that knows a kind's key, so every key here comes
 * back out of it — the same reason direction and tolerance are delegated rather
 * than reimplemented.
 *
 * That also collapses both tests into one classification:
 *
 *   - `regressions` — present in both, worse at head: post-refresh drift.
 *   - `improvements` / `unchanged` — present in both, no worse: the rows this
 *     commit vouches for.
 *   - `additions` — present at head but absent from the refresh blob, i.e.
 *     never refreshed by this commit, so deliberately in neither set.
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
 * Which regression keys are acknowledgeable by the tagged commits (Story #5179)?
 *
 * The acknowledgment is a statement about what a refresh commit re-scored, so a
 * key is acknowledgeable only when the commit both covered it and recorded a
 * value the head has not since fallen below. Both tests come out of
 * `classifyAgainstRefresh` above:
 *
 *   1. **Row membership** — a key absent from the refresh blob lands in
 *      `additions`, never in `ok`. This was the larger half of the leak: a
 *      single tagged commit cleared regressions on rows in directories it never
 *      touched.
 *   2. **No post-refresh drift** — a key worse at head than the commit recorded
 *      lands in `drifted`. Drift from commits landing AFTER the refresh is what
 *      "the baseline commit must be the branch's last score-moving commit" asks
 *      for by convention and nothing enforced.
 *   3. **The commit actually rewrote it** (Story #5277) — `keysTouchedByCommit`
 *      diffs `sha^ → sha`. Tests 1 and 2 both read the blob AT the commit,
 *      which is a whole-file snapshot and therefore also carries rows an
 *      earlier untagged commit lowered; those rows passed both tests without
 *      the tagged commit having touched them.
 *
 * Fails closed at every step: an unreadable blob, a missing `compare`, or a
 * classifier that throws contributes nothing, so those regressions stand.
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
  // `readRangeCommitsTouchingFile` returns newest-first, and a key the newest
  // refresh already ruled on is not reopened by an older one: the newest is the
  // state the branch is asking to be held to.
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
 * One-shot baseline refresh/acknowledge for any ratcheted kind. When triggered,
 * demote acknowledged head-vs-base regressions to `unchanged` for this run only
 * — floors still apply, so a row below its floor still breaches. The trigger is
 * read fresh every run and never persisted: post-merge the refreshed baseline is
 * the new base and the tag leaves the range, so the ratchet returns to full
 * strength automatically.
 *
 * The two trigger arms are scoped differently, deliberately:
 *
 * - **Commit tag** — scoped to the rows the tagged commits actually rewrote,
 *   per `acknowledgeableKeys`. Before Story #5179 this cleared every regression
 *   in the range, so a branch merged carrying a stale row and the ratchet ran
 *   loose on that file; the failure recurred six times. Story #5277 closed the
 *   remainder: the scoping read the blob at the tagged commit, which still
 *   carried rows an earlier untagged commit had lowered.
 * - **Env parity** (`<KIND>_REFRESH=1`) — stays whole-run. There is no commit to
 *   anchor row-scoping to, and setting the variable is an explicit, deliberate
 *   operator act rather than a signal inferred from history.
 *
 * A no-op absent a trigger, so an unacknowledged run of any kind reports its
 * regressions exactly as before.
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
