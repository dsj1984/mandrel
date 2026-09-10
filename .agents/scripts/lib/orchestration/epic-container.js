/**
 * epic-container.js — the one module describing a container Epic.
 *
 * An Epic here is a **pure container**: a `type::epic` issue whose body is a
 * short `## Goal` paragraph and a `- [ ] #N` child checklist, and nothing
 * else. It carries no `## Spec`, no `acceptance[]` / `verify[]`, and no
 * `agent::*` label. It is never branched, never implemented and never
 * delivered — `/mandrel-deliver <epicId>` expands it to its open children and
 * delivers those.
 *
 * **Linkage is parent→child only.** The Epic holds every edge; Story bodies
 * are never touched. That is the whole reason this can exist without
 * reversing ADR `20260726-v2-story-collapse`: the `Epic: #N` footer stays
 * retired and every refusal that reads it still fires, so each Story remains
 * independently deliverable and the delivery engine stays Story-only.
 *
 * Both consumers — `plan-persist` (which writes an Epic) and
 * `resolve-stories` (which expands one) — import from here so the written
 * shape and the read shape cannot drift apart.
 *
 * **The container's lifecycle is derived, never labelled.** It still carries
 * no `agent::*` label — that absence is what keeps it out of the bare
 * `/mandrel-deliver` ready list and outside `lint-issue-body.js`. What it does
 * carry is a Projects v2 Status column, an owner while its children run, and
 * eventually a closed state, all computed from the children by
 * `epic-rollup.js` and written directly (Story #5205). Deriving rather than
 * labelling is the whole reason those two facts can coexist.
 *
 * @module lib/orchestration/epic-container
 * @see Story #5139
 */

import { TYPE_LABELS } from '../label-constants.js';

/**
 * The checklist grammar: a checklist row, and the **first** issue reference
 * anywhere on it. The checklist is a durable mirror of the native sub-issue
 * edges rather than a second, competing representation — when the sub-issues
 * API is unavailable (an older GHES, a revoked scope, a rate-limit burst) the
 * children are still discoverable from the body alone.
 *
 * Deliberately the **loosest** of the three grammars that read this shape, and
 * looser than it was: it used to require the id to be the whole row
 * (`- [ ] #123`), which matched none of the annotated rows a hand-maintained
 * rollout tracker actually carries — `- [ ] Design sign-off (#1897): pending`,
 * `- [ ] 1.4 #1909 (Part B blocked)`. An Epic with 58 children presented three
 * to the rollup, which closed it with 23 still open (Story #5210).
 *
 * It is NOT in sync with `_getChecklistChildren` (`providers/github/issues.js`)
 * and no longer claims to be: that one is a general parent→child strategy for
 * any issue and still requires `#N` immediately after the checkbox. Reading a
 * superset here is safe in the direction that matters — a spurious id costs a
 * skipped non-Story child, while a missed id costs a container closed over open
 * work. The union with the native edges keeps both honest, and after #5210
 * nothing irreversible is decided on this grammar alone.
 */
const CHECKLIST_ITEM_RE = /^-\s*\[[ xX]\]\s+.*?#(\d+)\b/gm;

/**
 * The same grammar, unanchored to a global cursor — for callers testing one
 * line at a time. Kept beside its `/g` twin so the two cannot drift; the pair
 * MUST accept the same line set, which `epic-container.test.js` pins.
 */
export const CHECKLIST_ITEM_LINE_RE = /^-\s*\[[ xX]\]\s+.*?#\d+\b/;

/** Heading the container's one prose section renders under. */
const GOAL_HEADING = '## Goal';

/** Heading the child checklist renders under. */
export const CHILDREN_HEADING = '## Stories';

/**
 * Rendered in place of the checklist when a container has no children yet.
 *
 * Exported because {@link appendEpicChildIds} must *remove* it when the first
 * child arrives: a container that lists a Story and still claims to be empty
 * is a body that contradicts itself, and the two writers have to agree on the
 * exact string to keep that from happening.
 */
export const NO_CHILDREN_PLACEHOLDER = '_No child Stories linked._';

/**
 * Normalize an issue's labels to plain strings. GitHub hands labels back
 * either as objects (`{ name }`) or, once mapped, as bare strings; callers
 * should not have to care which shape they hold.
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
 * Is this issue a container Epic?
 *
 * Reads the `type::epic` label and nothing else — the label is the
 * authoritative marker. Body shape is deliberately NOT part of the test: a
 * hand-edited Epic whose checklist an operator reordered or annotated is
 * still an Epic, and treating it otherwise would silently reclassify it as
 * an ordinary non-Story and hard-error the delivery.
 *
 * @param {{ labels?: unknown }} issue
 * @returns {boolean}
 */
export function isEpicTicket(issue) {
  return normalizeLabels(issue?.labels).includes(TYPE_LABELS.EPIC);
}

/**
 * Resolve the GraphQL node id an Epic's native sub-issue read addresses it by.
 *
 * Both casings are accepted because the field name depends on which provider
 * method produced the object, and neither caller can tell from the value it
 * holds: `getTicket` (and every other single-issue read) runs through
 * `issueToTicket`, which renames `node_id` to `nodeId`, while
 * `listIssuesByLabel` returns the REST payload **verbatim** — six consumers
 * read its raw shape, so mapping it there would be a far wider change than
 * the two reads that actually need the id.
 *
 * Returns `null` when neither name carries one. That is the load-bearing
 * half: an absent id reaches GraphQL as `$id: ID!` = `undefined`, which the
 * API rejects and `classifyGithubError` calls `permanent` — so the gateway
 * rethrows with no retry and no feature-disabled fallback, and the caller
 * degrades to the body checklist while reporting a hard API failure it never
 * really had. Callers skip the read on a `null` instead, the same clean
 * no-op `providers/github/board-add.js` makes with `reason: 'no-node-id'`.
 *
 * Module-private since the reader that consumes it moved here: `nativeChildReader`
 * below is the only production caller, and exporting a helper nothing outside
 * imports fails the production dead-export gate. Its behaviour is pinned
 * through that reader.
 *
 * @param {{ nodeId?: unknown, node_id?: unknown }} epic
 * @returns {string|null}
 */
function resolveEpicNodeId(epic) {
  const nodeId = epic?.nodeId ?? epic?.node_id;
  return typeof nodeId === 'string' && nodeId !== '' ? nodeId : null;
}

/**
 * Read an Epic's native sub-issue children as issue numbers.
 *
 * The **one** definition, injected into `readEpicChildIdsFrom` by both the
 * delivery expansion (`resolve-stories.js`) and the rollup
 * (`epic-rollup.js`). It lived in each of them as a private copy, and the two
 * copies are exactly the pair that must not drift: if the expansion sees a
 * child the rollup does not, an Epic becomes expandable but permanently
 * unclosable — the Story #5210 failure, arrived at from the other direction.
 * Sharing the reader makes that class of divergence unrepresentable.
 *
 * It lives *here*, in the module that already describes what a container Epic
 * is, rather than in either consumer: `resolve-stories.js` is a CLI entrypoint
 * and importing one from the lib layer would invert the dependency direction.
 * The provider is a parameter, so this module stays provider-agnostic.
 *
 * `resolveEpicNodeId` is what makes the two callers agree on the *id* as well
 * as the reader: an Epic reached through a mapped read carries `nodeId`, one
 * read raw from REST carries `node_id`, and neither caller can tell from the
 * value it holds. A missing id yields `[]` rather than an `undefined` reaching
 * GraphQL as a rejected `ID!`.
 *
 * @param {object} provider
 * @returns {(epic: object) => Promise<number[]>}
 */
export function nativeChildReader(provider) {
  return async (epic) => {
    const nodeId = resolveEpicNodeId(epic);
    if (nodeId === null) return [];
    // The declared port first, the legacy private alias second: both forward
    // to the same gateway on the live provider, and the fallback is what keeps
    // test doubles written against the older name working.
    const read =
      provider?.getNativeSubIssues ?? provider?._getNativeSubIssues ?? null;
    if (typeof read !== 'function') return [];
    // Diagnostics-only second argument, and the one place the two shapes are
    // still read together on purpose: this module is the declared bridge
    // between them (see `resolveEpicNodeId` above), and the expression is
    // correct under both — a raw REST issue names the issue number `number`,
    // a mapped ticket names it `id`. Every *consumer* module now receives one
    // declared shape and reads the field directly.
    return (await read.call(provider, nodeId, epic?.number ?? epic?.id)) ?? [];
  };
}

/**
 * Render a container Epic's body.
 *
 * The output is intentionally minimal — a goal paragraph and a checklist.
 * The Epic must carry **no information a child does not already carry**: it
 * is a container, so anything unique living here would be a fact with no
 * home in the tickets that actually get executed, invisible to every agent
 * delivering them.
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
 * Coerce a child-id list to positive integers, deduped, order-preserving.
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
 * Read the child issue numbers an Epic body declares.
 *
 * Body-only, by design: this is the fallback that works with nothing but the
 * issue text. Callers that can reach the API should union this with the
 * native sub-issue edges (`readEpicChildIdsFrom`), because an operator can
 * link a child in the GitHub UI without touching the checklist.
 *
 * @param {string|null|undefined} body
 * @returns {number[]}
 */
export function readEpicChildIds(body) {
  if (typeof body !== 'string' || body === '') return [];
  // `matchAll` on a /g regex starts from lastIndex; the literal is
  // module-scoped, so reset it rather than leaking state across calls.
  CHECKLIST_ITEM_RE.lastIndex = 0;
  return normalizeChildIds(
    [...body.matchAll(CHECKLIST_ITEM_RE)].map((m) => Number.parseInt(m[1], 10)),
  );
}

/**
 * Resolve an Epic's children from **both** sources — the body checklist and
 * the native sub-issue edges — as one deduped list.
 *
 * The two are unioned rather than ranked because each can hold a child the
 * other misses: the API is authoritative for links made in the GitHub UI,
 * and the checklist survives an API that is unavailable or was never
 * written. A child present in either is a child.
 *
 * `readNativeChildIds` is injected and may be absent or throw; a failure
 * degrades to the checklist rather than propagating, since a body-derived
 * child list is a strictly better answer than an error.
 *
 * **The degrade is reported, not hidden.** The result carries
 * `nativeReadFailed`, because a truncated list and a genuinely small Epic are
 * otherwise indistinguishable downstream — and one caller
 * (`epic-rollup.js`) decides an irreversible close on the difference. A caller
 * that only needs "who are the children" reads `ids` and ignores the flag;
 * a caller about to do something it cannot undo MUST NOT.
 *
 * `nativeReadFailed` is false when no reader was injected: a caller that
 * supplied none never asked for authority and is not degraded relative to what
 * it requested.
 *
 * **`bodyOnlyIds` names the ids the union owes to the checklist alone.** The
 * two sources are not equally trustworthy about a *single* id: a native edge
 * is a link the backend holds, so an id it returns names a real issue, while a
 * checklist row is hand-editable prose and can cite an issue that was deleted,
 * transferred, or simply mistyped. Callers that must decide what an
 * unresolvable id means need to know which source vouched for it — a native id
 * that will not resolve is a failed read, a body-only one is a typo. Empty
 * when the native read failed or never ran: with no authoritative source to
 * contrast against, nothing is "body-only" in the sense that matters.
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
