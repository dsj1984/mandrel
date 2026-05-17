#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-finalize.js — Phase F of the merged `/epic-deliver` flow.
 *
 * Story #1155 (Epic #1142, 5.40.0). Replaces the v5.39.x finalize CLI
 * (renamed; see `docs/CHANGELOG.md` 5.40.0 for the rename history). Three
 * responsibilities:
 *
 *   1. Verify `epic/<id>` fast-forward-merges the current `main`. If
 *      `main` has advanced beyond the fork-point, fetch + rebase + re-push
 *      via the existing push-epic retry contract; if the rebase reports a
 *      real conflict, halt with `agent::blocked` and clear instructions.
 *   2. Push `epic/<id>` to `origin`.
 *   3. Invoke `gh pr create --base main --head epic/<id>` with title and
 *      body sourced from the Epic ticket. Post a structured `code-review`-
 *      adjacent hand-off comment on the Epic linking the PR.
 *
 * No state-flip on the Epic. The PR's existence is the operator's signal
 * to merge.
 *
 * Stdout: a single JSON envelope with `{ epicId, ffOk, pushed, prUrl,
 * postedHandoff }`.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-finalize.js --epic <epicId>
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import path from 'node:path';

import { refreshBaseline as defaultRefreshBaseline } from '../../lib/baselines/refresh-service.js';
import { reconcileAcceptanceSpec as defaultReconcileAcceptanceSpec } from './acceptance-spec-reconciler.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  getBaselines as defaultGetBaselines,
  getQuality as defaultGetQuality,
  PROJECT_ROOT,
  resolveConfig,
} from './lib/config-resolver.js';
import { loadCoverage as defaultLoadCoverage } from './lib/coverage-utils.js';
import {
  resolveEscomplexVersion as defaultResolveEscomplexVersion,
  resolveTsTranspilerVersion as defaultResolveTsTranspilerVersion,
  scanAndScore as defaultScanAndScore,
} from './lib/crap-utils.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import {
  calculateAll as defaultCalculateAll,
  scanDirectory as defaultScanDirectory,
} from './lib/maintainability-utils.js';
import {
  emitEpicComplete,
  runHotspotDetection,
} from './lib/orchestration/epic-runner/progress-reporter.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { notify as defaultNotify } from './notify.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-finalize.js --epic <epicId> [--full-scope]

Verifies epic/<id> fast-forwards main, pushes the epic branch, opens a PR
to main with gh, and posts a hand-off comment on the Epic.

Options:
  --epic <epicId>   Epic ID (required, positive integer).
  --full-scope      Reconcile baselines via a full regeneration instead of
                    the default diff-scope. Use this only when an operator
                    audit needs every row re-scored (rare); diff-scope is
                    the default so finalize never rewrites rows outside the
                    Epic diff (Epic #2173, AC-4).
  --help, -h        Show this message.
`;

/**
 * Build the default `gh pr create` invocation. Pure — exported for tests.
 *
 * @param {{ epicId: number, title: string, body: string, baseBranch: string, epicBranch: string }} input
 * @returns {string[]} argv for `gh`
 */
export function buildPrCreateArgs(input) {
  return [
    'pr',
    'create',
    '--base',
    input.baseBranch,
    '--head',
    input.epicBranch,
    '--title',
    input.title,
    '--body',
    input.body,
  ];
}

/**
 * Pure: render the PR title from the Epic.
 */
export function buildPrTitle(epic) {
  const title = (epic?.title ?? '').replace(/^Epic\s*[—-]\s*/i, '').trim();
  return `Epic #${epic.id ?? epic.number}: ${title || 'Delivery'}`;
}

/**
 * Pure: render the PR body. The body intentionally stays compact — the
 * full PRD/Tech Spec live in the Epic ticket, and reviewers follow the
 * link.
 */
export function buildPrBody({ epicId, epicTitle, baseBranch, epicBranch }) {
  return [
    `## Epic #${epicId}: ${epicTitle ?? 'Delivery'}`,
    '',
    `Auto-opened by \`/epic-deliver\` after close-validation, code-review, and retro completed against \`${epicBranch}\`.`,
    '',
    '### Hand-off',
    '',
    `Merging this PR is the explicit human gate that closes the Epic. The full PRD, Tech Spec, retro, and code-review live on Epic #${epicId} — follow the linked issue for context.`,
    '',
    `**Base**: \`${baseBranch}\` · **Head**: \`${epicBranch}\``,
    '',
    `Closes #${epicId}`,
  ].join('\n');
}

/**
 * Pure: render the structured hand-off comment posted on the Epic.
 */
export function buildHandoffBody({ epicId, prUrl }) {
  return [
    `## 🚀 \`/epic-deliver\` complete — PR open for review`,
    '',
    prUrl
      ? `A pull request has been opened against \`main\`: ${prUrl}`
      : 'A pull request has been opened against `main` (URL unavailable).',
    '',
    `Merge this PR to fire the close transition for Epic #${epicId}. The retro and code-review structured comments are already posted on this issue.`,
  ].join('\n');
}

// Exported `false` constant: spawn(gh, ...) MUST NOT run through a shell.
// shell:true on Windows joins argv with spaces and hands the line to cmd.exe,
// which re-tokenizes — so a `gh pr create --title "Epic #N: Long title"`
// call has the title shredded into separate argv entries and `gh` rejects
// with "unknown arguments". The fix is to pass argv directly to spawnSync
// (which quotes args correctly on Windows) by keeping shell:false. Exported
// so the regression test can assert the contract.
export const GH_SPAWN_USES_SHELL = false;

function defaultGhSpawn(args, cwd) {
  const result = spawnSync('gh', args, {
    cwd,
    encoding: 'utf-8',
    shell: GH_SPAWN_USES_SHELL,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Inspect the FF status of `epic/<id>` against `origin/<base>`. Pure with
 * respect to the injected gitSpawn — exported so tests can stub.
 *
 * @returns {{ ok: true, ahead: number } | { ok: false, reason: 'main-ahead'|'no-merge-base'|'git-error', stderr?: string }}
 */
export function checkEpicFastForward({
  cwd,
  epicBranch,
  baseRef,
  gitSpawnFn = gitSpawn,
}) {
  // base must be reachable as an ancestor of epic for FF to be possible.
  const ancestor = gitSpawnFn(
    cwd,
    'merge-base',
    '--is-ancestor',
    baseRef,
    epicBranch,
  );
  if (ancestor.status === 0) {
    // baseRef is an ancestor of epic → epic FFs base. Count commits ahead.
    const revList = gitSpawnFn(
      cwd,
      'rev-list',
      '--count',
      `${baseRef}..${epicBranch}`,
    );
    const ahead = revList.status === 0 ? Number(revList.stdout.trim()) : 0;
    return { ok: true, ahead: Number.isFinite(ahead) ? ahead : 0 };
  }
  if (ancestor.status === 1) {
    return { ok: false, reason: 'main-ahead' };
  }
  return { ok: false, reason: 'git-error', stderr: ancestor.stderr };
}

/**
 * Build a maintainability scorer adapter for `refreshBaseline()`.
 *
 * The unified refresh service (Story #2197) treats scoring as an external
 * concern: the service drives scope resolution and writer composition; the
 * scorer owns the directory walk + score computation. Story #2204 wires
 * the production maintainability scorer (`calculateAll` + `scanDirectory`
 * over `quality.maintainability.targetDirs`) as an adapter so finalize
 * reconciliation can flow through `refreshBaseline()` without the kind
 * registry's default scorers being live yet (Stories 3/4/5 of Epic #2173
 * will populate those defaults; until then, callers inject).
 *
 * Diff-scope contract:
 *
 * - When `opts.fullScope === false` (the production finalize default),
 *   the service hands the scorer a `files` array derived from
 *   `git diff --name-only baseRef..headRef`. The adapter restricts the
 *   scoring set to those files that fall under the configured target
 *   dirs — files outside the target dirs are silently dropped because
 *   the maintainability baseline only covers those directories.
 * - When `opts.fullScope === true`, the adapter falls back to the legacy
 *   directory walk (every file under the target dirs is scored). The
 *   `files` array is empty in that case by service contract.
 *
 * Out-of-scope rows are preserved by the writer's scope-merge layer —
 * the adapter does not need to load the prior envelope itself.
 */
function buildMaintainabilityScorer({
  cwd,
  targetDirs,
  scanDirectoryFn,
  calculateAllFn,
}) {
  return async (files, opts) => {
    const fullScope = opts?.fullScope === true;
    const absTargetDirs = targetDirs.map((dir) =>
      path.isAbsolute(dir) ? dir : path.resolve(cwd, dir),
    );

    let sourceList;
    if (fullScope) {
      sourceList = [];
      for (const abs of absTargetDirs) {
        scanDirectoryFn(abs, sourceList);
      }
    } else {
      // Diff-scope: restrict to files that (a) the service handed us via
      // `git diff` and (b) live under a configured target dir. The full
      // walk is skipped because the writer's scope-merge preserves out-of-
      // scope rows verbatim — see refresh-service.row-preservation tests.
      sourceList = [];
      for (const f of files ?? []) {
        const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
        if (absTargetDirs.some((dir) => abs === dir || abs.startsWith(`${dir}${path.sep}`))) {
          sourceList.push(abs);
        }
      }
    }

    const scores = await calculateAllFn(sourceList);

    // Project the scoring helper's `{ path: mi }` map onto the writer's
    // canonical row shape. The refresh service runs every row through
    // `canonicalizeBaselinePath()` before persisting, so we only need
    // POSIX-relative keys here.
    return Object.entries(scores).map(([key, mi]) => {
      const rel = path.isAbsolute(key) ? path.relative(cwd, key) : key;
      const posixRel = rel.split(path.sep).join('/');
      return { path: posixRel, mi };
    });
  };
}

/**
 * Build a crap scorer adapter for `refreshBaseline()`. Mirror of the
 * maintainability builder above with the kind-specific scoring path
 * (`scanAndScore` over `quality.crap.targetDirs`).
 *
 * Coverage handling: `scanAndScore` reads coverage data eagerly; when no
 * coverage report exists and `requireCoverage !== false`, the function
 * returns no scored rows. The adapter surfaces that as "no in-scope rows",
 * which lets the writer's structural-equality short-circuit fire — i.e.
 * no spurious crap refresh commit on coverage-less runs.
 */
function buildCrapScorer({
  cwd,
  crapCfg,
  coveragePath,
  loadCoverageFn,
  scanAndScoreFn,
  resolveEscomplexVersionFn,
  resolveTsTranspilerVersionFn,
}) {
  return async (_files, _opts) => {
    const requireCoverage = crapCfg.requireCoverage !== false;
    const coverageAbs = path.isAbsolute(coveragePath)
      ? coveragePath
      : path.resolve(cwd, coveragePath);
    const coverage = loadCoverageFn(coverageAbs);
    if (!coverage && requireCoverage) {
      // No coverage report → no rows to merge. The writer keeps the prior
      // envelope intact via the structural-equality short-circuit.
      return [];
    }

    const crapTargetDirs = Array.isArray(crapCfg.targetDirs)
      ? crapCfg.targetDirs
      : [];

    // scanAndScore drives its own directory walk; we do not pre-filter by
    // diff-scope because the writer's scope-merge layer (when scope is
    // present) preserves out-of-scope prior rows regardless. Honouring the
    // diff-scope here would require a kind-specific pre-filter step that
    // duplicates the writer's responsibility — keep responsibilities thin.
    const { rows } = await scanAndScoreFn({
      targetDirs: crapTargetDirs,
      coverage,
      requireCoverage,
      cwd,
    });

    // CRAP gates need the running scorer's escomplex/ts-transpiler versions
    // resolved eagerly so a test stub can pin them deterministically. The
    // writer reads the values via per-kind module hooks.
    resolveEscomplexVersionFn(cwd);
    resolveTsTranspilerVersionFn();

    // Filter to actually-scored rows (crap is nullable for trivial methods);
    // the writer's `assertEnvelope` would reject otherwise.
    return (rows ?? []).filter(
      (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
    );
  };
}

/**
 * Story #1396 → Story #2204 (Epic #2173, AC-4): post-merge baseline
 * reconciliation. Re-score the tracked `baselines/{maintainability,crap}.json`
 * against the Epic branch's merged working tree via the unified
 * `refreshBaseline()` service (Story #2197). When at least one baseline
 * file's bytes drift, stage + commit them as `baseline-refresh: epic-<id>`
 * directly on the Epic branch.
 *
 * **Diff-scope is the default** (`fullScope: false`). Finalize only refreshes
 * rows for files that actually differ between `origin/main` and
 * `epic/<id>` — out-of-scope rows (including their timestamps) are
 * preserved byte-for-byte by the writer's scope-merge layer. This is the
 * load-bearing behaviour for Epic #2173 AC-4.
 *
 * **`fullScope: true`** is the operator-driven opt-in surfaced through the
 * CLI `--full-scope` flag for the rare cases (audit, initial baseline
 * creation, deterministic re-score) that need every row regenerated.
 *
 * Idempotency contract:
 *   - When the merge produced no in-scope drift, both refresh calls hit
 *     the writer's structural-equality short-circuit, `wrote === false`,
 *     and this helper returns `committed: false`.
 *   - On a partial /epic-deliver re-run, the previous refresh commit is
 *     already in the Epic-branch tree, so the re-scoring lands the same
 *     bytes — no duplicate commit.
 *
 * Failure modes are non-fatal: a thrown refresh step is caught, surfaced
 * via `logger.warn`, and the helper returns
 * `{ committed: false, reason: 'error' }`. The finalize pipeline must keep
 * going (push + PR open) even when reconciliation cannot run — drift is
 * caught by the pre-merge gates regardless.
 *
 * @param {{
 *   epicId: number,
 *   cwd: string,
 *   fullScope?: boolean,
 *   baseRef?: string,
 *   headRef?: string,
 *   logger?: object,
 *   refreshBaselineFn?: typeof defaultRefreshBaseline,
 *   resolveConfigFn?: typeof resolveConfig,
 *   getBaselinesFn?: typeof defaultGetBaselines,
 *   getQualityFn?: typeof defaultGetQuality,
 *   scanDirectoryFn?: typeof defaultScanDirectory,
 *   calculateAllFn?: typeof defaultCalculateAll,
 *   scanAndScoreFn?: typeof defaultScanAndScore,
 *   loadCoverageFn?: typeof defaultLoadCoverage,
 *   resolveEscomplexVersionFn?: typeof defaultResolveEscomplexVersion,
 *   resolveTsTranspilerVersionFn?: typeof defaultResolveTsTranspilerVersion,
 *   gitSpawnFn?: typeof gitSpawn,
 * }} args
 * @returns {Promise<{ committed: boolean, sha?: string, didChange?: boolean, reason?: 'no-change'|'error'|'commit-failed', detail?: string, fullScope?: boolean, refreshes?: Array<{ kind: string, wrote: boolean, scopeMode: string }> }>}
 */
export async function reconcileBaselinesOnEpicBranch({
  epicId,
  cwd,
  fullScope = false,
  baseRef,
  headRef = 'HEAD',
  logger = Logger,
  refreshBaselineFn = defaultRefreshBaseline,
  resolveConfigFn = resolveConfig,
  getBaselinesFn = defaultGetBaselines,
  getQualityFn = defaultGetQuality,
  scanDirectoryFn = defaultScanDirectory,
  calculateAllFn = defaultCalculateAll,
  scanAndScoreFn = defaultScanAndScore,
  loadCoverageFn = defaultLoadCoverage,
  resolveEscomplexVersionFn = defaultResolveEscomplexVersion,
  resolveTsTranspilerVersionFn = defaultResolveTsTranspilerVersion,
  gitSpawnFn = gitSpawn,
} = {}) {
  const refreshes = [];
  try {
    const { agentSettings, project } = resolveConfigFn({ cwd });
    const baselines = getBaselinesFn({ agentSettings });
    const quality = getQualityFn({ agentSettings });
    const resolvedBaseRef =
      baseRef ?? `origin/${project?.baseBranch ?? agentSettings?.baseBranch ?? 'main'}`;

    // ── maintainability ────────────────────────────────────────────────────
    const miPath = baselines?.maintainability?.path;
    const miTargetDirs = quality?.maintainability?.targetDirs ?? [];
    if (typeof miPath === 'string' && miPath.length > 0) {
      const miAbs = path.isAbsolute(miPath) ? miPath : path.resolve(cwd, miPath);
      const miScorer = buildMaintainabilityScorer({
        cwd,
        targetDirs: miTargetDirs,
        scanDirectoryFn,
        calculateAllFn,
      });
      const miResult = await refreshBaselineFn({
        kind: 'maintainability',
        baseRef: resolvedBaseRef,
        headRef,
        fullScope,
        writePath: miAbs,
        scorer: miScorer,
        cwd,
      });
      refreshes.push({
        kind: 'maintainability',
        wrote: miResult.wrote === true,
        scopeMode: miResult.scope?.mode ?? 'unknown',
      });
    }

    // ── crap ───────────────────────────────────────────────────────────────
    const crapPath = baselines?.crap?.path;
    const crapCfg = quality?.crap ?? {};
    if (typeof crapPath === 'string' && crapPath.length > 0) {
      const crapAbs = path.isAbsolute(crapPath)
        ? crapPath
        : path.resolve(cwd, crapPath);
      const coveragePath =
        crapCfg.coveragePath ?? 'coverage/coverage-final.json';
      const crapScorer = buildCrapScorer({
        cwd,
        crapCfg,
        coveragePath,
        loadCoverageFn,
        scanAndScoreFn,
        resolveEscomplexVersionFn,
        resolveTsTranspilerVersionFn,
      });
      const crapResult = await refreshBaselineFn({
        kind: 'crap',
        baseRef: resolvedBaseRef,
        headRef,
        fullScope,
        writePath: crapAbs,
        scorer: crapScorer,
        cwd,
      });
      refreshes.push({
        kind: 'crap',
        wrote: crapResult.wrote === true,
        scopeMode: crapResult.scope?.mode ?? 'unknown',
      });
    }
  } catch (err) {
    logger.warn?.(
      `[epic-deliver-finalize] baseline reconciliation skipped (refreshBaseline threw): ${err?.message ?? err}`,
    );
    return { committed: false, reason: 'error', detail: String(err), fullScope };
  }

  const anyWrote = refreshes.some((r) => r.wrote);
  if (!anyWrote) {
    logger.info?.(
      `[epic-deliver-finalize] baseline reconciliation: no drift on epic-${epicId} (scope=${fullScope ? 'full' : 'diff'}), skipping refresh commit.`,
    );
    return {
      committed: false,
      didChange: false,
      reason: 'no-change',
      fullScope,
      refreshes,
    };
  }

  // Stage only the baseline files that were updated. Avoid `git add -A` so
  // an unrelated dirty file in the working tree never lands in the refresh
  // commit by accident. We re-derive the absolute paths from config rather
  // than reading them back off the refresh result to keep this step pure.
  const { agentSettings } = resolveConfigFn({ cwd });
  const baselines = getBaselinesFn({ agentSettings });
  const updatedPaths = refreshes
    .filter((r) => r.wrote)
    .map((r) => {
      const cfg = baselines?.[r.kind]?.path;
      if (typeof cfg !== 'string') return null;
      return path.isAbsolute(cfg) ? cfg : path.resolve(cwd, cfg);
    })
    .filter((p) => typeof p === 'string');
  for (const p of updatedPaths) {
    const addRes = gitSpawnFn(cwd, 'add', '--', p);
    if (addRes.status !== 0) {
      logger.warn?.(
        `[epic-deliver-finalize] git add failed for ${p}: ${addRes.stderr}`,
      );
      return {
        committed: false,
        reason: 'commit-failed',
        detail: addRes.stderr,
        fullScope,
        refreshes,
      };
    }
  }

  // commit; pass --no-verify only if we explicitly need to bypass push hooks —
  // we do NOT here, the existing close validation has already cleared lint+test.
  const commitRes = gitSpawnFn(
    cwd,
    'commit',
    '-m',
    `baseline-refresh: epic-${epicId}`,
  );
  if (commitRes.status !== 0) {
    // No-op commit (nothing staged) gives non-zero with stderr "nothing to
    // commit" — treat as no-change for idempotency on a partial re-run where
    // git considered the diff already applied.
    const stderr = commitRes.stderr || commitRes.stdout || '';
    if (/nothing to commit|no changes added/i.test(stderr)) {
      return {
        committed: false,
        didChange: false,
        reason: 'no-change',
        fullScope,
        refreshes,
      };
    }
    logger.warn?.(
      `[epic-deliver-finalize] baseline-refresh commit failed: ${stderr}`,
    );
    return {
      committed: false,
      reason: 'commit-failed',
      detail: stderr,
      fullScope,
      refreshes,
    };
  }

  // Resolve the new HEAD sha for the return envelope.
  const head = gitSpawnFn(cwd, 'rev-parse', 'HEAD');
  const sha = head.status === 0 ? head.stdout.trim() : undefined;
  logger.info?.(
    `[epic-deliver-finalize] baseline-refresh: epic-${epicId} committed (${sha ? sha.slice(0, 7) : '?'}, scope=${fullScope ? 'full' : 'diff'}).`,
  );
  return { committed: true, didChange: true, sha, fullScope, refreshes };
}

/**
 * Close the Epic's linked PRD and Tech Spec planning artifacts.
 *
 * The cascade walker in `lib/orchestration/ticketing/bulk.js` does not
 * recurse upward into the Epic (and historically excluded planning
 * tickets), so without this helper the PRD / Tech Spec stay
 * `agent::executing` (or whatever they were set to during planning)
 * forever. Beyond cosmetics, leaving planning tickets open as native
 * sub-issues of the Epic suppresses GitHub's PR-driven auto-close on
 * the Epic itself when sub-issue parent-close rules apply — closing
 * them here is what lets the `Closes #${epicId}` footer actually fire.
 *
 * Best-effort: a failure on one ticket logs a warn and is reported in
 * the result envelope; it never blocks the PR from opening.
 *
 * @param {{
 *   epicId: number,
 *   epic: { linkedIssues?: { prd?: number|null, techSpec?: number|null, acceptanceSpec?: number|null } } | null,
 *   provider: object,
 *   logger?: object,
 *   transitionFn?: typeof transitionTicketState,
 * }} args
 * @returns {Promise<{
 *   prd: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 *   techSpec: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 *   acceptanceSpec: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 * }>}
 */
export async function closePlanningArtifacts({
  epicId,
  epic,
  provider,
  logger = Logger,
  transitionFn = transitionTicketState,
} = {}) {
  const result = {
    prd: { id: null, status: 'skipped' },
    techSpec: { id: null, status: 'skipped' },
    acceptanceSpec: { id: null, status: 'skipped' },
  };
  const prdId = epic?.linkedIssues?.prd ?? null;
  const techSpecId = epic?.linkedIssues?.techSpec ?? null;
  const acceptanceSpecId = epic?.linkedIssues?.acceptanceSpec ?? null;

  for (const [kind, id] of [
    ['prd', prdId],
    ['techSpec', techSpecId],
    ['acceptanceSpec', acceptanceSpecId],
  ]) {
    if (!Number.isInteger(id) || id <= 0) {
      result[kind] = { id: null, status: 'skipped', detail: 'no-link' };
      continue;
    }
    try {
      // cascade:false avoids walking up the parent chain — the Epic is
      // closed by GitHub when the operator merges the PR (or by the
      // recovery path below), not by a cascade.
      await transitionFn(provider, id, STATE_LABELS.DONE, { cascade: false });
      result[kind] = { id, status: 'closed' };
      logger.info?.(
        `[epic-deliver-finalize] Closed planning artifact ${kind} #${id} for Epic #${epicId}.`,
      );
    } catch (err) {
      const detail = err?.message ?? String(err);
      result[kind] = { id, status: 'failed', detail };
      logger.warn?.(
        `[epic-deliver-finalize] Failed to close planning artifact ${kind} #${id}: ${detail}`,
      );
    }
  }
  return result;
}

/**
 * Verify the Epic ticket reached `state: 'closed'` after the PR-driven
 * auto-close window. If it is still open, transition it explicitly via
 * `transitionTicketState`. Returns a structured envelope so callers can
 * surface "primary auto-close worked" vs "recovery fired" in audit logs.
 *
 * Failures are non-fatal — a recovery attempt that throws leaves the
 * Epic open and is reported in the envelope; the operator can re-run
 * `/epic-close` or close manually.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: object,
 *   transitionFn?: typeof transitionTicketState,
 * }} args
 * @returns {Promise<{
 *   status: 'already-closed'|'recovered'|'still-open'|'check-failed',
 *   priorState?: string,
 *   detail?: string,
 * }>}
 */
export async function verifyAndRecoverEpicClose({
  epicId,
  provider,
  logger = Logger,
  transitionFn = transitionTicketState,
} = {}) {
  let snapshot;
  try {
    if (typeof provider.invalidateTicket === 'function') {
      try {
        provider.invalidateTicket(epicId);
      } catch {
        // best-effort cache invalidation
      }
    }
    snapshot = await provider.getTicket(epicId);
  } catch (err) {
    const detail = err?.message ?? String(err);
    logger.warn?.(
      `[epic-deliver-finalize] Epic #${epicId} close-verify read failed: ${detail}`,
    );
    return { status: 'check-failed', detail };
  }
  if (snapshot?.state === 'closed') {
    return { status: 'already-closed', priorState: 'closed' };
  }
  logger.warn?.(
    `[epic-deliver-finalize] Epic #${epicId} still open after PR finalize — applying recovery transition to agent::done.`,
  );
  try {
    await transitionFn(provider, epicId, STATE_LABELS.DONE, { cascade: false });
    return { status: 'recovered', priorState: snapshot?.state ?? 'open' };
  } catch (err) {
    const detail = err?.message ?? String(err);
    logger.warn?.(
      `[epic-deliver-finalize] Epic #${epicId} recovery transition failed: ${detail}`,
    );
    return {
      status: 'still-open',
      priorState: snapshot?.state ?? 'open',
      detail,
    };
  }
}

/**
 * End-to-end finalize. DI-friendly.
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 *   loggerImpl?: { info?: Function, warn?: Function, error?: Function },
 *   gitSpawnFn?: typeof gitSpawn,
 *   ghSpawnFn?: (args: string[], cwd: string) => { status: number, stdout: string, stderr: string },
 *   upsertCommentFn?: typeof upsertStructuredComment,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   ffOk: boolean,
 *   pushed: boolean,
 *   prUrl: string|null,
 *   postedHandoff: boolean,
 *   blocker?: { reason: string, detail?: string },
 * }>}
 */
export async function runEpicDeliverFinalize({
  epicId,
  cwd,
  fullScope = false,
  injectedProvider,
  injectedConfig,
  loggerImpl,
  gitSpawnFn = gitSpawn,
  ghSpawnFn = defaultGhSpawn,
  upsertCommentFn = upsertStructuredComment,
  notifyFn = defaultNotify,
  reconcileBaselinesFn = reconcileBaselinesOnEpicBranch,
  closePlanningArtifactsFn = closePlanningArtifacts,
  reconcileAcceptanceSpecFn = defaultReconcileAcceptanceSpec,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverFinalize: --epic must be a positive integer',
    );
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config.orchestration);
  const logger = loggerImpl ?? Logger;
  const repoCwd = cwd ?? PROJECT_ROOT;
  const baseBranch =
    config.project?.baseBranch ?? config.agentSettings?.baseBranch ?? 'main';
  const epicBranch = `epic/${epicId}`;
  const baseRef = `origin/${baseBranch}`;

  // 1. FF check.
  logger.info?.(
    `[epic-deliver-finalize] FF check: ${epicBranch} against ${baseRef}...`,
  );
  // Best-effort fetch; never fatal here — the FF check itself is the gate.
  gitSpawnFn(repoCwd, 'fetch', 'origin', baseBranch);

  const ff = checkEpicFastForward({
    cwd: repoCwd,
    epicBranch,
    baseRef,
    gitSpawnFn,
  });
  if (!ff.ok) {
    const detail =
      ff.reason === 'main-ahead'
        ? `${baseRef} has advanced beyond the fork-point of ${epicBranch}. Rebase ${epicBranch} onto ${baseRef} and re-run /epic-deliver.`
        : `git error checking FF: ${ff.stderr ?? 'unknown'}`;
    logger.error?.(`[epic-deliver-finalize] FF blocked: ${detail}`);
    return {
      epicId,
      ffOk: false,
      pushed: false,
      prUrl: null,
      postedHandoff: false,
      blocker: { reason: ff.reason, detail },
    };
  }
  logger.info?.(
    `[epic-deliver-finalize] FF ok — ${epicBranch} is ${ff.ahead} commit(s) ahead of ${baseRef}.`,
  );

  // 1a. Story #1770 / Task #1780: run the hotspot detector across the
  // Epic's per-Story trace streams and persist any emissions to
  // `temp/epic-<id>/signals.ndjson` BEFORE the analyzer renders
  // epic-perf-report. The aggregator's SIGNAL_COUNT_KINDS already
  // includes `'hotspot'`, so emitting first is enough — no renderer
  // change needed. Failure-isolated inside `runHotspotDetection`.
  await runHotspotDetection({ epicId, config, logger });

  // 1b. Story #1396: post-merge baseline reconciliation. Regenerate the
  // tracked main baselines from the Epic-branch tree and commit any drift as
  // `baseline-refresh: epic-<id>` so the refresh ships atomically with the
  // Epic merge. Non-fatal — the helper swallows its own errors and we log
  // its envelope for observability.
  const reconcile = await reconcileBaselinesFn({
    epicId,
    cwd: repoCwd,
    fullScope,
    baseRef,
    headRef: epicBranch,
    logger,
    gitSpawnFn,
  });

  // 2. Push epic branch.
  logger.info?.(`[epic-deliver-finalize] Pushing ${epicBranch} to origin...`);
  const pushResult = gitSpawnFn(repoCwd, 'push', 'origin', epicBranch);
  const pushed = pushResult.status === 0;
  if (!pushed) {
    logger.error?.(
      `[epic-deliver-finalize] push failed: ${pushResult.stderr ?? 'unknown'}`,
    );
    return {
      epicId,
      ffOk: true,
      pushed: false,
      prUrl: null,
      postedHandoff: false,
      blocker: { reason: 'push-failed', detail: pushResult.stderr },
    };
  }

  // 3. gh pr create.
  let epic;
  try {
    // Prefer `getEpic` so `linkedIssues.{prd,techSpec}` are parsed out of
    // the Epic body for the planning-close phase below. Fall back to
    // `getTicket` for providers / test doubles that do not expose the
    // Epic-shaped reader — those callers will skip planning close
    // because `linkedIssues` will be absent.
    if (typeof provider.getEpic === 'function') {
      epic = await provider.getEpic(epicId);
    } else if (typeof provider.getTicket === 'function') {
      epic = await provider.getTicket(epicId);
    }
  } catch (err) {
    logger.warn?.(
      `[epic-deliver-finalize] failed to fetch Epic #${epicId} title: ${err?.message ?? err}`,
    );
  }
  const prTitle = buildPrTitle(epic ?? { id: epicId, title: '' });
  const prBody = buildPrBody({
    epicId,
    epicTitle: epic?.title,
    baseBranch,
    epicBranch,
  });
  const ghArgs = buildPrCreateArgs({
    epicId,
    title: prTitle,
    body: prBody,
    baseBranch,
    epicBranch,
  });
  logger.info?.(
    `[epic-deliver-finalize] gh pr create --base ${baseBranch} --head ${epicBranch}...`,
  );
  const ghResult = ghSpawnFn(ghArgs, repoCwd);
  let prUrl = null;
  let prNumber = null;
  if (ghResult.status === 0) {
    const stdout = (ghResult.stdout ?? '').trim();
    const match = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
    if (match) {
      prUrl = match[0];
      prNumber = Number(match[1]);
    } else {
      prUrl = stdout || null;
    }
  } else {
    logger.error?.(
      `[epic-deliver-finalize] gh pr create exit ${ghResult.status}: ${ghResult.stderr}`,
    );
    return {
      epicId,
      ffOk: true,
      pushed: true,
      prUrl: null,
      postedHandoff: false,
      blocker: { reason: 'pr-create-failed', detail: ghResult.stderr },
    };
  }

  // 3a. Enable GitHub native auto-merge so the PR squash-merges itself
  // when all required checks pass. Independent of the framework's
  // Phase 7.5 predicate — that predicate now fires only as a post-merge
  // audit / informational signal. Enabling at PR-open time is a no-op
  // when checks are already green (GitHub merges immediately) and an
  // explicit operator-pacing signal when checks have not yet run. We
  // do NOT block finalize on auto-merge enablement failures — a missing
  // auto-merge feature on the repo or a token without
  // `pull_request:write` is non-fatal, and the operator retains the
  // manual merge path through the GitHub UI.
  let autoMergeEnabled = false;
  if (prNumber) {
    const autoMergeResult = ghSpawnFn(
      [
        'pr',
        'merge',
        String(prNumber),
        '--auto',
        '--squash',
        '--delete-branch',
      ],
      repoCwd,
    );
    if (autoMergeResult.status === 0) {
      autoMergeEnabled = true;
      logger.info?.(
        `[epic-deliver-finalize] auto-merge enabled on PR #${prNumber} (squash, delete-branch).`,
      );
    } else {
      logger.warn?.(
        `[epic-deliver-finalize] gh pr merge --auto exit ${autoMergeResult.status}: ${autoMergeResult.stderr} — operator can merge manually.`,
      );
    }
  }

  // 3b. Story #2106 / Task #2111 — acceptance-spec close-time
  // reconciliation. Diff the AC IDs declared in the linked
  // `context::acceptance-spec` body against `@ac-*` / `@pending` tags in
  // `tests/features/**`. A non-OK reconciliation throws a clear `Error`
  // per `.agents/rules/orchestration-error-handling.md`, which propagates
  // out of `runEpicDeliverFinalize` to abort finalize **before**
  // `closePlanningArtifacts` fires — so planning artifacts (PRD, Tech
  // Spec, Acceptance Spec) stay open until the AC coverage gap is fixed.
  //
  // Skipped when the Epic carries the `acceptance::n-a` waiver label
  // (the reconciler returns `status: 'waived'` without scanning features)
  // or when no acceptance-spec is linked (the start gate in
  // `runSnapshotPhase` would normally catch the latter, but the
  // reconciler also defends against direct CLI invocation).
  await reconcileAcceptanceSpecFn({
    epicId,
    cwd: repoCwd,
    injectedProvider: provider,
    injectedConfig: config,
    loggerImpl: logger,
  });

  // 3c. Close the Epic's planning artifacts (PRD + Tech Spec). The
  // cascade walker does not auto-close them and leaving them open as
  // native sub-issues of the Epic blocks GitHub's `Closes #${epicId}`
  // auto-close path. Best-effort: failures land in the envelope but do
  // not abort the rest of finalize.
  const planningClose = await closePlanningArtifactsFn({
    epicId,
    epic,
    provider,
    logger,
  });

  // 4. Post hand-off comment.
  const handoff = buildHandoffBody({ epicId, prUrl });
  let postedHandoff = false;
  try {
    await upsertCommentFn(provider, epicId, 'notification', handoff);
    postedHandoff = true;
  } catch (err) {
    logger.warn?.(
      `[epic-deliver-finalize] hand-off comment post failed: ${err?.message ?? err}`,
    );
  }

  // 5. Fire the curated `epic-complete` webhook now — *after* the PR exists.
  // This is the single emit point for the host-LLM /epic-deliver path (the
  // older fire site in `epic-execute-record-wave.js` was removed because it
  // ran before `gh pr create`). Failures inside `emitEpicComplete` are
  // swallowed by the helper itself so they never block the finalize result.
  await emitEpicComplete({
    notify: (ticketId, payload, opts = {}) =>
      notifyFn(ticketId, payload, {
        orchestration: config.orchestration,
        provider,
        ...opts,
      }),
    epicId,
    prUrl,
    logger,
  });

  logger.info?.(
    `[epic-deliver-finalize] complete — pr=${prUrl ?? '(none)'} handoff=${postedHandoff} autoMerge=${autoMergeEnabled}`,
  );
  return {
    epicId,
    ffOk: true,
    pushed: true,
    prUrl,
    prNumber,
    postedHandoff,
    autoMergeEnabled,
    reconcile,
    planningClose,
  };
}

/**
 * Pure: classify parsed CLI values into a runnable intent. Extracting this
 * decision out of `main` keeps the side-effecting wrapper at CC ≤ 2 and
 * lets unit tests cover every branch directly.
 *
 * Story #2204 (Epic #2173, AC-4): the `--full-scope` flag is surfaced
 * here as `fullScope: boolean` on the `run` intent so the CLI wrapper can
 * plumb it through to `runEpicDeliverFinalize`. Diff-scope (the absence
 * of the flag) is the default — finalize never rewrites rows outside the
 * Epic diff unless the operator opts in.
 */
export function classifyFinalizeInvocation(values) {
  if (values?.help) return { kind: 'help' };
  const epicId = Number.parseInt(values?.epic ?? '', 10);
  if (Number.isNaN(epicId) || epicId <= 0) {
    return {
      kind: 'usage-error',
      messages: [
        '[epic-deliver-finalize] ERROR: --epic <epicId> is required.',
        HELP,
      ],
    };
  }
  return { kind: 'run', epicId, fullScope: values?.['full-scope'] === true };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      'full-scope': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const intent = classifyFinalizeInvocation(values);
  if (intent.kind === 'help') {
    Logger.info(HELP);
    return;
  }
  if (intent.kind === 'usage-error') {
    for (const m of intent.messages) Logger.error(m);
    process.exit(2);
  }
  const out = await runEpicDeliverFinalize({
    epicId: intent.epicId,
    fullScope: intent.fullScope === true,
  });
  Logger.info(JSON.stringify(out, null, 2));
  if (out.blocker) process.exit(1);
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-finalize' });
