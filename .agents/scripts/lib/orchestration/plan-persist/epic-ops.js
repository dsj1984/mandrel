/**
 * The optional container Epic: a goal plus a child checklist, never
 * delivered. Created after the Stories, since it embeds their numbers and
 * database ids.
 *
 * @module lib/orchestration/plan-persist/epic-ops
 */

import { createHash } from 'node:crypto';
import { linkStoriesToEpic } from '../../../providers/github/sub-issue-add.js';
import { describeGhFailure } from '../../gh-exec.js';
import { Logger } from '../../Logger.js';
import { LABEL_COLORS, TYPE_LABELS } from '../../label-constants.js';
import { composeEpicBody } from '../epic-container.js';

/** Story count at which `/mandrel-plan` offers a container Epic. */
export const EPIC_SUGGESTION_THRESHOLD = 3;

const EPIC_FINGERPRINT_LENGTH = 8;

const EPIC_FINGERPRINT_MARKER_PREFIX = 'mandrel-epic-fingerprint';

/**
 * Resume identity over title and the exact child set — a different cohort
 * under the same title is a different container.
 *
 * Fields join on NUL, written as the `\u0000` escape and never as a raw byte
 * — a literal NUL makes git classify the file binary and drop its diffs.
 *
 * @param {{ title: string, childIds: number[] }} opts
 * @returns {string}
 */
function epicFingerprint({ title, childIds }) {
  const ids = [...childIds].sort((a, b) => a - b).join(',');
  return createHash('sha256')
    .update(`${title}\u0000${ids}`)
    .digest('hex')
    .slice(0, EPIC_FINGERPRINT_LENGTH);
}

/**
 * @param {string} fingerprint
 * @returns {string}
 */
function epicFingerprintMarker(fingerprint) {
  return `<!-- ${EPIC_FINGERPRINT_MARKER_PREFIX} ${fingerprint} -->`;
}

/**
 * Fails closed, unlike the cosmetic cohort label: `type::epic` is the sole
 * Epic marker, so an Epic without it is a stray issue. Skipping leaves the
 * Stories deliverable by id.
 *
 * @param {{ provider: object }} opts
 * @returns {Promise<boolean>} Whether creation may proceed.
 */
async function ensureEpicLabel({ provider }) {
  if (typeof provider?.ensureLabels !== 'function') return true;
  try {
    const result = await provider.ensureLabels([
      {
        name: TYPE_LABELS.EPIC,
        color: LABEL_COLORS.TYPE,
        description:
          'Container-only grouping ticket — holds child Stories, carries no execution payload',
      },
    ]);
    if (
      Array.isArray(result?.missing) &&
      result.missing.includes(TYPE_LABELS.EPIC)
    ) {
      Logger.warn(
        `[plan-persist] "${TYPE_LABELS.EPIC}" could not be verified on the remote — ` +
          'skipping the container Epic. The Stories are unaffected and deliver by id.',
      );
      return false;
    }
    return true;
  } catch (err) {
    Logger.warn(
      `[plan-persist] "${TYPE_LABELS.EPIC}" label ensure failed ` +
        `(${describeGhFailure(err)}) — skipping the container Epic. ` +
        'The Stories are unaffected and deliver by id.',
    );
    return false;
  }
}

/**
 * Non-fatal: a failed lookup returns `null` and the caller creates — a
 * duplicate Epic is cosmetic, a mid-persist crash is not.
 *
 * @param {{ provider: object, fingerprint: string }} opts
 * @returns {Promise<{ id: number, url?: string }|null>}
 */
async function findExistingEpic({ provider, fingerprint }) {
  if (typeof provider?.listTicketsByLabel !== 'function') return null;
  try {
    const marker = epicFingerprintMarker(fingerprint);
    const found = await provider.listTicketsByLabel({
      state: 'open',
      labels: TYPE_LABELS.EPIC,
    });
    const hit = (Array.isArray(found) ? found : []).find((issue) =>
      String(issue?.body ?? '').includes(marker),
    );
    if (!hit) return null;
    // `id` is the issue number here; never fall back to a database id.
    const id = Number(hit.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { id, url: hit.url ?? undefined };
  } catch (err) {
    Logger.warn(
      `[plan-persist] Epic resume lookup failed (${err.message}); creating a new container.`,
    );
    return null;
  }
}

/**
 * Known database ids by issue number. Adopted Stories are absent (they carry
 * no `internalId`) and fall through to a lookup.
 *
 * @param {Array<{ id?: number, internalId?: number }>|undefined} created
 * @returns {Map<number, number>}
 */
function internalIdsFrom(created) {
  const map = new Map();
  for (const story of Array.isArray(created) ? created : []) {
    if (Number.isInteger(story?.id) && typeof story?.internalId === 'number') {
      map.set(story.id, story.internalId);
    }
  }
  return map;
}

/**
 * Native sub-issue edges, shared with the adoption path. Non-fatal: the body
 * checklist is the durable child source. `created` lets the linker skip the
 * id lookup for children this run made.
 *
 * @param {{ provider: object, epicNumber: number, childIds: number[], created?: Array<{ id: number, internalId?: number }> }} opts
 * @returns {Promise<{ added: number, skipped: number, failed: number }|null>}
 */
export async function mirrorSubIssueEdges({
  provider,
  epicNumber,
  childIds,
  created = [],
}) {
  if (
    typeof provider?.getDependencyWriteContext !== 'function' ||
    typeof provider?.getTicket !== 'function'
  ) {
    Logger.warn(
      '[plan-persist] provider exposes no getDependencyWriteContext/getTicket — ' +
        'skipping native sub-issue edges. The Epic body checklist still lists every child.',
    );
    return null;
  }

  try {
    const { gh, owner, repo } = provider.getDependencyWriteContext();
    const summary = await linkStoriesToEpic({
      epicNumber,
      childIssueNumbers: childIds,
      knownInternalIds: internalIdsFrom(created),
      getTicket: (issueNumber) => provider.getTicket(issueNumber),
      owner,
      repo,
      gh,
    });
    if (summary.failed > 0) {
      Logger.warn(
        `[plan-persist] ${summary.failed} sub-issue edge(s) could not be written. ` +
          'The Epic body checklist still lists every child; add the links by hand ' +
          'if you want them nested in the GitHub UI.',
      );
    } else {
      Logger.info(
        `[plan-persist] sub-issue edges: ${summary.added} added, ` +
          `${summary.skipped} already present.`,
      );
    }
    return summary;
  } catch (err) {
    Logger.warn(
      `[plan-persist] native sub-issue mirroring failed (${err.message}) — ` +
        'the Epic body checklist still lists every child.',
    );
    return null;
  }
}

/**
 * `null` is the ordinary no-Epic outcome, never a failure. Labels are exactly
 * `[type::epic]` — no `agent::*`, which keeps it out of the deliver ready list.
 *
 * @param {{
 *   provider: object,
 *   epic: { title: string, goal: string }|null,
 *   created: Array<{ id: number, title: string }>,
 *   opts?: { dryRun?: boolean, minStories?: number },
 * }} args
 * @returns {Promise<{
 *   id: number,
 *   title: string,
 *   url?: string,
 *   childIds: number[],
 *   adopted: boolean,
 *   edges: { added: number, skipped: number, failed: number }|null,
 * }|null>}
 */
export async function createContainerEpic({
  provider,
  epic,
  created,
  opts = {},
}) {
  const { dryRun = false, minStories = EPIC_SUGGESTION_THRESHOLD } = opts;
  if (!epic) return null;

  const title = typeof epic.title === 'string' ? epic.title.trim() : '';
  const goal = typeof epic.goal === 'string' ? epic.goal.trim() : '';
  if (title === '' || goal === '') {
    throw new Error(
      '[plan-persist] A container Epic requires both a title and a goal.',
    );
  }

  const childIds = (Array.isArray(created) ? created : [])
    .map((s) => s.id)
    .filter((id) => Number.isInteger(id) && id > 0);

  // Dry-run ids are negative placeholders, so report from `created` itself.
  if (dryRun) {
    return {
      id: -1,
      title,
      childIds: (Array.isArray(created) ? created : []).map((s) => s.id),
      adopted: false,
      edges: null,
    };
  }

  if (childIds.length < minStories) {
    Logger.info(
      `[plan-persist] ${childIds.length} Story(ies) is below the ${minStories}-Story ` +
        'Epic threshold — no container created.',
    );
    return null;
  }

  if (!(await ensureEpicLabel({ provider }))) return null;

  const fingerprint = epicFingerprint({ title, childIds });
  const existing = await findExistingEpic({ provider, fingerprint });
  if (existing) {
    Logger.info(
      `[plan-persist] resuming: container Epic #${existing.id} already groups ` +
        'this exact cohort — skipping create.',
    );
    const edges = await mirrorSubIssueEdges({
      provider,
      epicNumber: existing.id,
      childIds,
      created,
    });
    return {
      id: existing.id,
      title,
      url: existing.url,
      childIds,
      adopted: true,
      edges,
    };
  }

  const body = `${composeEpicBody({ goal, childIds })}\n${epicFingerprintMarker(fingerprint)}\n`;
  const result = await provider.createIssue({
    title,
    body,
    labels: [TYPE_LABELS.EPIC],
  });

  const epicNumber = result.id;
  const edges = await mirrorSubIssueEdges({
    provider,
    epicNumber,
    childIds,
    created,
  });

  Logger.info(
    `[plan-persist] container Epic #${epicNumber} groups ${childIds.length} Story(ies): ` +
      `deliver them all with /mandrel-deliver ${epicNumber}`,
  );

  return {
    id: epicNumber,
    title,
    url: result.url,
    childIds,
    adopted: false,
    edges,
  };
}
