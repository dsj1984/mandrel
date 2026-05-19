/**
 * auto-refresh-runner.js — bounded baseline auto-refresh at story-close
 * (Story #1398, Epic #1386; rerouted to `refreshBaseline()` by Story
 * #2205, Epic #2173).
 *
 * Runs *after* `runPreMergeGatesWithAttribution` returns `{ status: 'ok' }`
 * and *before* the merge into `epic/<id>`. For each baseline kind
 * (maintainability, crap) the runner:
 *
 *   1. Snapshots the prior on-disk envelope (so cap evaluation can compare
 *      regenerated rows against the pre-refresh baseline).
 *   2. Calls `refreshBaseline({ kind, baseRef, headRef, fullScope: false,
 *      ... })` — the unified service walks the story-diff scope, scores
 *      the in-scope files, scope-merges with out-of-scope prior rows, and
 *      writes the envelope atomically.
 *   3. Re-reads the (now scope-merged) envelope and evaluates the rows
 *      against the configured caps via `evaluateAutoRefresh`.
 *
 *   - **Under-cap path** — stages the baseline file, runs
 *     `git diff --cached --exit-code`, and either:
 *       · empty diff → logs "no baseline drift to fold in" and skips the
 *         commit entirely; OR
 *       · non-empty diff → emits one canonical commit
 *         `chore(baselines): refresh <kind> for story-<id>`. NO `--amend`,
 *         NO `--allow-empty`.
 *
 *   - **Over-cap path** — restores the baseline files to HEAD (the staged
 *     drift is unstaged + working-tree-reverted) and appends a single
 *     `baseline-refresh-regression` friction signal to the per-Story
 *     NDJSON. The runner returns `{ status: 'refused', ... }`.
 *
 *   - **Skipped paths** — `enabled: false` in `quality.autoRefresh`,
 *     `refreshBaseline()` reports `wrote: false` for every configured
 *     kind, or staging produced an empty diff. The runner returns
 *     `{ status: 'skipped', reason }` without touching the branch tip.
 *
 * Story #2205 — every baseline write goes through `refreshBaseline()` in
 * `.agents/scripts/lib/baselines/refresh-service.js`. The legacy
 * `regenerateMainFromTree` + `writeScopeMergedBaseline` +
 * `loadPriorEnvelope` + `amendBaselinesIntoHead` chain is gone. The
 * `--amend` / `--allow-empty` shortcut is gone. The commit subject is
 * `chore(baselines): refresh <kind> for story-<id>` per the new
 * commit-hygiene contract (AC-8).
 *
 * Dedup contract (AC3 — idempotent re-run):
 *   On re-entry after an over-cap refusal, the runner scans the per-Story
 *   `signals.ndjson` for any prior `baseline-refresh-regression` signal
 *   tagged `source.tool === 'auto-refresh-runner'` and skips the append if
 *   one exists. The runner does not edit the on-disk file — it just doesn't
 *   write a duplicate. Two scenarios produce identical on-disk state:
 *
 *     - First run, over-cap → friction signal appended.
 *     - Second run, same caps + same diff → friction signal NOT re-appended.
 *
 *   The on-disk friction-signal file therefore carries one row per
 *   (story, refusal-cause) regardless of how many times story-close runs.
 *
 * The runner is dependency-injection-friendly: every git invocation, every
 * fs touch, the refresh-service handle, the evaluator, and the signal
 * writer are injectable seams. Production callers omit the seams; tests
 * inject mocks.
 *
 * @see .agents/scripts/lib/baselines/refresh-service.js (the unified write funnel)
 * @see .agents/scripts/lib/auto-refresh-baselines.js (evaluator)
 */

import fs from 'node:fs';
import path from 'node:path';
import { evaluateAutoRefresh as defaultEvaluateAutoRefresh } from '../../auto-refresh-baselines.js';
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
  stageAndCheckBaselineDrift,
} from './baseline-attribution-wiring.js';

const RUNNER_SOURCE_TOOL = 'auto-refresh-runner';
const FRICTION_CATEGORY = 'baseline-refresh-regression';

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
    return {
      $schema: `.agents/schemas/baselines/${kind}.schema.json`,
      kernelVersion: parsed.kernelVersion,
      generatedAt: parsed.generatedAt,
      rollup: parsed.rollup,
      rows: parsed.rows,
    };
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
export function adaptCrapRowsForEvaluator(rows) {
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

function resolveBaselineAbsPaths({ cwd, config, getBaselines }) {
  const baselines = getBaselines({ agentSettings: config.agentSettings });
  return {
    miAbs: resolveBaselineAbs(cwd, baselines?.maintainability?.path),
    crapAbs: resolveBaselineAbs(cwd, baselines?.crap?.path),
  };
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

/**
 * Restore the baseline files to HEAD's content. Used on over-cap
 * refusal to drop the refresh's write so the merge consumes the
 * pre-refresh baseline unchanged.
 */
function rollbackBaselineFiles({ cwd, baselineFiles, gitRunner, logger }) {
  for (const filePath of baselineFiles) {
    const rel = path.isAbsolute(filePath)
      ? path.relative(cwd, filePath)
      : filePath;
    const posixRel = rel.split(path.sep).join('/');
    const res = gitRunner.gitSpawn(cwd, 'checkout', 'HEAD', '--', posixRel);
    if (res.status !== 0) {
      logger.warn?.(
        `[auto-refresh-runner] failed to restore ${rel} after refusal: ${res.stderr || res.stdout}`,
      );
    }
  }
}

async function handleRefusal({
  verdict,
  caps,
  epicId,
  storyId,
  cwd,
  baselineFiles,
  gitRunner,
  appendSignal,
  forEachLine,
  config,
  logger,
}) {
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
  rollbackBaselineFiles({ cwd, baselineFiles, gitRunner, logger });
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
 * Run `refreshBaseline()` for a single kind. Returns the resolved write
 * path and a flag noting whether the service actually persisted bytes.
 * Throws on a service error (the caller surfaces it as a `failed` status).
 */
async function runRefreshForKind({
  kind,
  cwd,
  epicBranch,
  storyBranch,
  writePath,
  refreshBaseline,
  scorer,
  fsImpl,
}) {
  if (!writePath) return { writePath: null, wrote: false };
  const baseRef = epicBranch ? `origin/${epicBranch}` : 'origin/main';
  const headRef = storyBranch ?? 'HEAD';
  const result = await refreshBaseline({
    kind,
    baseRef,
    headRef,
    scopeFiles: null,
    fullScope: false,
    writePath,
    scorer,
    fs: fsImpl,
    cwd,
  });
  return { writePath, wrote: result?.wrote === true };
}

/**
 * Commit hygiene (AC-8): stage every refreshed baseline file, ask
 * `git diff --cached --exit-code` whether any drift survived. Drift →
 * emit one canonical commit per kind. No drift → log + skip. No
 * `--amend`, no `--allow-empty`.
 */
function commitRefreshedBaselines({
  cwd,
  storyId,
  refreshed,
  gitRunner,
  logger,
}) {
  const committed = [];
  let lastSha = '';
  for (const { kind, writePath } of refreshed) {
    if (!writePath) continue;
    const drift = stageAndCheckBaselineDrift({
      cwd,
      baselineFile: writePath,
      gitRunner,
    });
    if (drift.error) {
      return { ok: false, error: drift.error };
    }
    if (!drift.hasDrift) {
      logger?.info?.(
        `[auto-refresh-runner] no baseline drift to fold in for kind=${kind} (story-${storyId}).`,
      );
      continue;
    }
    const subject = `chore(baselines): refresh ${kind} for story-${storyId}`;
    const commitRes = gitRunner.gitSpawn(cwd, 'commit', '-m', subject);
    if (commitRes.status !== 0) {
      return {
        ok: false,
        error: `git commit failed for kind=${kind}: ${commitRes.stderr || commitRes.stdout}`,
      };
    }
    const headRes = gitRunner.gitSpawn(cwd, 'rev-parse', '--short', 'HEAD');
    const sha = headRes.status === 0 ? (headRes.stdout || '').trim() : '';
    lastSha = sha;
    committed.push({ kind, sha });
    logger?.info?.(`[auto-refresh-runner] committed ${subject} (${sha}).`);
  }
  return { ok: true, committed, lastSha };
}

function resolveAutoRefreshDeps(deps) {
  return {
    logger: deps.logger ?? DefaultLogger,
    getQuality: deps.getQuality ?? defaultGetQuality,
    getBaselines: deps.getBaselines ?? defaultGetBaselines,
    evaluateAutoRefresh: deps.evaluateAutoRefresh ?? defaultEvaluateAutoRefresh,
    refreshBaseline: deps.refreshBaseline ?? defaultRefreshBaseline,
    scorerBuilder: deps.scorerBuilder ?? buildKindScorer,
    gitRunner: deps.gitRunner ?? { gitSpawn: defaultGitSpawn },
    fsImpl: deps.fsImpl ?? fs,
    appendSignal: deps.appendSignal ?? defaultAppendSignal,
    forEachLine: deps.forEachLine ?? defaultForEachLine,
    computeDiffPaths: deps.computeStoryDiffPaths ?? computeStoryDiffPaths,
    readerLoadFile: deps.readerLoadFile ?? defaultReaderLoadFile,
  };
}

/**
 * Step 1 of the four-step pipeline: snapshot the prior on-disk envelopes
 * and dispatch one `refreshBaseline()` call per configured baseline kind.
 *
 * Returns an opaque "stage" object the next steps consume. The shape is
 * intentionally minimal — it carries the resolved write paths, the
 * snapshot envelopes, and the per-kind refresh result records. Callers
 * never inspect the shape directly; they pass it through to `validate`
 * and `commit`.
 *
 * Failure mode: a thrown `refreshBaseline` propagates here as a
 * `{ ok: false, status: 'failed', reason: 'refresh-service-threw' }`
 * envelope so the caller can short-circuit without try/catching at the
 * top of `runAutoRefresh`.
 */
async function stageRefreshArtifacts({
  cwd,
  epicBranch,
  storyBranch,
  agentSettings,
  config,
  getBaselines,
  refreshBaseline,
  scorerBuilder,
  fsImpl,
  readerLoadFile,
}) {
  const { miAbs, crapAbs } = resolveBaselineAbsPaths({
    cwd,
    config,
    getBaselines,
  });

  // Snapshot the prior envelopes BEFORE refreshBaseline overwrites them.
  // Reader-routed: every read goes through `reader.loadFile`, which schema-
  // validates against the per-kind envelope.
  const priorMiEnv = miAbs
    ? readEnvelope({
        absPath: miAbs,
        kind: 'maintainability',
        readerLoadFile,
      })
    : null;
  const priorCrapEnv = crapAbs
    ? readEnvelope({ absPath: crapAbs, kind: 'crap', readerLoadFile })
    : null;

  // Dispatch one refreshBaseline() call per configured kind. The service
  // handles diff-scope derivation, scope-merge with out-of-scope prior
  // rows (Task #2209), and atomic envelope persistence.
  let miRefreshed;
  let crapRefreshed;
  try {
    if (miAbs) {
      const scorer = scorerBuilder({
        kind: 'maintainability',
        cwd,
        agentSettings,
      });
      miRefreshed = await runRefreshForKind({
        kind: 'maintainability',
        cwd,
        epicBranch,
        storyBranch,
        writePath: miAbs,
        refreshBaseline,
        scorer,
        fsImpl,
      });
    }
    if (crapAbs) {
      const scorer = scorerBuilder({ kind: 'crap', cwd, agentSettings });
      crapRefreshed = await runRefreshForKind({
        kind: 'crap',
        cwd,
        epicBranch,
        storyBranch,
        writePath: crapAbs,
        refreshBaseline,
        scorer,
        fsImpl,
      });
    }
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      reason: 'refresh-service-threw',
      detail: err?.message ?? String(err),
    };
  }

  return {
    ok: true,
    miAbs,
    crapAbs,
    priorMiEnv,
    priorCrapEnv,
    miRefreshed,
    crapRefreshed,
  };
}

/**
 * Step 2 of the four-step pipeline: re-read the (scope-merged) envelopes
 * the refresh service just wrote and evaluate whether the row deltas sit
 * at or below the configured caps. Returns `{ accepted, verdict, baselineFiles }`:
 *
 *   - `accepted: true`  → caps are satisfied; commitRefresh writes one
 *     canonical commit per kind that actually drifted.
 *   - `accepted: false` → at least one row breaches a cap; pushRefresh
 *     rolls back the working-tree edits + appends a friction signal.
 *
 * The function also folds in the early-exit when no kind wrote — when
 * every `refreshBaseline()` reports `wrote:false` there's nothing to
 * validate, the caller short-circuits via the `noDrift: true` flag.
 */
function validateRefreshAccepted({
  stage,
  autoRefresh,
  caps,
  cwd,
  epicBranch,
  storyBranch,
  evaluateAutoRefresh,
  gitRunner,
  computeDiffPaths,
  readerLoadFile,
}) {
  const {
    miAbs,
    crapAbs,
    priorMiEnv,
    priorCrapEnv,
    miRefreshed,
    crapRefreshed,
  } = stage;

  const anyWrote = miRefreshed?.wrote === true || crapRefreshed?.wrote === true;
  if (!anyWrote) return { noDrift: true };

  // Re-read the (scope-merged) envelopes for verdict evaluation.
  const finalMiEnv = miAbs
    ? readEnvelope({
        absPath: miAbs,
        kind: 'maintainability',
        readerLoadFile,
      })
    : null;
  const finalCrapEnv = crapAbs
    ? readEnvelope({ absPath: crapAbs, kind: 'crap', readerLoadFile })
    : null;

  const finalMiRows = finalMiEnv?.rows ?? [];
  const finalCrapRows = adaptCrapRowsForEvaluator(finalCrapEnv?.rows ?? []);
  const priorMiRows = priorMiEnv?.rows ?? [];
  const priorCrapRows = adaptCrapRowsForEvaluator(priorCrapEnv?.rows ?? []);

  let scoped;
  if ((autoRefresh.scope ?? 'diff') === 'full') {
    scoped = { mi: finalMiRows, crap: finalCrapRows };
  } else {
    const storyDiffPaths = computeDiffPaths({
      cwd,
      epicBranch,
      storyBranch,
      gitRunner,
    });
    scoped = filterToStoryDiff({
      miRows: finalMiRows,
      crapRows: finalCrapRows,
      storyDiffPaths,
    });
  }

  const verdict = evaluateAutoRefresh({
    scoredRows: scoped,
    baseline: { mi: priorMiRows, crap: priorCrapRows },
    caps,
  });

  return {
    noDrift: false,
    accepted: verdict.canAutoRefresh === true,
    verdict,
    baselineFiles: [miAbs, crapAbs].filter(Boolean),
  };
}

/**
 * Step 3a of the four-step pipeline (accepted path): emit one canonical
 * `chore(baselines): refresh <kind> for story-<id>` commit per kind that
 * actually drifted (AC-8 commit hygiene). Empty diff → no commit. No
 * `--amend`, no `--allow-empty`.
 *
 * Returns the canonical close-result envelope `runAutoRefresh` returns
 * to its caller — `committed` / `failed` / `skipped` — so the pipeline
 * top stays at one level of abstraction.
 */
function commitRefresh({ stage, cwd, storyId, gitRunner, logger }) {
  const { miAbs, crapAbs, miRefreshed, crapRefreshed } = stage;
  const refreshed = [
    miRefreshed?.wrote === true
      ? { kind: 'maintainability', writePath: miAbs }
      : null,
    crapRefreshed?.wrote === true ? { kind: 'crap', writePath: crapAbs } : null,
  ].filter(Boolean);
  const commit = commitRefreshedBaselines({
    cwd,
    storyId,
    refreshed,
    gitRunner,
    logger,
  });
  if (!commit.ok) {
    return { status: 'failed', reason: 'commit-failed', detail: commit.error };
  }
  if (commit.committed.length === 0) {
    return { status: 'skipped', reason: 'no-baseline-drift' };
  }
  return {
    status: 'committed',
    sha: commit.lastSha,
    files: [miAbs, crapAbs].filter(Boolean),
    committed: commit.committed,
  };
}

/**
 * Step 3b of the four-step pipeline (refused path): roll back the baseline
 * working-tree edits the refresh service just wrote and push a single
 * `baseline-refresh-regression` friction signal onto the Story's NDJSON
 * stream (dedup-aware — AC3 idempotent re-run contract). The "push" here
 * is the friction-signal write + the rollback that publishes the refusal
 * outcome past the in-process pipeline boundary.
 *
 * Returns the canonical `{ status: 'refused', ... }` envelope.
 */
async function pushRefresh({
  validation,
  caps,
  epicId,
  storyId,
  cwd,
  gitRunner,
  appendSignal,
  forEachLine,
  config,
  logger,
}) {
  return handleRefusal({
    verdict: validation.verdict,
    caps,
    epicId,
    storyId,
    cwd,
    baselineFiles: validation.baselineFiles,
    gitRunner,
    appendSignal,
    forEachLine,
    config,
    logger,
  });
}

export async function runAutoRefresh({
  storyId,
  epicId,
  cwd,
  epicBranch,
  storyBranch,
  agentSettings,
  deps = {},
} = {}) {
  const {
    logger,
    getQuality,
    getBaselines,
    evaluateAutoRefresh,
    refreshBaseline,
    scorerBuilder,
    gitRunner,
    fsImpl,
    appendSignal,
    forEachLine,
    computeDiffPaths,
    readerLoadFile,
  } = resolveAutoRefreshDeps(deps);
  const config = { agentSettings };

  const autoRefresh = getQuality(config)?.autoRefresh;
  if (!autoRefresh || autoRefresh.enabled === false) {
    return { status: 'skipped', reason: 'disabled' };
  }
  const caps = {
    miDropCap: autoRefresh.miDropCap,
    crapJumpCap: autoRefresh.crapJumpCap,
  };

  // Step 1 — stage refresh artifacts (snapshot + refreshBaseline per kind).
  const stage = await stageRefreshArtifacts({
    cwd,
    epicBranch,
    storyBranch,
    agentSettings,
    config,
    getBaselines,
    refreshBaseline,
    scorerBuilder,
    fsImpl,
    readerLoadFile,
  });
  if (stage.ok !== true) {
    return {
      status: stage.status,
      reason: stage.reason,
      detail: stage.detail,
    };
  }

  // Step 2 — validate that the refreshed envelopes satisfy the configured
  // caps (and short-circuit when no kind wrote).
  const validation = validateRefreshAccepted({
    stage,
    autoRefresh,
    caps,
    cwd,
    epicBranch,
    storyBranch,
    evaluateAutoRefresh,
    gitRunner,
    computeDiffPaths,
    readerLoadFile,
  });
  if (validation.noDrift) {
    return { status: 'skipped', reason: 'no-baseline-drift' };
  }

  // Step 3 — fan out to the accepted (commit) or refused (push) terminal
  // step. The pipeline-top stays at one level of abstraction.
  if (!validation.accepted) {
    return pushRefresh({
      validation,
      caps,
      epicId,
      storyId,
      cwd,
      gitRunner,
      appendSignal,
      forEachLine,
      config,
      logger,
    });
  }
  return commitRefresh({ stage, cwd, storyId, gitRunner, logger });
}

export {
  buildRefusalSignal,
  commitRefresh,
  FRICTION_CATEGORY,
  filterToStoryDiff,
  priorRefusalSignalExists,
  pushRefresh,
  RUNNER_SOURCE_TOOL,
  stageRefreshArtifacts,
  validateRefreshAccepted,
};
