#!/usr/bin/env node

/**
 * resolve-plan-run.js — resolve Stories labeled `plan-run::<id>` for
 * `/deliver --run <planRunId>` (v2 Stage 4).
 *
 * Thin CLI: list open (or all) issues carrying the plan-run label, keep
 * `type::story` tickets, and emit a JSON envelope the deliver router feeds
 * into `stories-wave-tick.js`. Dependency edges come from Story bodies
 * (`blocked by` / `depends on`) via `buildStoryAdjacency`.
 *
 * Usage:
 *   node .agents/scripts/resolve-plan-run.js --run <planRunId>
 *   node .agents/scripts/resolve-plan-run.js --run <planRunId> --state all
 *   node .agents/scripts/resolve-plan-run.js --run <planRunId> --pretty
 *
 * Exit codes: 0 ok, 1 usage/error, 2 no Stories found for the run.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { PLAN_RUN_LABEL_PREFIX } from './lib/orchestration/plan-persist/story-ops.js';
import { createProvider } from './lib/provider-factory.js';
import { buildStoryAdjacency } from './lib/story-adjacency.js';

const HELP = `\
Usage:
  resolve-plan-run.js --run <planRunId> [--state open|all|closed] [--pretty]

Resolve Stories labeled plan-run::<planRunId> for /deliver --run.

Options:
  --run <id>     Plan-run token (with or without the plan-run:: prefix).
  --state <s>    Issue state filter (default: open).
  --pretty       Pretty-print the JSON envelope.
  --help         Show this help.
`;

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
 * Map provider issues into the deliver-router story list + DAG nodes.
 *
 * @param {object[]} issues
 * @param {{ planRunId: string, planRunLabel: string }} meta
 * @returns {{ planRunId: string, planRunLabel: string, stories: object[], dag: object[] }}
 */
export function buildPlanRunEnvelope(issues, { planRunId, planRunLabel }) {
  const stories = (Array.isArray(issues) ? issues : [])
    .map((issue) => {
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
    })
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);

  const adjacency = buildStoryAdjacency(stories, { dropForeign: false });
  const dag = stories.map((s) => ({
    id: s.id,
    dependsOn: adjacency.get(s.id) ?? [],
  }));

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
    dag,
  };
}

/**
 * @param {object} issue
 * @returns {string[]}
 */
function normalizeIssueLabels(issue) {
  const raw = issue?.labels;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string' && n.length > 0);
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
  // GitHub REST ANDs comma-separated labels — keep the filter tight.
  const labels = `${planRunLabel},${TYPE_LABELS.STORY}`;
  const issues = await provider.listIssuesByLabel({ state, labels });
  return Array.isArray(issues) ? issues : [];
}

/**
 * Pure core used by tests: given issues + meta, build the envelope.
 * CLI wraps this after the provider fetch.
 *
 * @param {object} args
 * @param {string} args.run
 * @param {object[]} args.issues
 * @returns {ReturnType<typeof buildPlanRunEnvelope>}
 */
export function resolvePlanRunFromIssues({ run, issues }) {
  const planRunLabel = normalizePlanRunLabel(run);
  const planRunId = planRunIdFromLabel(planRunLabel);
  return buildPlanRunEnvelope(issues, { planRunId, planRunLabel });
}

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      state: { type: 'string', default: 'open' },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.run) {
    process.stderr.write(HELP);
    throw new Error('resolve-plan-run: --run <planRunId> is required');
  }

  const state = values.state ?? 'open';
  if (!['open', 'closed', 'all'].includes(state)) {
    throw new Error(
      `resolve-plan-run: --state must be open|closed|all (got ${state})`,
    );
  }

  const planRunLabel = normalizePlanRunLabel(values.run);
  const planRunId = planRunIdFromLabel(planRunLabel);

  resolveConfig();
  const provider = createProvider();
  const issues = await fetchPlanRunIssues(provider, { planRunLabel, state });
  const envelope = buildPlanRunEnvelope(issues, { planRunId, planRunLabel });

  const text = values.pretty
    ? `${JSON.stringify(envelope, null, 2)}\n`
    : `${JSON.stringify(envelope)}\n`;
  process.stdout.write(text);

  if (envelope.stories.length === 0) {
    process.stderr.write(
      `resolve-plan-run: no type::story issues with label ${planRunLabel} (state=${state})\n`,
    );
    return 2;
  }
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'resolve-plan-run',
  propagateExitCode: true,
});
