/**
 * Pure helpers for resolve-plan-run.js — keep the CLI entry thin so new-file
 * CRAP stays under the quality-preview ceiling.
 *
 * @module lib/orchestration/resolve-plan-run
 */

import { TYPE_LABELS } from '../label-constants.js';
import { buildStoryAdjacency } from '../story-adjacency.js';
import { PLAN_RUN_LABEL_PREFIX } from './plan-persist/story-ops.js';

/**
 * Normalize a plan-run id into the canonical label `plan-run::<token>`.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizePlanRunLabel(raw) {
  const token = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^plan-run::/, '');
  if (!token) {
    throw new Error('resolve-plan-run: --run requires a non-empty planRunId');
  }
  return `${PLAN_RUN_LABEL_PREFIX}${token}`;
}

/**
 * Extract a bare plan-run id from a label or raw token.
 *
 * @param {string} label
 * @returns {string}
 */
export function planRunIdFromLabel(label) {
  return String(label ?? '')
    .trim()
    .replace(new RegExp(`^${PLAN_RUN_LABEL_PREFIX}`), '');
}

/**
 * @param {object} issue
 * @returns {string[]}
 */
export function normalizeIssueLabels(issue) {
  const raw = issue?.labels;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string' && n.length > 0);
}

/**
 * @param {object} issue
 * @returns {{ id: number, title: string, body: string, url: string|null, labels: string[] }|null}
 */
export function toStoryRecord(issue) {
  const id = Number(issue?.number ?? issue?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const labels = normalizeIssueLabels(issue);
  if (!labels.includes(TYPE_LABELS.STORY)) return null;
  return {
    id,
    title: String(issue?.title ?? ''),
    body: String(issue?.body ?? ''),
    url: issue?.html_url ?? issue?.url ?? null,
    labels,
  };
}

/**
 * @param {object[]} stories
 * @returns {{ id: number, dependsOn: number[] }[]}
 */
export function storiesToDag(stories) {
  const adjacency = buildStoryAdjacency(stories, { dropForeign: false });
  return stories.map((s) => ({
    id: s.id,
    dependsOn: adjacency.get(s.id) ?? [],
  }));
}

/**
 * Map provider issues into the deliver-router story list + DAG nodes.
 *
 * @param {object[]} issues
 * @param {{ planRunId: string, planRunLabel: string }} meta
 * @returns {{ kind: string, planRunId: string, planRunLabel: string, stories: object[], dag: object[] }}
 */
export function buildPlanRunEnvelope(issues, { planRunId, planRunLabel }) {
  const stories = (Array.isArray(issues) ? issues : [])
    .map(toStoryRecord)
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);

  return {
    kind: 'plan-run',
    planRunId,
    planRunLabel,
    stories: stories.map(({ id, title, url, labels }) => ({
      id,
      title,
      url,
      labels,
    })),
    dag: storiesToDag(stories),
  };
}

/**
 * Pure core used by tests: given issues + meta, build the envelope.
 *
 * @param {{ run: string, issues: object[] }} args
 * @returns {ReturnType<typeof buildPlanRunEnvelope>}
 */
export function resolvePlanRunFromIssues({ run, issues }) {
  const planRunLabel = normalizePlanRunLabel(run);
  const planRunId = planRunIdFromLabel(planRunLabel);
  return buildPlanRunEnvelope(issues, { planRunId, planRunLabel });
}

/**
 * Fetch issues for a plan-run label via the ticketing provider.
 *
 * @param {object} provider
 * @param {{ planRunLabel: string, state: string }} args
 * @returns {Promise<object[]>}
 */
export async function fetchPlanRunIssues(provider, { planRunLabel, state }) {
  if (typeof provider?.listIssuesByLabel !== 'function') {
    throw new Error('resolve-plan-run: provider.listIssuesByLabel is required');
  }
  const labels = `${planRunLabel},${TYPE_LABELS.STORY}`;
  const issues = await provider.listIssuesByLabel({ state, labels });
  return Array.isArray(issues) ? issues : [];
}

/**
 * @param {string|undefined} state
 * @returns {string}
 */
export function assertIssueState(state) {
  const value = state ?? 'open';
  if (!['open', 'closed', 'all'].includes(value)) {
    throw new Error(
      `resolve-plan-run: --state must be open|closed|all (got ${value})`,
    );
  }
  return value;
}
