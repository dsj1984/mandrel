/**
 * Turn a created audit cohort's group edges into `blocked by #N` footers plus
 * a native `blocked_by` mirror (non-fatal: the footer already orders).
 *
 * @module lib/audit-to-stories/wire-dependencies
 */

import { applyBlockedByDependencies } from '../../providers/github/blocked-by-add.js';
import { Logger } from '../Logger.js';
import { buildStoryBody } from './build-story-body.js';

/**
 * Groups (and edges to groups) with no created issue are skipped: a
 * `blocked by #undefined` would gate a Story on nothing forever.
 *
 * @param {object} args
 * @param {Array<object>} args.groups          The `create`-eligible groups.
 * @param {Array<{ fromGroupKey: string, toGroupKey: string }>} [args.edges]
 * @param {Record<string, number>} args.issueByGroupKey  Group key → issue number.
 * @param {(issueNumber: number, body: string) => Promise<unknown>} args.updateBody
 * @param {object|null} [args.provider] Omit to write footers only.
 * @returns {Promise<{
 *   storiesWired: number,
 *   bodiesUpdated: number,
 *   edgesDeclared: number,
 *   native: { edgesAdded: number, edgesSkipped: number, edgesFailed: number }|null
 * }>}
 */
export async function wireAuditStoryEdges({
  groups,
  edges = [],
  issueByGroupKey,
  updateBody,
  provider = null,
}) {
  const wired = collectWiredStories({ groups, edges, issueByGroupKey });
  if (wired.length === 0) {
    return {
      storiesWired: 0,
      bodiesUpdated: 0,
      edgesDeclared: 0,
      native: null,
    };
  }

  let bodiesUpdated = 0;
  for (const story of wired) {
    await updateBody(story.issueNumber, story.body);
    bodiesUpdated++;
  }

  return {
    storiesWired: wired.length,
    bodiesUpdated,
    edgesDeclared: wired.reduce((n, s) => n + s.blockerKeys.length, 0),
    native: await mirrorNativeEdges({ provider, wired, issueByGroupKey }),
  };
}

/**
 * Only groups with a resolvable blocker: a no-op body update still notifies.
 *
 * @param {object} args
 * @returns {Array<{ groupKey: string, issueNumber: number, body: string, blockerKeys: string[] }>}
 */
function collectWiredStories({ groups, edges, issueByGroupKey }) {
  const wired = [];
  for (const group of groups ?? []) {
    const issueNumber = issueByGroupKey?.[group?.groupKey];
    if (!Number.isInteger(issueNumber)) continue;
    const rendered = buildStoryBody({ group, edges, issueByGroupKey });
    const blockerKeys = rendered.dependsOn.filter((key) =>
      Number.isInteger(issueByGroupKey[key]),
    );
    if (blockerKeys.length === 0) continue;
    wired.push({
      groupKey: rendered.groupKey,
      issueNumber,
      body: rendered.body,
      blockerKeys,
    });
  }
  return wired;
}

/**
 * Silent hazards: `slugToIssueNumber` must be a plain object (a `Map` skips
 * every edge and reports success), and the helper reads `dependsOn`.
 *
 * @param {object} args
 * @returns {Promise<{ edgesAdded: number, edgesSkipped: number, edgesFailed: number }|null>}
 *   `null` when there is no interface to mirror through.
 */
async function mirrorNativeEdges({ provider, wired, issueByGroupKey }) {
  if (
    typeof provider?.getDependencyWriteContext !== 'function' ||
    typeof provider?.getTicket !== 'function'
  ) {
    Logger.warn(
      '[audit-to-stories] provider exposes no getDependencyWriteContext/getTicket — ' +
        'skipping native blocked_by edges. Ordering survives in the ' +
        '`blocked by #N` body footers just written.',
    );
    return null;
  }
  try {
    const { gh, owner, repo } = provider.getDependencyWriteContext();
    const summary = await applyBlockedByDependencies({
      // The group key is the slug, so `issueByGroupKey` is the slug map.
      stories: wired.map((s) => ({
        slug: s.groupKey,
        dependsOn: s.blockerKeys,
      })),
      slugToIssueNumber: issueByGroupKey,
      getTicket: (issueNumber) => provider.getTicket(issueNumber),
      owner,
      repo,
      gh,
    });
    if (summary.edgesFailed > 0) {
      Logger.warn(
        `[audit-to-stories] ${summary.edgesFailed} native blocked_by edge(s) could ` +
          'not be written. Ordering survives in the `blocked by #N` body footers.',
      );
    }
    return {
      edgesAdded: summary.edgesAdded,
      edgesSkipped: summary.edgesSkipped,
      edgesFailed: summary.edgesFailed,
    };
  } catch (err) {
    Logger.warn(
      `[audit-to-stories] native blocked_by mirroring failed (${err.message}) — ` +
        'ordering survives in the `blocked by #N` body footers.',
    );
    return null;
  }
}
