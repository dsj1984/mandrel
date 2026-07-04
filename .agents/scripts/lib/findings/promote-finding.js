/**
 * lib/findings/promote-finding.js — Promote clustered ledger items to tickets.
 *
 * The `f1-shared-qa-core` promotion step (Epic #3798, Feature #3803). It is the
 * tail of the exploratory-QA Triage path: once an operator has dispositioned a
 * session's ledger items (see `.agents/schemas/qa-ledger.schema.json` and
 * `lib/qa/qa-session.js`), the still-untriaged backlog is clustered and each
 * cluster is promoted to a follow-up ticket — a single Story (via `/plan`)
 * for a tight, one-deliverable cluster, or an Epic (via `/plan --idea`) for
 * a broad cluster that spans multiple coverage surfaces. Each contributing
 * ledger item then has the resulting `routedTo` issue link written back onto it
 * so a resume run sees the item as filed rather than re-promoting it.
 *
 * Routing **reuses the shared findings/route logic** — `routeFinding` from
 * `route-finding.js`, the single dedup/route implementation `audit-to-stories`
 * and `qa-explore` already share. It does NOT call `audit-to-stories`: that
 * workflow parses `audit-*-results.md` markdown and is a different intake path.
 * Here a cluster is adapted onto the canonical finding identity, routed against
 * existing Issues, and only a `new` decision opens a fresh ticket; an
 * `update-existing` / `duplicate` / `regression-of-closed` decision links back
 * to the matched Issue without creating a duplicate.
 *
 * Pure orchestration: **no network I/O lives here.** Every GitHub side-effect
 * (issue search, ticket creation) flows through INJECTED PORTS so the unit test
 * runs with no network. Production wires the ports to the GitHub provider /
 * `/plan` / `/plan` surfaces; tests pass in-memory stubs.
 */

import { fingerprintFinding, routeFinding } from './route-finding.js';
import { highestSeverity as highestSeverityOf } from './severity.js';

/** Triaged dispositions, mirrored from the `disposition` enum in the schema. */
const TRIAGED_DISPOSITIONS = Object.freeze(['file', 'defer', 'dismiss']);

/** The two promotion targets a cluster routes to. */
export const PROMOTION_TARGETS = Object.freeze({
  STORY: 'story',
  EPIC: 'epic',
});

/**
 * A cluster of more than this many distinct coverage surfaces is broad enough
 * to warrant an Epic (`/plan --idea`) rather than a single Story
 * (`/plan`). One or two surfaces is a tight, single-deliverable cluster.
 */
const EPIC_COVERAGE_THRESHOLD = 2;

/**
 * True when a ledger item has NOT yet been promoted — i.e. it is part of the
 * rolling backlog. An item is untriaged when its `disposition` is not one of
 * the canonical triaged values, OR it is explicitly dispositioned `file` but
 * has not yet been routed (`routedTo` absent). A `defer` / `dismiss` item, or
 * an already-`routedTo` item, is skipped.
 *
 * @param {{ disposition?: unknown, routedTo?: unknown }} item
 * @returns {boolean}
 */
export function isPromotable(item) {
  if (item === null || typeof item !== 'object') return false;
  if (item.routedTo) return false;
  const disposition = item.disposition;
  if (disposition === 'defer' || disposition === 'dismiss') return false;
  // `file` items are promotable; anything not in the triaged set (pending,
  // untriaged, null, absent) is the rolling backlog and also promotable.
  if (disposition === 'file') return true;
  return !TRIAGED_DISPOSITIONS.includes(disposition);
}

/**
 * Stable cluster key for a ledger item: its `class`. Items sharing a class
 * describe the same kind of signal (a product bug, a tooling-DX gap, …) and
 * merge into one follow-up ticket. A class whose items span many distinct
 * coverage surfaces is broad enough to promote to an Epic (see
 * {@link targetForCluster}); a class confined to one or two surfaces is a
 * single-deliverable Story. Coverage is therefore a *secondary* signal that
 * sizes the cluster rather than splitting it.
 *
 * @param {{ class?: string }} item
 * @returns {string}
 */
function clusterKeyFor(item) {
  return String(item?.class ?? 'unknown')
    .trim()
    .toLowerCase();
}

/**
 * The highest severity present across a cluster's items, resolved through the
 * shared canonical {@link ./severity.js} vocabulary (Story #3816). This module
 * no longer declares its own severity rank table — the ordering lives in one
 * place so a cluster severity and a `classify-finding` severity for the same
 * input are identical, keeping the `fingerprintFinding` identity stable.
 *
 * @param {Array<{ severity?: string }>} items
 * @returns {string} one of the canonical severities.
 */
function highestSeverity(items) {
  return highestSeverityOf(items.map((item) => item?.severity));
}

/**
 * Cluster the promotable (untriaged / unrouted) ledger items by coverage
 * surface + class. Returns one cluster per distinct key, each carrying the
 * contributing items, the distinct coverage surfaces it spans, the highest
 * severity in the merge, and a synthesized title. Deterministic: clusters and
 * their items preserve first-seen order.
 *
 * @param {Array<object>} items — ledger items (the full session ledger).
 * @returns {Array<{
 *   key: string,
 *   class: string,
 *   coverages: string[],
 *   severity: string,
 *   title: string,
 *   items: object[],
 * }>}
 * @throws {TypeError} when `items` is not an array.
 */
export function clusterLedgerItems(items) {
  if (!Array.isArray(items)) {
    throw new TypeError('clusterLedgerItems: items must be an array');
  }

  const byKey = new Map();
  for (const item of items) {
    if (!isPromotable(item)) continue;
    const key = clusterKeyFor(item);
    if (!byKey.has(key)) {
      byKey.set(key, []);
    }
    byKey.get(key).push(item);
  }

  const clusters = [];
  for (const [key, clusterItems] of byKey.entries()) {
    const coverages = [
      ...new Set(
        clusterItems.map((i) => String(i?.coverage ?? 'unknown').trim()),
      ),
    ];
    const cls = String(clusterItems[0]?.class ?? 'unknown').trim();
    const title =
      clusterItems.length === 1
        ? clusterItems[0].evidence
        : `Address ${clusterItems.length} ${cls} findings in ${coverages.join(' / ')}`;
    clusters.push({
      key,
      class: cls,
      coverages,
      severity: highestSeverity(clusterItems),
      title,
      items: clusterItems,
    });
  }

  return clusters;
}

/**
 * Decide a cluster's promotion target. A cluster that spans more than
 * {@link EPIC_COVERAGE_THRESHOLD} distinct coverage surfaces is broad enough to
 * warrant an Epic (`/plan --idea`); otherwise it is a single-deliverable
 * Story (`/plan`).
 *
 * @param {{ coverages: string[] }} cluster
 * @returns {'story'|'epic'}
 */
export function targetForCluster(cluster) {
  const surfaces = Array.isArray(cluster?.coverages)
    ? cluster.coverages.length
    : 0;
  return surfaces > EPIC_COVERAGE_THRESHOLD
    ? PROMOTION_TARGETS.EPIC
    : PROMOTION_TARGETS.STORY;
}

/**
 * Adapt a cluster onto the canonical finding identity that `routeFinding`
 * fingerprints over (`title`, `area`, `primaryFile`, `severity`, `labels`).
 * The coverage surface stands in for `area`; the class becomes a label so two
 * clusters with the same title but different classes fingerprint distinctly.
 *
 * @param {{ title: string, coverages: string[], class: string, severity: string }} cluster
 * @returns {{ title: string, area: string, primaryFile: string, severity: string, labels: string[] }}
 */
function clusterToFinding(cluster) {
  return {
    title: cluster.title,
    area: cluster.coverages.join(','),
    primaryFile: '',
    severity: cluster.severity,
    labels: [cluster.class],
  };
}

/**
 * Build the `routedTo` link the schema stamps onto a promoted ledger item.
 *
 * The `routedTo.url` field is `minLength: 1` in `qa-ledger.schema.json`,
 * and the search/create port contract requires a
 * routed issue to carry its canonical URL. So rather than silently stamp an
 * empty string (which would persist a schema-invalid ledger item), this guards
 * the url and throws when it is absent or blank (Story #3816, AC #4).
 *
 * @param {{ number: number, url?: string }} issue
 * @param {'story'|'epic'|'issue'} kind
 * @returns {{ issue: number, url: string, kind: string }}
 * @throws {Error} when the routed issue has no non-empty `url`.
 */
function routedToLink(issue, kind) {
  const url = typeof issue?.url === 'string' ? issue.url.trim() : '';
  if (url.length === 0) {
    throw new Error(
      `promoteFindings: routed issue #${issue?.number ?? '?'} is missing a url; ` +
        'the search/create port contract requires a non-empty url ' +
        '(routedTo.url is minLength:1 in the qa-ledger schema)',
    );
  }
  return {
    issue: issue.number,
    url,
    kind,
  };
}

/**
 * Promote the clustered untriaged ledger items into Stories / Epics via the
 * shared findings/route logic, then write the resulting `routedTo` issue link
 * back onto each contributing ledger item.
 *
 * For each cluster:
 *   1. Adapt the cluster onto the canonical finding shape and route it with the
 *      shared `routeFinding` against existing Issues (via the injected search
 *      port). This dedups against work already filed.
 *   2. On a `new` decision, open the follow-up ticket through the injected
 *      `createStory` (`/plan`) or `createEpic` (`/plan --idea`) port,
 *      chosen by {@link targetForCluster}. On any other decision, link back to
 *      the matched Issue rather than creating a duplicate.
 *   3. Stamp the resolved `routedTo` link onto every contributing ledger item
 *      (mutating the item objects in place, so a `qa-session` append persists
 *      the link).
 *
 * All GitHub side-effects flow through the injected ports — there is no network
 * I/O in this module, so the unit test runs offline.
 *
 * @param {Array<object>} ledgerItems — the full session ledger.
 * @param {object} ports
 * @param {(sha: string) => Promise<Array<{ number: number, state: string, body?: string }>>} [ports.searchIssues]
 *   Fingerprint-keyed lookup over open+closed issues, forwarded to `routeFinding`.
 * @param {(finding: object) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [ports.searchCandidates]
 *   Optional semantic candidate search, forwarded to `routeFinding`.
 * @param {(cluster: object) => Promise<{ number: number, url?: string }>} ports.createStory
 *   Opens a single Story (`/plan`) for a tight cluster.
 * @param {(cluster: object) => Promise<{ number: number, url?: string }>} ports.createEpic
 *   Opens an Epic (`/plan --idea`) for a broad cluster.
 * @returns {Promise<{
 *   promotions: Array<{
 *     clusterKey: string,
 *     target: 'story'|'epic',
 *     decision: string,
 *     created: boolean,
 *     issue: number,
 *     routedTo: { issue: number, url: string, kind: string },
 *     itemIds: string[],
 *   }>,
 *   skipped: number,
 * }>}
 * @throws {Error} when a required create port is missing for a routed cluster.
 */
export async function promoteFindings(ledgerItems, ports = {}) {
  const { searchIssues, searchCandidates, createStory, createEpic } = ports;
  if (
    typeof searchCandidates !== 'function' &&
    typeof searchIssues !== 'function'
  ) {
    throw new Error(
      'promoteFindings: a searchCandidates or searchIssues port is required',
    );
  }

  const clusters = clusterLedgerItems(ledgerItems);
  const promotions = [];

  for (const cluster of clusters) {
    const finding = clusterToFinding(cluster);
    const route = await routeFinding(finding, {
      searchIssues,
      searchCandidates,
    });

    const target = targetForCluster(cluster);
    let issue;
    let created = false;

    if (route.decision === 'new') {
      const createPort =
        target === PROMOTION_TARGETS.EPIC ? createEpic : createStory;
      if (typeof createPort !== 'function') {
        throw new Error(
          `promoteFindings: a ${target === PROMOTION_TARGETS.EPIC ? 'createEpic' : 'createStory'} port is required to promote cluster ${cluster.key}`,
        );
      }
      issue = await createPort(cluster);
      created = true;
    } else {
      // Already filed (open match, duplicate, or regression of a closed
      // ticket) — link back to the matched Issue instead of duplicating.
      issue = {
        number: route.matchedIssue.number,
        url: route.matchedIssue.url,
      };
    }

    const kind = created ? target : 'issue';
    const link = routedToLink(issue, kind);

    // Write the routedTo link back onto each contributing ledger item.
    for (const item of cluster.items) {
      item.routedTo = { ...link };
    }

    promotions.push({
      clusterKey: cluster.key,
      target,
      decision: route.decision,
      created,
      issue: issue.number,
      routedTo: link,
      itemIds: cluster.items.map((i) => i.id),
    });
  }

  const promotedItemCount = promotions.reduce(
    (sum, p) => sum + p.itemIds.length,
    0,
  );

  return {
    promotions,
    skipped:
      ledgerItems.filter((i) => i && typeof i === 'object').length -
      promotedItemCount,
  };
}

export const __testing = {
  EPIC_COVERAGE_THRESHOLD,
  TRIAGED_DISPOSITIONS,
  clusterKeyFor,
  clusterToFinding,
  highestSeverity,
  fingerprintFinding,
};
