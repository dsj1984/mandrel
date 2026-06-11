/**
 * auto-refresh-runner.js — bounded baseline auto-refresh at story-close
 * (Story #1398, Epic #1386; rerouted to `refreshBaseline()` by Story
 * #2205; collapsed onto the single `runRefreshCommit` funnel by Story
 * #4017).
 *
 * Runs *after* `runPreMergeGatesWithAttribution` returns `{ status: 'ok' }`
 * and *before* the merge into `epic/<id>`. For each baseline kind
 * (maintainability, crap) the runner:
 *
 *   1. Snapshots the prior on-disk envelope (so cap evaluation can compare
 *      regenerated rows against the pre-refresh baseline).
 *   2. Delegates the refresh → stage → commit sequence to
 *      `runRefreshCommit()` (`baseline-attribution/phases/refresh-commit.js`)
 *      — the **single** story-close refresh funnel — injecting a `capCheck`
 *      that re-reads the refreshed envelope and evaluates the row deltas
 *      against the configured caps via {@link evaluateAutoRefresh}.
 *
 *   - **Under-cap path** — the funnel emits one canonical commit
 *     `chore(baselines): refresh <kind> for story-<id>` per kind that
 *     actually drifted. NO `--amend`, NO `--allow-empty`.
 *
 *   - **Over-cap path** — the funnel restores the kind's baseline file to
 *     HEAD; the runner appends a single `baseline-refresh-regression`
 *     friction signal to the per-Story NDJSON and returns
 *     `{ status: 'refused', ... }`.
 *
 *   - **Skipped paths** — `enabled: false` in `quality.autoRefresh`, or
 *     no configured kind produced drift. The runner returns
 *     `{ status: 'skipped', reason }` without touching the branch tip.
 *
 * Each-kind-once contract (Story #4017): the caller threads the close
 * cycle's shared `cycleState` (created in `runGatesAndRefresh`) into the
 * funnel, so a kind already refreshed by the gate-failure attribution
 * retry (`gate-failure.js` → `runRefreshCommit`) is **not re-scored or
 * re-committed** here — the funnel short-circuits on the idempotency
 * token. A clean close therefore computes each baseline kind exactly once
 * and emits at most one `chore(baselines): refresh` subject per kind.
 *
 * Dedup contract (AC3 — idempotent re-run):
 *   On re-entry after an over-cap refusal, the runner scans the per-Story
 *   `signals.ndjson` for any prior `baseline-refresh-regression` signal
 *   tagged `source.tool === 'auto-refresh-runner'` and skips the append if
 *   one exists. The on-disk friction-signal file therefore carries one row
 *   per (story, refusal-cause) regardless of how many times story-close
 *   runs.
 *
 * The runner is dependency-injection-friendly: every git invocation, every
 * fs touch, the refresh-service handle, the evaluator, and the signal
 * writer are injectable seams. Production callers omit the seams; tests
 * inject mocks.
 *
 * @see .agents/scripts/lib/baselines/refresh-service.js (the unified write path)
 * @see ./baseline-attribution/phases/refresh-commit.js (the commit funnel)
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadFile as defaultReaderLoadFile } from '../../baselines/reader.js';
import { refreshBaseline as defaultRefreshBaseline } from '../../baselines/refresh-service.js';
import {
  getBaselines as defaultGetBaselines,
  getQuality as defaultGetQuality,
} from '../../config-resolver.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import {
  appendSignal as defaultAppendSignal,
  forEachLine as defaultForEachLine,
} from '../../observability/signals-writer.js';
import {
  buildKindScorer,
  computeStoryDiffPaths,
  runRefreshCommit as defaultRunRefreshCommit,
} from './baseline-attribution-wiring.js';

const RUNNER_SOURCE_TOOL = 'auto-refresh-runner';
const FRICTION_CATEGORY = 'baseline-refresh-regression';

// ---------------------------------------------------------------------------
// Pure delta-cap evaluator (Story #1398; folded in from the deleted
// standalone evaluator module by Story #4017).
// ---------------------------------------------------------------------------

/**
 * Numeric guard — accepts finite numbers only. Strings, NaN, Infinity, null,
 * undefined all fail. The evaluator runs against scored rows produced by the
 * MI / CRAP scanners (which always emit numeric scores) and baseline rows
 * loaded from the on-disk JSON (which JSON-parses numeric fields), so a
 * non-finite value here signals upstream corruption — we exclude the row
 * conservatively rather than coercing.
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Index `baseline.mi` rows by `path` for O(1) lookup. Bad rows (missing
 * `path`, non-string `path`, non-finite `mi`) are skipped — their absence
 * causes the matching scored row to be treated as "new", which never blocks
 * auto-refresh.
 */
function indexMiBaseline(rows) {
  const byPath = new Map();
  if (!Array.isArray(rows)) return byPath;
  for (const row of rows) {
    if (!row || typeof row.path !== 'string' || row.path.length === 0) continue;
    if (!isFiniteNumber(row.mi)) continue;
    byPath.set(row.path, row);
  }
  return byPath;
}

/**
 * Index `baseline.crap` rows by `${file}::${method}` for O(1) lookup.
 * `startLine` is *not* part of the key — the scored row may have shifted
 * lines vs the baseline (legitimate refactor), and we want the closest match
 * by method name. When the same method appears multiple times in the same
 * file (e.g. nested helpers), we pick the closest startLine at lookup time.
 *
 * Bad rows (missing `file`/`method`, non-finite `crap`) are skipped — their
 * absence causes the matching scored row to be treated as "new".
 */
function indexCrapBaseline(rows) {
  const byMethod = new Map();
  if (!Array.isArray(rows)) return byMethod;
  for (const row of rows) {
    if (!row || typeof row.file !== 'string' || row.file.length === 0) {
      continue;
    }
    if (typeof row.method !== 'string' || row.method.length === 0) continue;
    if (!isFiniteNumber(row.crap)) continue;
    const key = `${row.file}::${row.method}`;
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key).push(row);
  }
  return byMethod;
}

/**
 * Pick the closest baseline candidate by `startLine` distance. When the
 * scored row's `startLine` is missing or all candidates have missing line
 * info, returns the first candidate — matches `baseline-attribution-wiring`'s
 * `diffCrapBaselines` resolution policy.
 */
function pickClosestBaseline(candidates, scoredStartLine) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const target = isFiniteNumber(scoredStartLine) ? scoredStartLine : 0;
  let best = candidates[0];
  let bestDist = Math.abs((best.startLine ?? 0) - target);
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i];
    const dist = Math.abs((c?.startLine ?? 0) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

/**
 * Evaluate every MI scored row against the MI cap. Returns the over-cap
 * subset; rows under the cap (or new) are simply omitted from the result.
 *
 * MI is higher-is-better, so drift = baseline.mi − scored.mi. A positive
 * drift is a regression; a drift greater than `miDropCap` breaches the cap.
 */
function evaluateMiRows({ scoredRows, baselineIndex, miDropCap }) {
  const overCap = [];
  if (!Array.isArray(scoredRows)) return overCap;
  for (const row of scoredRows) {
    if (!row || typeof row.path !== 'string' || row.path.length === 0) {
      continue;
    }
    if (!isFiniteNumber(row.mi)) continue;
    const baselineRow = baselineIndex.get(row.path);
    if (!baselineRow) continue; // new path — never breaches
    const drop = baselineRow.mi - row.mi;
    if (drop > miDropCap) {
      overCap.push({
        path: row.path,
        baseline: baselineRow.mi,
        scored: row.mi,
        delta: drop,
      });
    }
  }
  return overCap;
}

/**
 * Evaluate every CRAP scored row against the CRAP cap. Returns the over-cap
 * subset; rows under the cap (or new) are simply omitted from the result.
 *
 * CRAP is lower-is-better, so jump = scored.crap − baseline.crap. A positive
 * jump is a regression; a jump greater than `crapJumpCap` breaches the cap.
 */
function evaluateCrapRows({ scoredRows, baselineIndex, crapJumpCap }) {
  const overCap = [];
  if (!Array.isArray(scoredRows)) return overCap;
  for (const row of scoredRows) {
    if (!row || typeof row.file !== 'string' || row.file.length === 0) {
      continue;
    }
    if (typeof row.method !== 'string' || row.method.length === 0) continue;
    if (!isFiniteNumber(row.crap)) continue;
    const candidates = baselineIndex.get(`${row.file}::${row.method}`);
    const baselineRow = pickClosestBaseline(candidates, row.startLine);
    if (!baselineRow) continue; // new method — never breaches
    const jump = row.crap - baselineRow.crap;
    if (jump > crapJumpCap) {
      overCap.push({
        file: row.file,
        method: row.method,
        startLine: row.startLine,
        baseline: baselineRow.crap,
        scored: row.crap,
        delta: jump,
      });
    }
  }
  return overCap;
}

/**
 * Build the human-readable refusal reasons array. Stable formatting so the
 * friction-signal renderer (and unit tests) can pin the strings exactly.
 *
 * Each reason names the kind, the file/path/method, and the absolute delta
 * vs the cap. Numbers are formatted to 3 decimal places to match the
 * baseline JSON's float precision without trailing-zero noise.
 */
function buildRefusalReasons({ miOverCap, crapOverCap, caps }) {
  const reasons = [];
  for (const r of miOverCap) {
    reasons.push(
      `MI drop ${r.delta.toFixed(3)} > cap ${caps.miDropCap} on ${r.path} (baseline ${r.baseline.toFixed(3)} → scored ${r.scored.toFixed(3)})`,
    );
  }
  for (const r of crapOverCap) {
    reasons.push(
      `CRAP jump ${r.delta.toFixed(3)} > cap ${caps.crapJumpCap} on ${r.file}::${r.method} (baseline ${r.baseline.toFixed(3)} → scored ${r.scored.toFixed(3)})`,
    );
  }
  return reasons;
}

/**
 * Pure delta-cap evaluator. Decides whether the regenerated rows can be
 * silently committed (under-cap) or whether the close must refuse the
 * refresh and surface a `baseline-refresh-regression` friction signal
 * (over-cap).
 *
 * Cap semantics:
 *
 *   - MI is "higher is better". A *drop* (baseline.mi − scored.mi) greater
 *     than `miDropCap` breaches the cap. Improvements never breach.
 *   - CRAP is "lower is better". A *jump* (scored.crap − baseline.crap)
 *     greater than `crapJumpCap` breaches the cap. Improvements never
 *     breach.
 *   - Equality at the cap (delta === cap) is *under* the cap — the cap is
 *     the maximum allowed delta, not the strict maximum.
 *   - Missing baseline rows (path/method new in the scored set) never push
 *     `canAutoRefresh` to `false` and are not surfaced in the over-cap
 *     arrays.
 *
 * @param {object} input
 * @param {{
 *   mi?: Array<{ path: string, mi: number }>,
 *   crap?: Array<{ file: string, method: string, startLine?: number, crap: number }>,
 * }} input.scoredRows  Just-regenerated rows for the Story diff.
 * @param {{
 *   mi?: Array<{ path: string, mi: number }>,
 *   crap?: Array<{ file: string, method: string, startLine?: number, crap: number }>,
 * }} input.baseline    Previously committed rows.
 * @param {{ miDropCap: number, crapJumpCap: number }} input.caps
 *   Bounded delta caps (defaults: miDropCap=1.5, crapJumpCap=5 — see
 *   `.agents/docs/agentrc-reference.json` under `delivery.quality.autoRefresh`).
 * @returns {{
 *   canAutoRefresh: boolean,
 *   miOverCap:   Array<{ path: string, baseline: number, scored: number, delta: number }>,
 *   crapOverCap: Array<{ file: string, method: string, startLine?: number, baseline: number, scored: number, delta: number }>,
 *   refusalReasons: string[],
 * }}
 */
export function evaluateAutoRefresh({
  scoredRows = {},
  baseline = {},
  caps,
} = {}) {
  if (
    !caps ||
    !isFiniteNumber(caps.miDropCap) ||
    !isFiniteNumber(caps.crapJumpCap)
  ) {
    throw new TypeError(
      'evaluateAutoRefresh: caps.{miDropCap,crapJumpCap} must be finite numbers',
    );
  }

  const miBaselineIdx = indexMiBaseline(baseline?.mi);
  const crapBaselineIdx = indexCrapBaseline(baseline?.crap);

  const miOverCap = evaluateMiRows({
    scoredRows: scoredRows?.mi,
    baselineIndex: miBaselineIdx,
    miDropCap: caps.miDropCap,
  });
  const crapOverCap = evaluateCrapRows({
    scoredRows: scoredRows?.crap,
    baselineIndex: crapBaselineIdx,
    crapJumpCap: caps.crapJumpCap,
  });

  const canAutoRefresh = miOverCap.length === 0 && crapOverCap.length === 0;
  const refusalReasons = canAutoRefresh
    ? []
    : buildRefusalReasons({ miOverCap, crapOverCap, caps });

  return { canAutoRefresh, miOverCap, crapOverCap, refusalReasons };
}

// ---------------------------------------------------------------------------
// Runner plumbing
// ---------------------------------------------------------------------------

/**
 * Load + parse the baseline envelope at `absPath` via the injected
 * reader. Returns `null` when the file is missing, unreadable, or fails
 * schema validation — the caller treats null as "no prior, every row is
 * new" (the cap evaluator handles missing-prior gracefully).
 */
function readEnvelope({ absPath, kind, readerLoadFile }) {
  if (typeof absPath !== 'string' || absPath.length === 0) return null;
  try {
    const parsed = readerLoadFile(absPath, { kind });
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    return { rows: parsed.rows };
  } catch {
    return null;
  }
}

/**
 * Adapt the writer's CRAP row shape (`{path, method, startLine, crap}`) to
 * the evaluator's expectation (`{file, method, startLine, crap}`). The MI
 * evaluator already keys on `path`, so no adapter is required for MI rows.
 *
 * Pure.
 */
function adaptCrapRowsForEvaluator(rows) {
  return (rows ?? []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const { path: p, ...rest } = row;
    return typeof p === 'string' ? { ...rest, file: p } : { ...rest };
  });
}

/**
 * Filter rows to those whose path/file is in the Story's diff footprint.
 * Empty `storyDiffPaths` returns the input unchanged so interactive
 * re-runs (`story-close --skip-validation`) on already-merged branches
 * still evaluate every row.
 */
function filterToStoryDiff({ miRows, crapRows, storyDiffPaths }) {
  if (!Array.isArray(storyDiffPaths) || storyDiffPaths.length === 0) {
    return { mi: miRows ?? [], crap: crapRows ?? [] };
  }
  const scope = new Set(storyDiffPaths);
  const mi = (miRows ?? []).filter((r) => scope.has(r.path));
  const crap = (crapRows ?? []).filter((r) => scope.has(r.file));
  return { mi, crap };
}

/**
 * Check whether a `baseline-refresh-regression` signal tagged with the
 * runner's `source.tool === 'auto-refresh-runner'` already exists in the
 * Story's signals stream. Backs the AC3 idempotent-re-run contract.
 */
async function priorRefusalSignalExists({
  epicId,
  storyId,
  forEachLine = defaultForEachLine,
}) {
  let found = false;
  await forEachLine(epicId, storyId, (record) => {
    if (
      record &&
      typeof record === 'object' &&
      record.kind === 'friction' &&
      record.category === FRICTION_CATEGORY &&
      record?.source?.tool === RUNNER_SOURCE_TOOL
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * Compose the friction-signal record. Stable shape so the analyzer +
 * `diagnose-friction` pattern-matchers can pin against fixed inputs.
 */
function buildRefusalSignal({
  epicId,
  storyId,
  miOverCap,
  crapOverCap,
  refusalReasons,
  caps,
}) {
  return {
    kind: 'friction',
    timestamp: new Date().toISOString(),
    epicId,
    storyId,
    category: FRICTION_CATEGORY,
    source: { tool: RUNNER_SOURCE_TOOL },
    details: `Auto-refresh refused: ${refusalReasons.length} row(s) breach configured caps (miDropCap=${caps.miDropCap}, crapJumpCap=${caps.crapJumpCap}).`,
    refusalReasons,
    miOverCap,
    crapOverCap,
    caps: { miDropCap: caps.miDropCap, crapJumpCap: caps.crapJumpCap },
  };
}

function resolveBaselineAbs(cwd, p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

async function probeDedup({ epicId, storyId, forEachLine, logger }) {
  try {
    return await priorRefusalSignalExists({ epicId, storyId, forEachLine });
  } catch (err) {
    logger.warn?.(
      `[auto-refresh-runner] dedup probe failed: ${err?.message ?? err}`,
    );
    return false;
  }
}

async function maybeAppendRefusalSignal({
  dedup,
  epicId,
  storyId,
  verdict,
  caps,
  appendSignal,
  config,
  logger,
}) {
  if (dedup) return false;
  const signal = buildRefusalSignal({
    epicId,
    storyId,
    miOverCap: verdict.miOverCap,
    crapOverCap: verdict.crapOverCap,
    refusalReasons: verdict.refusalReasons,
    caps,
  });
  try {
    return await appendSignal({ epicId, storyId, signal, config });
  } catch (err) {
    logger.warn?.(
      `[auto-refresh-runner] friction signal append failed: ${err?.message ?? err}`,
    );
    return false;
  }
}

function resolveAutoRefreshDeps(deps) {
  return {
    logger: deps.logger ?? DefaultLogger,
    getQuality: deps.getQuality ?? defaultGetQuality,
    getBaselines: deps.getBaselines ?? defaultGetBaselines,
    evaluateAutoRefresh: deps.evaluateAutoRefresh ?? evaluateAutoRefresh,
    refreshBaseline: deps.refreshBaseline ?? defaultRefreshBaseline,
    scorerBuilder: deps.scorerBuilder ?? buildKindScorer,
    runRefreshCommit: deps.runRefreshCommit ?? defaultRunRefreshCommit,
    gitRunner: deps.gitRunner ?? { gitSpawn: defaultGitSpawn },
    fsImpl: deps.fsImpl ?? fs,
    appendSignal: deps.appendSignal ?? defaultAppendSignal,
    forEachLine: deps.forEachLine ?? defaultForEachLine,
    computeDiffPaths: deps.computeStoryDiffPaths ?? computeStoryDiffPaths,
    readerLoadFile: deps.readerLoadFile ?? defaultReaderLoadFile,
  };
}

/**
 * Build the per-kind `capCheck` closure the funnel invokes after drift is
 * staged and before the commit lands. Re-reads the refreshed envelope,
 * narrows to the Story diff (unless `quality.autoRefresh.scope === 'full'`),
 * and evaluates the single kind's rows against the configured caps with the
 * prior (pre-refresh) snapshot as the baseline.
 */
function buildCapCheck({
  kind,
  priorEnv,
  autoRefresh,
  caps,
  cwd,
  epicBranch,
  storyBranch,
  evaluate,
  gitRunner,
  computeDiffPaths,
  readerLoadFile,
}) {
  return ({ writePath }) => {
    const finalEnv = readEnvelope({ absPath: writePath, kind, readerLoadFile });
    const isMi = kind === 'maintainability';
    const finalRows = isMi
      ? (finalEnv?.rows ?? [])
      : adaptCrapRowsForEvaluator(finalEnv?.rows ?? []);
    const priorRows = isMi
      ? (priorEnv?.rows ?? [])
      : adaptCrapRowsForEvaluator(priorEnv?.rows ?? []);

    let scoped;
    if ((autoRefresh.scope ?? 'diff') === 'full') {
      scoped = isMi ? { mi: finalRows } : { crap: finalRows };
    } else {
      const storyDiffPaths = computeDiffPaths({
        cwd,
        epicBranch,
        storyBranch,
        gitRunner,
      });
      const filtered = filterToStoryDiff({
        miRows: isMi ? finalRows : [],
        crapRows: isMi ? [] : finalRows,
        storyDiffPaths,
      });
      scoped = isMi ? { mi: filtered.mi } : { crap: filtered.crap };
    }

    return evaluate({
      scoredRows: scoped,
      baseline: isMi ? { mi: priorRows } : { crap: priorRows },
      caps,
    });
  };
}

/**
 * Map a funnel failure string back onto the runner's historical failure
 * vocabulary so `phases/refresh.js` keeps logging the same reason labels.
 */
function classifyFunnelError(error) {
  return typeof error === 'string' && error.startsWith('refreshBaseline(')
    ? 'refresh-service-threw'
    : 'commit-failed';
}

/**
 * Aggregate per-kind refused verdicts into the single refusal envelope the
 * close pipeline consumes, appending the friction signal (dedup-aware,
 * AC3) as the publish step. The funnel already rolled the refused kinds'
 * files back to HEAD.
 */
async function publishRefusal({
  refusedVerdicts,
  caps,
  epicId,
  storyId,
  appendSignal,
  forEachLine,
  config,
  logger,
}) {
  const verdict = {
    miOverCap: refusedVerdicts.flatMap((v) => v.miOverCap ?? []),
    crapOverCap: refusedVerdicts.flatMap((v) => v.crapOverCap ?? []),
    refusalReasons: refusedVerdicts.flatMap((v) => v.refusalReasons ?? []),
  };
  const dedup = await probeDedup({ epicId, storyId, forEachLine, logger });
  const signalAppended = await maybeAppendRefusalSignal({
    dedup,
    epicId,
    storyId,
    verdict,
    caps,
    appendSignal,
    config,
    logger,
  });
  logger.info?.(
    `[auto-refresh-runner] refused — ${verdict.refusalReasons.length} cap breach(es); friction signal ${dedup ? 'already present (dedup)' : signalAppended ? 'appended' : 'append failed'}.`,
  );
  return {
    status: 'refused',
    refusalReasons: verdict.refusalReasons,
    signalAppended,
    dedup,
    miOverCap: verdict.miOverCap,
    crapOverCap: verdict.crapOverCap,
  };
}

/**
 * Bounded baseline auto-refresh. Delegates the per-kind refresh → stage →
 * commit mechanics to the single `runRefreshCommit` funnel; this function
 * owns only the config gating, the prior-envelope snapshot, the cap-check
 * closure, and the refusal publication.
 *
 * @param {object} args
 * @param {{ refreshedKinds?: Set<string>, lastRefreshSha?: string|null } | null} [args.cycleState]
 *   The close cycle's shared idempotency token (Story #4017). When the
 *   gate-failure attribution retry already refreshed a kind this cycle,
 *   the funnel short-circuits and the kind is not re-scored here.
 * @returns {Promise<
 *   | { status: 'committed', sha: string, files: string[], committed: Array<{ kind: string, sha: string }> }
 *   | { status: 'refused', refusalReasons: string[], signalAppended: boolean, dedup: boolean, miOverCap: Array, crapOverCap: Array }
 *   | { status: 'skipped', reason: string }
 *   | { status: 'failed', reason: string, detail?: string }
 * >}
 */
export async function runAutoRefresh({
  storyId,
  epicId,
  cwd,
  epicBranch,
  storyBranch,
  config,
  cycleState = null,
  deps = {},
} = {}) {
  const resolved = resolveAutoRefreshDeps(deps);
  const {
    logger,
    getQuality,
    getBaselines,
    evaluateAutoRefresh: evaluate,
    refreshBaseline,
    scorerBuilder,
    runRefreshCommit,
    gitRunner,
    fsImpl,
    appendSignal,
    forEachLine,
    computeDiffPaths,
    readerLoadFile,
  } = resolved;

  const autoRefresh = getQuality(config)?.autoRefresh;
  if (!autoRefresh || autoRefresh.enabled === false) {
    return { status: 'skipped', reason: 'disabled' };
  }
  const caps = {
    miDropCap: autoRefresh.miDropCap,
    crapJumpCap: autoRefresh.crapJumpCap,
  };

  const baselines = getBaselines(config);
  const kinds = [
    {
      kind: 'maintainability',
      abs: resolveBaselineAbs(cwd, baselines?.maintainability?.path),
    },
    { kind: 'crap', abs: resolveBaselineAbs(cwd, baselines?.crap?.path) },
  ].filter((k) => k.abs);

  const committed = [];
  const refusedVerdicts = [];
  let lastSha = '';

  for (const { kind, abs } of kinds) {
    // Snapshot the prior envelope BEFORE the funnel's refreshBaseline()
    // overwrites it — the cap evaluator compares against the pre-refresh
    // rows. Reader-routed: schema-validated via `reader.loadFile`.
    const priorEnv = readEnvelope({ absPath: abs, kind, readerLoadFile });
    const capCheck = buildCapCheck({
      kind,
      priorEnv,
      autoRefresh,
      caps,
      cwd,
      epicBranch,
      storyBranch,
      evaluate,
      gitRunner,
      computeDiffPaths,
      readerLoadFile,
    });

    const res = await runRefreshCommit({
      cwd,
      kind,
      storyId,
      epicBranch,
      storyBranch,
      config,
      cycleState,
      capCheck,
      refreshBaseline,
      scorerBuilder,
      getBaselines,
      getQuality,
      fsImpl,
      gitRunner,
      logger,
    });

    if (res.ok !== true) {
      return {
        status: 'failed',
        reason: classifyFunnelError(res.error),
        detail: res.error,
      };
    }
    if (res.refused) {
      refusedVerdicts.push(res.verdict);
      continue;
    }
    if (!res.skipped && res.sha) {
      committed.push({ kind, sha: res.sha });
      lastSha = res.sha;
    }
  }

  if (refusedVerdicts.length > 0) {
    return publishRefusal({
      refusedVerdicts,
      caps,
      epicId,
      storyId,
      appendSignal,
      forEachLine,
      config,
      logger,
    });
  }
  if (committed.length === 0) {
    return { status: 'skipped', reason: 'no-baseline-drift' };
  }
  return {
    status: 'committed',
    sha: lastSha,
    files: kinds.map((k) => k.abs),
    committed,
  };
}
