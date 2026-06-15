/**
 * phases/post-and-mirror.js — retro Phase 4: compose + upsert + mirror.
 *
 * Runs gather → compose → checks → upsert structured comment → mirror to
 * the per-Epic temp dir, and emits the `retro.end` boundary on the bus
 * once the write side-effects settle.
 *
 * Extracted so `runRetro` can wrap the full body in a try/catch for the
 * `retro.end` boundary emit on throw without cluttering the happy-path
 * read.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import { epicRetroMirrorPath } from '../../../config/temp-paths.js';
import { upsertStructuredComment } from '../../ticketing.js';
import { appendChecksSection, collectRetroFindings } from './checks.js';
import {
  composeRetroBody as defaultComposeRetroBody,
  deriveDefectClasses,
  normalizeInterventionCount,
} from './compose-body.js';
import { gatherRetroSignals as defaultGatherRetroSignals } from './gather-signals.js';

/**
 * Inner compose-and-post helper. Extracted so `runRetro` can wrap the
 * full body in a try/catch for the `retro.end` boundary emit without
 * cluttering the happy-path read.
 */
export async function composeAndPostRetro({
  epicId,
  provider,
  logger,
  forceFull,
  timestamp,
  bus,
  now,
  manualInterventions,
  gatherFn = defaultGatherRetroSignals,
  composeFn = defaultComposeRetroBody,
  upsertFn = upsertStructuredComment,
  runChecksFn,
  assembleStateFn,
  cwd,
  fsImpl = nodeFs,
  startedAt,
  onMirrorWritten,
  perfThresholds = null,
}) {
  const signals = await gatherFn({ epicId, provider, logger });

  // Best-effort fetch of the Epic title for the heading.
  let epicTitle;
  try {
    const epic = await provider.getTicket?.(epicId);
    epicTitle = epic?.title;
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] Failed to fetch Epic #${epicId} title (using fallback): ${err?.message ?? err}`,
    );
  }

  const interventions = normalizeInterventionCount(manualInterventions);
  const { body, compact, scorecard } = composeFn({
    epicId,
    epicTitle,
    counts: { ...signals.counts, interventions },
    storyPerfSummaries: signals.storyPerfSummaries,
    epicPerfReport: signals.epicPerfReport,
    parkedFollowOns: signals.parkedFollowOns,
    routedProposals: signals.routedProposals,
    timestamp,
    forceFull,
    perfThresholds,
  });

  // Story #4135 (Epic #4131, F11) — derive the recurring-defect-class signal
  // from the same routed proposals the body composer consumed. The signal is
  // surfaced on the runRetro envelope (`defectClasses`) so callers/tests can
  // observe the recurring classes the routed-proposal `gh issue create`
  // commands stamp with `friction::<class>` labels — the join key the
  // `/plan` Phase 0 fetcher reads back. No-op-safe: a clean sprint (no
  // routed proposals) yields `[]`.
  const defectClasses = deriveDefectClasses(signals.routedProposals);

  const findings = await collectRetroFindings({
    runChecksFn,
    assembleStateFn,
    cwd,
    logger,
  });
  const bodyWithChecks = appendChecksSection(body, findings);

  logger?.info?.(
    `[retro-runner] Posting ${compact ? 'compact' : 'full'} retro on Epic #${epicId}${findings.length > 0 ? ` (${findings.length} finding(s))` : ''}...`,
  );
  const result = await upsertFn(provider, epicId, 'retro', bodyWithChecks);

  // Story #2089: also mirror the retro body to the per-Epic temp dir so
  // operators can read it locally without re-fetching from GitHub. GitHub
  // remains SSOT — a write failure logs a warn and does not fail the
  // phase. The path is resolved relative to `cwd` when supplied so that
  // worktree-scoped invocations land under the worktree's temp tree.
  let mirrorAbsPath = null;
  try {
    const rel = epicRetroMirrorPath(epicId);
    const absPath = path.isAbsolute(rel)
      ? rel
      : path.join(cwd ?? process.cwd(), rel);
    fsImpl.mkdirSync(path.dirname(absPath), { recursive: true });
    fsImpl.writeFileSync(absPath, bodyWithChecks, 'utf8');
    mirrorAbsPath = absPath;
    onMirrorWritten?.(absPath);
    logger?.info?.(`[retro-runner] Mirrored retro to ${absPath}`);
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] Failed to write retro mirror (retro.md) for Epic #${epicId} (continuing — GitHub upsert succeeded): ${err?.message ?? err}`,
    );
  }

  // Story #2252 — emit `retro.end` after the upsert + mirror settle so
  // the lifecycle ledger captures the closing boundary with the
  // posted/compact flags AND the resolved mirror path (when present).
  const endedAt = typeof now === 'function' ? now() : Date.now();
  const retroEndPayload = {
    epicId,
    posted: true,
    compact: Boolean(compact),
    durationMs: Math.max(0, Math.floor(endedAt - startedAt)),
  };
  if (mirrorAbsPath) retroEndPayload.retroPath = mirrorAbsPath;
  await bus.emit('retro.end', retroEndPayload);

  return {
    posted: true,
    compact,
    scorecard,
    body: bodyWithChecks,
    findings,
    defectClasses,
    commentId: result?.commentId,
  };
}
