#!/usr/bin/env node

/**
 * delete-epic.js — Recursively delete an Epic and all child issues from GitHub.
 *
 * Uses the GitHub GraphQL API (sub-issues + deleteIssue mutation).
 * Token resolution: GITHUB_TOKEN / GH_TOKEN env var → `gh auth token` fallback.
 *
 * Usage:
 *   node .agents/scripts/delete-epic.js <epic_number> [--dry-run]
 *
 * Options:
 *   --dry-run   List all issues that would be deleted without actually deleting.
 *
 * Environment:
 *   GITHUB_TOKEN or GH_TOKEN — A PAT with `repo` scope (required for deletion).
 *
 * The owner/repo is resolved from the git remote origin URL automatically.
 */

import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';
import { concurrentMap } from './lib/util/concurrent-map.js';

// Cap=4 — bounded parallelism for the recursive sibling-subtree walk in
// `collectTree`. Sibling subtrees are independent (each child traverses its
// own descendants), and ordering within a parent's children does not affect
// the deletion contract — the leaves-first invariant is enforced after the
// full tree is collected. Cap matches the orchestration-layer house style.
const COLLECT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Core Logic
// ---------------------------------------------------------------------------

/**
 * Fetch an issue's node ID and sub-issues (recursive children).
 * @param {object} provider
 * @param {number} issueNumber
 * @returns {Promise<{ nodeId: string, title: string, subIssues: number[] }>}
 */
async function getIssueWithSubIssues(provider, issueNumber) {
  const data = await provider.graphql(
    `
    query($owner: String!, $repo: String!, $num: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $num) {
          id
          title
          subIssues(first: 100) {
            nodes {
              number
            }
          }
        }
      }
    }`,
    { owner: provider.owner, repo: provider.repo, num: issueNumber },
    { headers: { 'GraphQL-Features': 'sub_issues' } },
  );

  const issue = data.repository.issue;
  if (!issue) {
    throw new Error(
      `Issue #${issueNumber} not found in ${provider.owner}/${provider.repo}.`,
    );
  }

  return {
    nodeId: issue.id,
    title: issue.title,
    subIssues: issue.subIssues.nodes.map((n) => n.number),
  };
}

/**
 * Delete a single issue by its GraphQL node ID.
 * @param {object} provider
 * @param {string} nodeId
 */
async function deleteIssue(provider, nodeId) {
  await provider.graphql(
    `
    mutation($issueId: ID!) {
      deleteIssue(input: { issueId: $issueId }) {
        repository { name }
      }
    }`,
    { issueId: nodeId },
  );
}

/**
 * Recursively collect all issues in the sub-issue tree (depth-first).
 * Returns them in deletion order (leaves first, root last).
 *
 * @param {object} provider
 * @param {number} issueNumber
 * @param {Set<number>} visited - Cycle guard.
 * @returns {Promise<Array<{ number: number, nodeId: string, title: string }>>}
 */
async function collectTree(provider, issueNumber, visited = new Set()) {
  if (visited.has(issueNumber)) return [];
  visited.add(issueNumber);

  const issue = await getIssueWithSubIssues(provider, issueNumber);

  // cap=4 — bounded fan-out across sibling subtrees. Each child traversal
  // is independent of its siblings, and we still flatten in deterministic
  // input order so the tail-append (parent last) preserves leaves-first
  // deletion ordering.
  const childResults = await concurrentMap(
    issue.subIssues,
    (childNumber) => collectTree(provider, childNumber, visited),
    { concurrency: COLLECT_CONCURRENCY },
  );

  const results = childResults.flat();

  // Add the current issue last (after all children)
  results.push({
    number: issueNumber,
    nodeId: issue.nodeId,
    title: issue.title,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const excludeRoot = args.includes('--exclude-root');
  const epicNumber = Number.parseInt(
    args.find((a) => !a.startsWith('--')),
    10,
  );

  if (!epicNumber || Number.isNaN(epicNumber)) {
    Logger.fatal('Usage: node delete-epic.js <epicNumber>');
  }

  const { orchestration } = resolveConfig();
  const provider = createProvider(orchestration);
  const owner = provider.owner;
  const repo = provider.repo;

  Logger.info(`\nTarget: ${owner}/${repo} Epic #${epicNumber}`);
  Logger.info(`Mode:   ${dryRun ? 'DRY RUN (no deletions)' : 'LIVE'}`);
  if (excludeRoot) {
    Logger.info('Option: --exclude-root (Keeping the Epic issue itself)\n');
  } else {
    Logger.info('\n');
  }

  // 1. Collect the full issue tree
  Logger.info('Collecting issue tree...');
  let tree;
  try {
    tree = await collectTree(provider, epicNumber);
    if (excludeRoot) {
      // The root issue (epicNumber) is always the LAST element in the depth-first result
      tree = tree.filter((issue) => issue.number !== epicNumber);
    }
  } catch (err) {
    Logger.fatal(`[delete-epic] Failed to collect issue tree: ${err.message}`);
  }

  Logger.info(`Found ${tree.length} issue(s) to delete:\n`);
  for (const issue of tree) {
    Logger.info(`  #${issue.number} — ${issue.title}`);
  }

  if (dryRun) {
    Logger.info('\n✅ Dry run complete. No issues were deleted.');
    return;
  }

  // 2. Delete in order (children first)
  Logger.info('\nDeleting issues...\n');
  let deleted = 0;
  let failed = 0;

  for (const issue of tree) {
    try {
      await deleteIssue(provider, issue.nodeId);
      deleted++;
      Logger.info(`  ✓ Deleted #${issue.number} — ${issue.title}`);
    } catch (err) {
      failed++;
      Logger.error(`  ✗ Failed #${issue.number}: ${err.message}`);
    }
  }

  Logger.info(
    `\n✅ Recursive deletion complete. Deleted: ${deleted}, Failed: ${failed}`,
  );
}

// cli-opt-out: top-level main().catch predates runAsCli; never imported elsewhere so the auto-run risk is moot.
main().catch((err) => {
  Logger.fatal(`[delete-epic] Fatal error: ${err.message ?? err}`);
});
