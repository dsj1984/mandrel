/**
 * story-follow-ups.js — capture actionable follow-ups from a landed Story.
 *
 * Replaces the unwired Epic retro as the default closeout for v2: after a
 * Story merges, read its standalone `signals.ndjson` friction stream, compose
 * routed proposals, auto-file follow-up issues (when enabled), and upsert a
 * structured `follow-ups` comment on the Story.
 *
 * @module lib/orchestration/story-follow-ups
 */

import { graduateRetroProposals } from '../feedback-loop/retro-proposals-graduator.js';
import { DEFAULT_FRAMEWORK_REPO } from '../github/framework-repo.js';
import { Logger } from '../Logger.js';
import { normalizeGatheredSignal } from '../observability/runtime-friction.js';
import { forEachLine } from '../observability/signals-writer.js';
import {
  composeRoutedProposals,
  deriveUnresolvedBlockedEvents,
} from './retro-proposals.js';
import { upsertStructuredComment } from './ticketing.js';

export const FOLLOW_UPS_COMMENT_TYPE = 'follow-ups';

/**
 * @param {object} [config]
 * @returns {{ frameworkRepo: string, consumerRepo: string, currentRepo: { owner: string, repo: string } }}
 */
export function resolveFollowUpRepos(config) {
  const owner =
    typeof config?.github?.owner === 'string' ? config.github.owner.trim() : '';
  const repo =
    typeof config?.github?.repo === 'string' ? config.github.repo.trim() : '';
  const consumerRepo =
    owner && repo ? `${owner}/${repo}` : DEFAULT_FRAMEWORK_REPO;
  const frameworkRepo =
    typeof config?.github?.frameworkRepo === 'string' &&
    config.github.frameworkRepo.trim()
      ? config.github.frameworkRepo.trim()
      : DEFAULT_FRAMEWORK_REPO;
  const [cOwner, cRepo] = consumerRepo.split('/');
  return {
    frameworkRepo,
    consumerRepo,
    currentRepo: {
      owner: cOwner || 'unknown',
      repo: cRepo || 'unknown',
    },
  };
}

/**
 * Gather the Story's friction signals for the composer.
 *
 * **`storyId` and `details` are load-bearing (Story #4649).** This function
 * used to flatten every record to `{ category, source }`, which silently
 * dropped exactly the two fields `netOutRecoveredIncidents` keys on — so the
 * Story #4622 recovery-netting could never fire on real data, and every
 * transient friction event survived to be auto-filed. The composer's unit
 * tests passed throughout, because they fed it synthetic signals carrying
 * both fields that no production path ever produced. Preserve them.
 *
 * The record's own `storyId` is preferred over the argument so a stream that
 * carries foreign rows attributes each one correctly; the argument is the
 * fallback for records written before the field existed.
 *
 * @param {number} storyId
 * @param {object} [config]
 * @returns {Promise<Array<{ category: string, source: 'framework'|'consumer', storyId: number, details: object }>>}
 */
export async function gatherStoryFrictionSignals(storyId, config) {
  const signals = [];
  await forEachLine(
    null,
    storyId,
    (parsed) => {
      const signal = normalizeGatheredSignal(parsed, storyId);
      if (signal) signals.push(signal);
    },
    config,
  );
  return signals;
}

/**
 * Gather friction signals across every Story in a run, for the run-scoped
 * roll-up.
 *
 * Homed beside {@link gatherStoryFrictionSignals} on purpose: the two used to
 * be independent copies of the same loop in two modules, and they drifted in
 * exactly the way that made the recovery-netting unreachable (Story #4649).
 * One reader, one normalizer, no second place to forget a field.
 *
 * Unusable ids are skipped rather than throwing — a roll-up must not fail the
 * epilogue over one malformed entry.
 *
 * @param {Array<number|string>} storyIds
 * @param {object} [config]
 * @returns {Promise<Array<{ category: string, source: 'framework'|'consumer', storyId: number, details: object }>>}
 */
export async function gatherRunFrictionSignals(storyIds, config) {
  const signals = [];
  for (const raw of Array.isArray(storyIds) ? storyIds : []) {
    const sid = Number(raw);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    signals.push(...(await gatherStoryFrictionSignals(sid, config)));
  }
  return signals;
}

/**
 * Render the empty-roll-up line.
 *
 * Story #4578 — an empty roll-up over a multi-Story run must NOT read as
 * success. The pre-#4578 text ("No friction signals — nothing to follow up")
 * was *truthful* about the stream and *false* about the run: a 7-Story
 * delivery containing a mid-run git outage, a parked worker, and a
 * four-round acceptance critic rendered byte-identically to a genuinely
 * clean run. An operator cannot tell "nothing went wrong" from "the
 * telemetry never fired", and the second is likeliest exactly when the run
 * went worst.
 *
 * So the line is a function of `storyCount`:
 *   - `storyCount <= 1` → the honest, quiet reading is retained. A single
 *     Story that emitted nothing plausibly *was* clean, and crying wolf on
 *     every clean Story is how a warning channel gets tuned out.
 *   - `storyCount > 1`  → zero signals across N Stories is a **claim**, and
 *     the surrounding text says so and names the two readings, rather than
 *     asserting the flattering one.
 *
 * This mirrors the sibling precedent in `run-epilogue.js`'s
 * `renderDiffLines`, which refuses to let an unresolvable base diff render
 * as "0 changed files".
 *
 * @param {number} storyCount
 * @returns {string[]}
 */
function renderEmptyRollupLines(storyCount) {
  if (storyCount <= 1) {
    return ['_No friction signals — nothing to follow up._'];
  }
  return [
    `> ⚠️ **0 friction signals across ${storyCount} Stories — this is a claim, not a clean bill of health.**`,
    '> Either the run was genuinely friction-free, or telemetry never fired.',
    '> An empty stream is indistinguishable from a clean run, and it is least',
    '> likely to fill exactly when a run is going badly and the agent is busy.',
    '> The runtime emits friction from its own observables (`agent::blocked`',
    '> transitions, failed closes, exhausted merge waits) — so zero here also',
    '> means none of those fired. If the run had friction you can name, that',
    '> gap is itself the follow-up worth filing.',
  ];
}

/**
 * @param {{
 *   storyId: number,
 *   proposals: object,
 *   graduated: object,
 *   storyCount?: number,
 * }} args - `storyCount` (default 1) is how many Stories the roll-up spans;
 *   it decides whether an empty result reads as quiet or as a flagged claim.
 * @returns {string}
 */
export function buildFollowUpsCommentBody({
  storyId,
  proposals,
  graduated,
  storyCount = 1,
}) {
  const filed = Array.isArray(graduated?.filed) ? graduated.filed : [];
  const framework = proposals?.framework ?? [];
  const consumer = proposals?.consumer ?? [];
  const discarded = proposals?.discarded ?? [];
  const lines = [
    '### follow-ups',
    '',
    `Actionable follow-ups captured from Story #${storyId} after merge.`,
    '',
  ];
  if (filed.length > 0) {
    lines.push('**Filed**');
    for (const item of filed) {
      lines.push(
        `- ${item.source}: ${item.title}${item.url ? ` — ${item.url}` : ''}`,
      );
    }
    lines.push('');
  }
  if (framework.length + consumer.length > 0 && filed.length === 0) {
    lines.push('**Actionable (not auto-filed)**');
    for (const item of [...framework, ...consumer]) {
      lines.push(`- ${item.source}: ${item.title}`);
      lines.push('');
      lines.push('```bash');
      lines.push(item.command);
      lines.push('```');
    }
    lines.push('');
  }
  if (discarded.length > 0) {
    lines.push('**Single-occurrence (not filed)**');
    for (const item of discarded) {
      lines.push(`- ${item.source}: \`${item.category}\` ×${item.occurrences}`);
    }
    lines.push('');
  }
  if (
    filed.length === 0 &&
    framework.length === 0 &&
    consumer.length === 0 &&
    discarded.length === 0
  ) {
    lines.push(...renderEmptyRollupLines(storyCount));
    lines.push('');
  }
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        storyId,
        storyCount,
        framework: framework.map((i) => i.category),
        consumer: consumer.map((i) => i.category),
        discarded: discarded.map((i) => i.category),
        filed: filed.map((i) => ({
          category: i.category,
          url: i.url ?? null,
        })),
        // Story #4578 — an empty roll-up over N>1 Stories is a claim worth
        // flagging, not a success. Machine-readable twin of the warning
        // prose so a caller need not regex the body.
        emptyRollupSuspect:
          storyCount > 1 &&
          filed.length === 0 &&
          framework.length === 0 &&
          consumer.length === 0 &&
          discarded.length === 0,
      },
      null,
      2,
    ),
  );
  lines.push('```');
  return lines.join('\n');
}

/**
 * Capture and persist Story follow-ups. Never throws — the land must not
 * fail because follow-up filing flaked.
 *
 * Story #4543 retired the `captureFollowUpsAfterConfirm` action-gate wrapper
 * (and its `withConfirmFollowUps` sibling) that used to front this function.
 * Re-deriving "did the merge land?" from a confirmation envelope's `action`
 * field was the coupling that made close-and-land — the DEFAULT path — skip
 * capture entirely: the gate only opened on the standalone CLI's `done`, and
 * a belated manual confirm could not backfill because the Story was already
 * `agent::done` (confirm returns `noop`, the gate never opens). The shared
 * land tail (`single-story-close/phases/post-land.js`) now calls this
 * directly, after the merge is already confirmed.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {string} [args.cwd]
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @returns {Promise<object>}
 */
export async function captureStoryFollowUps({
  storyId,
  provider,
  config,
  cwd,
  progress,
}) {
  const sid = Number(storyId);
  if (!Number.isInteger(sid) || sid <= 0) {
    return { ok: false, reason: 'invalid-story-id' };
  }
  try {
    const signals = await gatherStoryFrictionSignals(sid, config);
    const repos = resolveFollowUpRepos(config);
    const proposals = composeRoutedProposals({
      anchorId: sid,
      anchorKind: 'story',
      frameworkRepo: repos.frameworkRepo,
      consumerRepo: repos.consumerRepo,
      signals,
      // Derived, not hardcoded `[]` (Story #4649). This is the escape hatch
      // the retired story-scope threshold carve-out was standing in for: a
      // Story still parked at `agent::blocked` files at a single occurrence,
      // while one that blocked and self-resolved nets out entirely.
      unresolvedBlockedEvents: deriveUnresolvedBlockedEvents(signals),
    });
    const graduated = await graduateRetroProposals({
      epicId: sid,
      provider,
      config,
      currentRepo: repos.currentRepo,
      frameworkRepo: (() => {
        const [owner, repo] = repos.frameworkRepo.split('/');
        return { owner, repo };
      })(),
      routedProposals: proposals,
      cwd,
    });
    const body = buildFollowUpsCommentBody({
      storyId: sid,
      proposals,
      graduated,
    });
    await upsertStructuredComment(provider, sid, FOLLOW_UPS_COMMENT_TYPE, body);
    progress?.(
      'FOLLOW-UPS',
      `Captured follow-ups for Story #${sid} (filed=${graduated.filed?.length ?? 0}).`,
    );
    return {
      ok: true,
      storyId: sid,
      proposals,
      graduated,
      signalCount: signals.length,
    };
  } catch (err) {
    Logger.warn(
      `[story-follow-ups] capture failed for #${sid}: ${err?.message ?? err}`,
    );
    progress?.(
      'FOLLOW-UPS',
      `⚠️ Follow-up capture failed (close continues): ${err?.message ?? err}`,
    );
    return {
      ok: false,
      reason: 'capture-failed',
      error: String(err?.message ?? err),
    };
  }
}
