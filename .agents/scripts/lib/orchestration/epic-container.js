/**
 * epic-container.js — the one module describing a container Epic: a
 * `type::epic` issue whose body is a `## Goal` paragraph and a `- [ ] #N`
 * child checklist. Never delivered itself; `/mandrel-deliver <epicId>`
 * expands it. Linkage is parent→child only (Story bodies are never touched),
 * and its board state is derived by `epic-rollup.js`, never labelled.
 * `plan-persist` writes and `resolve-stories` reads through here so the
 * shapes cannot drift.
 *
 * @module lib/orchestration/epic-container
 */

import { TYPE_LABELS } from '../label-constants.js';

/**
 * A checklist row and the first `#N` anywhere on it — deliberately loose so
 * annotated hand-maintained rows (`- [ ] Design (#N): pending`) count.
 * Looser than `_getChecklistChildren` in `providers/github/issues.js` on
 * purpose: a spurious id costs a skipped child, a missed id could close a
 * container over open work.
 */
const CHECKLIST_ITEM_RE = /^-\s*\[[ xX]\]\s+.*?#(\d+)\b/gm;

/**
 * Single-line twin of {@link CHECKLIST_ITEM_RE}; the pair MUST accept the
 * same lines (pinned by `epic-container.test.js`).
 */
export const CHECKLIST_ITEM_LINE_RE = /^-\s*\[[ xX]\]\s+.*?#\d+\b/;

const GOAL_HEADING = '## Goal';

export const CHILDREN_HEADING = '## Stories';

/**
 * Empty-checklist placeholder; exported so {@link appendEpicChildIds} can
 * remove it when the first child arrives.
 */
export const NO_CHILDREN_PLACEHOLDER = '_No child Stories linked._';

/**
 * Labels arrive as `{ name }` objects or bare strings.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeLabels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string' && n.length > 0);
}

/**
 * The `type::epic` label alone decides; body shape must not, or a
 * hand-edited Epic would be reclassified and hard-error delivery.
 *
 * @param {{ labels?: unknown }} issue
 * @returns {boolean}
 */
export function isEpicTicket(issue) {
  return normalizeLabels(issue?.labels).includes(TYPE_LABELS.EPIC);
}

/**
 * GraphQL node id: `nodeId` on mapped tickets, `node_id` on raw REST
 * payloads. `null` when absent — callers must skip the read, since an
 * undefined `ID!` is classified `permanent` and reported as a hard failure.
 *
 * @param {{ nodeId?: unknown, node_id?: unknown }} epic
 * @returns {string|null}
 */
function resolveEpicNodeId(epic) {
  const nodeId = epic?.nodeId ?? epic?.node_id;
  return typeof nodeId === 'string' && nodeId !== '' ? nodeId : null;
}

/**
 * The single native sub-issue reader shared by delivery expansion and the
 * rollup: if they diverged, an Epic could be expandable but never closable.
 * Missing node id yields `[]`.
 *
 * @param {object} provider
 * @returns {(epic: object) => Promise<number[]>}
 */
export function nativeChildReader(provider) {
  return async (epic) => {
    const nodeId = resolveEpicNodeId(epic);
    if (nodeId === null) return [];
    // Legacy private alias kept for older test doubles.
    const read =
      provider?.getNativeSubIssues ?? provider?._getNativeSubIssues ?? null;
    if (typeof read !== 'function') return [];
    // Diagnostics only: REST names the number `number`, mapped tickets `id`.
    return (await read.call(provider, nodeId, epic?.number ?? epic?.id)) ?? [];
  };
}

/**
 * Render a container Epic's body. It must carry nothing its children do
 * not, or that fact would be invisible to the agents delivering them.
 *
 * @param {{ goal: string, childIds?: number[] }} opts
 * @returns {string} Canonical Epic body markdown.
 */
export function composeEpicBody({ goal, childIds = [] } = {}) {
  const text = typeof goal === 'string' ? goal.trim() : '';
  if (text === '') {
    throw new Error('[epic-container] composeEpicBody requires a goal.');
  }

  const ids = normalizeChildIds(childIds);
  const lines = [GOAL_HEADING, '', text, '', CHILDREN_HEADING, ''];
  if (ids.length === 0) {
    lines.push(NO_CHILDREN_PLACEHOLDER);
  } else {
    for (const id of ids) lines.push(`- [ ] #${id}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Positive integers, deduped, order-preserving.
 *
 * @param {unknown} raw
 * @returns {number[]}
 */
export function normalizeChildIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const id = Number(entry);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Child ids from the body checklist alone; API-capable callers should use
 * {@link readEpicChildIdsFrom}, since UI links bypass the checklist.
 *
 * @param {string|null|undefined} body
 * @returns {number[]}
 */
export function readEpicChildIds(body) {
  if (typeof body !== 'string' || body === '') return [];
  // Module-scoped /g regex: reset lastIndex so state does not leak.
  CHECKLIST_ITEM_RE.lastIndex = 0;
  return normalizeChildIds(
    [...body.matchAll(CHECKLIST_ITEM_RE)].map((m) => Number.parseInt(m[1], 10)),
  );
}

/**
 * Union of body checklist and native sub-issue edges; each can hold a child
 * the other misses. A native read failure degrades to the checklist but sets
 * `nativeReadFailed` — a caller about to do something irreversible (close)
 * MUST honour it. It is false when no reader was injected.
 *
 * `bodyOnlyIds` are ids only the hand-editable checklist vouches for: an
 * unresolvable one is a typo, while an unresolvable native id is a failed
 * read. Empty when the native read failed or never ran.
 *
 * @param {{
 *   epic: { number?: number, id?: number, body?: string, nodeId?: string },
 *   readNativeChildIds?: (epic: object) => Promise<number[]>,
 *   onWarn?: (message: string) => void,
 * }} opts
 * @returns {Promise<{ ids: number[], nativeReadFailed: boolean, bodyOnlyIds: number[] }>}
 */
export async function readEpicChildIdsFrom({
  epic,
  readNativeChildIds,
  onWarn,
} = {}) {
  const fromBody = readEpicChildIds(epic?.body);
  if (typeof readNativeChildIds !== 'function') {
    return { ids: fromBody, nativeReadFailed: false, bodyOnlyIds: [] };
  }

  try {
    const native = normalizeChildIds(await readNativeChildIds(epic));
    const nativeSet = new Set(native);
    return {
      ids: normalizeChildIds([...native, ...fromBody]),
      nativeReadFailed: false,
      bodyOnlyIds: fromBody.filter((id) => !nativeSet.has(id)),
    };
  } catch (err) {
    onWarn?.(
      `[epic-container] native sub-issue read failed for Epic ` +
        `#${epic?.number ?? epic?.id ?? '?'} (${err?.message ?? String(err)}); ` +
        'using the body checklist alone — the child list may be incomplete.',
    );
    return { ids: fromBody, nativeReadFailed: true, bodyOnlyIds: [] };
  }
}
