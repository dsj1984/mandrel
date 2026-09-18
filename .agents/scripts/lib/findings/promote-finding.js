/**
 * lib/findings/promote-finding.js — promote clustered untriaged QA ledger
 * items to a Story or plan-seed via `routeFinding`, stamping `routedTo` on
 * each item so a resume does not re-promote. Ports are injected.
 */

import { fingerprintFinding, routeFinding } from './route-finding.js';
import { highestSeverity as highestSeverityOf } from './severity.js';

const TRIAGED_DISPOSITIONS = Object.freeze(['file', 'defer', 'dismiss']);

/** `PLAN_SEED` stays `'epic'` on the wire: archived ledgers and the schema enum carry it. */
export const PROMOTION_TARGETS = Object.freeze({
  STORY: 'story',
  PLAN_SEED: 'epic',
});

/** More distinct coverage surfaces than this → plan-seed instead of a Story. */
const EPIC_COVERAGE_THRESHOLD = 2;

/**
 * @param {{ disposition?: unknown, routedTo?: unknown }} item
 * @returns {boolean}
 */
export function isPromotable(item) {
  if (item === null || typeof item !== 'object') return false;
  if (item.routedTo) return false;
  const disposition = item.disposition;
  if (disposition === 'defer' || disposition === 'dismiss') return false;
  if (disposition === 'file') return true;
  return !TRIAGED_DISPOSITIONS.includes(disposition);
}

/**
 * Coverage sizes a cluster; it never splits one.
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
 * @param {Array<{ severity?: string }>} items
 * @returns {string}
 */
function highestSeverity(items) {
  return highestSeverityOf(items.map((item) => item?.severity));
}

/**
 * @param {Array<object>} items
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
 * @param {{ coverages: string[] }} cluster
 * @returns {'story'|'epic'}
 */
export function targetForCluster(cluster) {
  const surfaces = Array.isArray(cluster?.coverages)
    ? cluster.coverages.length
    : 0;
  return surfaces > EPIC_COVERAGE_THRESHOLD
    ? PROMOTION_TARGETS.PLAN_SEED
    : PROMOTION_TARGETS.STORY;
}

/**
 * The class is a label so same-titled clusters of different classes
 * fingerprint distinctly.
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
 * `routedTo.url` is `minLength: 1` in the schema, so an empty url throws.
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
 * On `new`, create via the target's port; otherwise link to the matched
 * Issue. Items are mutated in place so a `qa-session` append persists the link.
 *
 * @param {Array<object>} ledgerItems
 * @param {object} ports
 * @param {(sha: string) => Promise<Array<{ number: number, state: string, body?: string }>>} [ports.searchIssues]
 * @param {(finding: object) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [ports.searchCandidates]
 * @param {(cluster: object) => Promise<{ number: number, url?: string }>} ports.createStory
 * @param {(cluster: object) => Promise<{ number: number, url?: string }>} ports.createPlanSeed
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
  const { searchIssues, searchCandidates, createStory, createPlanSeed } = ports;
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
        target === PROMOTION_TARGETS.PLAN_SEED ? createPlanSeed : createStory;
      if (typeof createPort !== 'function') {
        throw new Error(
          `promoteFindings: a ${target === PROMOTION_TARGETS.PLAN_SEED ? 'createPlanSeed' : 'createStory'} port is required to promote cluster ${cluster.key}`,
        );
      }
      issue = await createPort(cluster);
      created = true;
    } else {
      issue = {
        number: route.matchedIssue.number,
        url: route.matchedIssue.url,
      };
    }

    const kind = created ? target : 'issue';
    const link = routedToLink(issue, kind);

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
