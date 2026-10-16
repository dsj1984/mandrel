#!/usr/bin/env node

/**
 * board-backfill.js — catch the Projects v2 board up with the issues it
 * missed (typically while the token lacked the `project` scope). Lists open
 * `type::story` / `type::epic` issues, adds the ones not on the board (the
 * add mutation is idempotent), and sets a Story's Status from its `agent::*`
 * label through `ColumnSync`. Epics are added but their Status is left to the
 * epic rollup. Re-running is a no-op. Prints a JSON summary on stdout.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import {
  isProjectAccessFailure,
  toProjectAccessError,
} from './lib/orchestration/board-access-latch.js';
import {
  ColumnSync,
  columnForLabels,
} from './lib/orchestration/column-sync.js';
import {
  ProjectAccessError,
  resolveProjectMeta,
} from './lib/orchestration/project-meta-resolver.js';
import { createProvider } from './lib/provider-factory.js';

const BOARD_TYPE_LABELS = Object.freeze(['type::story', 'type::epic']);

const OPEN_ISSUES_QUERY = `
  query($owner: String!, $repo: String!, $label: String!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(states: OPEN, labels: [$label], first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          id
          labels(first: 50) { nodes { name } }
          projectItems(first: 20) {
            nodes {
              id
              project { id }
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
            }
          }
        }
      }
    }
  }`;

const ADD_ITEM_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }`;

/**
 * Raise a scope/auth refusal as the typed error; return anything else.
 *
 * @param {unknown} err
 * @returns {unknown}
 */
function classify(err) {
  if (isProjectAccessFailure(err)) throw toProjectAccessError(err);
  return err;
}

/**
 * Open issues carrying any board type label, deduped by number.
 *
 * @param {{ graphql: Function, owner: string, repo: string }} provider
 * @returns {Promise<Array<{ number: number, nodeId: string, labels: string[], items: object[] }>>}
 */
export async function listBoardCandidates(provider) {
  const byNumber = new Map();
  for (const label of BOARD_TYPE_LABELS) {
    let after = null;
    do {
      let data;
      try {
        data = await provider.graphql(OPEN_ISSUES_QUERY, {
          owner: provider.owner,
          repo: provider.repo,
          label,
          after,
        });
      } catch (err) {
        throw classify(err);
      }
      const page = data?.repository?.issues;
      for (const node of page?.nodes ?? []) {
        if (!node || byNumber.has(node.number)) continue;
        byNumber.set(node.number, {
          number: node.number,
          nodeId: node.id,
          labels: (node.labels?.nodes ?? []).map((l) => l.name),
          items: node.projectItems?.nodes ?? [],
        });
      }
      after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * What the board needs for one issue: an add, a Status sync, both, or
 * nothing. Epics never get a Status target here.
 *
 * @param {{ labels: string[], items: object[] }} issue
 * @param {string} projectId
 */
export function planIssue(issue, projectId) {
  const isEpic = issue.labels.includes('type::epic');
  const target = isEpic ? null : columnForLabels(issue.labels);
  const item = issue.items.find((n) => n?.project?.id === projectId);
  const current = item?.fieldValueByName?.name ?? null;
  return {
    number: issue.number,
    type: isEpic ? 'epic' : 'story',
    add: !item,
    status: target && target !== current ? target : null,
  };
}

/**
 * @param {{
 *   provider: { graphql: Function, owner: string, repo: string, projectNumber?: number|null, projectOwner?: string|null },
 *   config?: object,
 *   dryRun?: boolean,
 *   columnSync?: { sync: Function },
 * }} args
 * @returns {Promise<{ dryRun: boolean, added: number, synced: number, skipped: number, failed: number, planned: object[] }>}
 * @throws {ProjectAccessError} when the token cannot read or write the board.
 */
export async function runBackfill({
  provider,
  config,
  dryRun = false,
  columnSync,
}) {
  const projectNumber =
    config?.github?.projectNumber ?? provider.projectNumber ?? null;
  if (!projectNumber) {
    throw new Error(
      'No github.projectNumber configured — nothing to backfill.',
    );
  }
  const project = await resolveProjectMeta({
    provider,
    owner: provider.projectOwner ?? provider.owner ?? null,
    projectNumber,
    projectFields: 'id',
  });
  if (!project) {
    throw new Error(`Project #${projectNumber} not found.`);
  }
  const sync =
    columnSync ??
    new ColumnSync({ provider, projectNumber, logger: Logger, config });
  const summary = { dryRun, added: 0, synced: 0, skipped: 0, failed: 0 };
  const planned = [];
  for (const issue of await listBoardCandidates(provider)) {
    const plan = planIssue(issue, project.id);
    if (!plan.add && !plan.status) {
      summary.skipped += 1;
      continue;
    }
    planned.push(plan);
    if (dryRun) continue;
    await applyPlan({
      plan,
      issue,
      provider,
      projectId: project.id,
      sync,
      summary,
    });
  }
  return { ...summary, planned };
}

async function applyPlan({ plan, issue, provider, projectId, sync, summary }) {
  if (plan.add) {
    try {
      await provider.graphql(ADD_ITEM_MUTATION, {
        projectId,
        contentId: issue.nodeId,
      });
      summary.added += 1;
    } catch (err) {
      classify(err);
      Logger.warn(
        `[board-backfill] could not add #${issue.number}: ${err?.message ?? err}`,
      );
      summary.failed += 1;
      return;
    }
  }
  if (!plan.status) return;
  const result = await sync
    .sync(issue.number, issue.labels)
    .catch((err) => ({ status: 'failed', error: classify(err) }));
  if (result?.reason === 'insufficient-scope') {
    throw toProjectAccessError(new Error('Status update refused'));
  }
  if (result?.status === 'synced') summary.synced += 1;
  else summary.failed += 1;
}

/* node:coverage ignore next */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean', default: false } },
    strict: true,
  });
  routeAllOutputToStderr();
  const config = resolveConfig();
  const provider = createProvider(config);
  try {
    const result = await runBackfill({
      provider,
      config,
      dryRun: values['dry-run'],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      process.stderr.write(
        `[board-backfill] ${err.message}\nRemedy: ${err.remedy}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

runAsCli(import.meta.url, main, {
  source: 'board-backfill',
  usage: {
    invocation: 'node .agents/scripts/board-backfill.js [--dry-run]',
    summary:
      "Add open type::story / type::epic issues missing from the configured Projects v2 board and sync each Story's Status from its agent::* label. Idempotent; prints a JSON summary { added, synced, skipped, failed } on stdout.",
    flags: [
      ['--dry-run', 'List what would be added or synced; change nothing.'],
      ['--help', 'Show this message.'],
    ],
  },
});
