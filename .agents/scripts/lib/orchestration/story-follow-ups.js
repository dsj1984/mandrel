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
import { forEachLine } from '../observability/signals-writer.js';
import { composeRoutedProposals } from './retro-proposals.js';
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
 * @param {number} storyId
 * @param {object} [config]
 * @returns {Promise<Array<{ category: string, source: 'framework'|'consumer' }>>}
 */
export async function gatherStoryFrictionSignals(storyId, config) {
  const signals = [];
  await forEachLine(
    null,
    storyId,
    (parsed) => {
      if (!parsed || typeof parsed !== 'object') return;
      const kind = parsed.kind;
      if (kind !== 'friction' && kind !== undefined) {
        // Prefer friction records; also accept category-bearing rows.
      }
      const category =
        typeof parsed.category === 'string' ? parsed.category.trim() : '';
      if (!category) return;
      const source = parsed.source === 'framework' ? 'framework' : 'consumer';
      signals.push({ category, source });
    },
    config,
  );
  return signals;
}

/**
 * @param {{
 *   storyId: number,
 *   proposals: object,
 *   graduated: object,
 * }} args
 * @returns {string}
 */
export function buildFollowUpsCommentBody({ storyId, proposals, graduated }) {
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
    lines.push('_No friction signals — nothing to follow up._');
    lines.push('');
  }
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        storyId,
        framework: framework.map((i) => i.category),
        consumer: consumer.map((i) => i.category),
        discarded: discarded.map((i) => i.category),
        filed: filed.map((i) => ({
          category: i.category,
          url: i.url ?? null,
        })),
      },
      null,
      2,
    ),
  );
  lines.push('```');
  return lines.join('\n');
}

/**
 * Capture and persist Story follow-ups. Never throws — close must not fail
 * because follow-up filing flaked.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {string} [args.cwd]
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @returns {Promise<object>}
 */
/**
 * Capture follow-ups only when merge confirm landed (`action === 'done'`).
 * One-liner seam for the confirm-merge CLI.
 */
export async function captureFollowUpsAfterConfirm(confirmation, ctx) {
  if (confirmation?.action !== 'done') return null;
  return captureStoryFollowUps(ctx);
}

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
      unresolvedBlockedEvents: [],
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
