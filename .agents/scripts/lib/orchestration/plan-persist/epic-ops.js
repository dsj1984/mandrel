/**
 * epic-ops.js — create the optional container Epic for a plan-persist run.
 *
 * Story #5139. When `/mandrel-plan` authors more than two Stories it offers to
 * group them under one container Epic. The Epic is **not** a work item: it
 * holds a `## Goal` paragraph and a child checklist, carries `type::epic` and
 * nothing else, and is never branched, implemented or delivered.
 *
 * Ordering matters — the Epic is created **after** the Stories, because its
 * body embeds their issue numbers and its sub-issue edges need their database
 * ids. A container that exists before its contents would have to be written
 * twice.
 *
 * @module lib/orchestration/plan-persist/epic-ops
 */

import { createHash } from 'node:crypto';
import { linkStoriesToEpic } from '../../../providers/github/sub-issue-add.js';
import { describeGhFailure } from '../../gh-exec.js';
import { Logger } from '../../Logger.js';
import { LABEL_COLORS, TYPE_LABELS } from '../../label-constants.js';
import { composeEpicBody } from '../epic-container.js';

/**
 * The Story count at or above which `/mandrel-plan` offers a container Epic.
 *
 * Three, i.e. "more than two" — at two Stories a pair of ids is as easy to
 * carry as one, and the container earns nothing.
 */
export const EPIC_SUGGESTION_THRESHOLD = 3;

/** Length of the truncated hex digest stamped into the Epic marker. */
const EPIC_FINGERPRINT_LENGTH = 8;

/** Marker prefix identifying a persist-authored Epic in an issue body. */
const EPIC_FINGERPRINT_MARKER_PREFIX = 'mandrel-epic-fingerprint';

/**
 * Derive the Epic's resume identity from its title and the exact child set.
 *
 * Keyed on the children, not just the title: two runs that group *different*
 * Stories are different containers even under the same title, and adopting
 * one for the other would silently leave a cohort unlinked.
 *
 * Fields join on NUL, written as the `\u0000` escape and never as a raw byte
 * — a literal NUL makes git classify the file binary and drop its diffs.
 *
 * @param {{ title: string, childIds: number[] }} opts
 * @returns {string} Hex digest.
 */
function epicFingerprint({ title, childIds }) {
  const ids = [...childIds].sort((a, b) => a - b).join(',');
  return createHash('sha256')
    .update(`${title}\u0000${ids}`)
    .digest('hex')
    .slice(0, EPIC_FINGERPRINT_LENGTH);
}

/**
 * Render the invisible HTML-comment marker carrying the Epic's fingerprint.
 *
 * @param {string} fingerprint
 * @returns {string}
 */
function epicFingerprintMarker(fingerprint) {
  return `<!-- ${EPIC_FINGERPRINT_MARKER_PREFIX} ${fingerprint} -->`;
}

/**
 * Ensure the `type::epic` label exists, **failing closed**.
 *
 * This is deliberately the opposite posture to the cohort and route labels
 * (`ensurePersistLabel` in `story-ops.js`), which degrade to "create without
 * the label" because they are cosmetic. `type::epic` is not cosmetic: it is
 * the sole marker `isEpicTicket` reads, so an Epic created without it is not
 * an Epic — it is a stray issue that `/mandrel-deliver` will hard-error on and
 * no expansion will ever find. Skipping creation leaves the Stories, which
 * are the part that matters, perfectly deliverable by id.
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
 * Find an already-created Epic carrying this fingerprint, so a resumed
 * persist adopts it instead of opening a second container.
 *
 * Non-fatal: a search failure returns `null` and the caller creates. A
 * duplicate Epic is cosmetic; a crash mid-persist is not.
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
    // The declared ticket shape: `id` is the issue number. The `number`-then-
    // `id` fallback this replaced would have adopted the resumed container by
    // database id — a number that exists, resolves to nothing, fails no guard.
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
 * Index a cohort's already-known database ids by issue number.
 *
 * A resumed run's adopted Stories carry no `internalId` — they were found by
 * listing, not created — so they are simply absent from the map and fall
 * through to the lookup. Absence means "not known here", never "has none".
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
 * Link the created Stories under the Epic as native sub-issue edges.
 *
 * Non-fatal by design — the body checklist is the durable mirror, and
 * `getSubTickets` reads it as a first-class child source. A lost edge costs
 * the GitHub UI's nesting, not the grouping itself.
 *
 * Exported since Story #5155 so the adoption path (`epic-adoption.js`) links
 * children exactly the way creation does — one mirroring rule, not two that
 * drift.
 *
 * `created` is optional and carries the cohort's `createIssue` responses, so
 * the linker can skip the id lookup for every child this run made itself.
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
 * Create the container Epic for a persisted cohort.
 *
 * Returns `null` whenever no Epic was created — not requested, too few
 * Stories, or the label could not be ensured. Callers treat `null` as the
 * ordinary no-Epic outcome, never as a failure.
 *
 * **The Epic never receives an `agent::*` label.** Its labels are exactly
 * `[type::epic]`. That absence is load-bearing: it keeps the container out
 * of the bare `/mandrel-deliver` ready list and outside `lint-issue-body.js`,
 * which scopes itself to `type::story`.
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

  // Dry-run reports the intended container write-free. `created` carries
  // negative placeholder ids there, so `childIds` is empty by construction —
  // report the count from `created` itself rather than from the filtered list.
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

  // `createIssue` declares both `id` and `number` and sets them to the same
  // issue number; reading one of them is the whole contract.
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
