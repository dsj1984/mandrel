/**
 * phases/authoring-context.js — builds the JSON-serialisable authoring
 * context the `/mandrel-plan` author step needs.
 */

import path from 'node:path';
import {
  resolveFeatureRoots,
  verifyBddRunnerPendingTag,
} from '../../bdd-runner-detect.js';
import { capBddScenarios } from '../../bdd-scenario-budget.js';
import { scanBddScenarios } from '../../bdd-scenario-scanner.js';
import { getPaths, PROJECT_ROOT } from '../../config-resolver.js';
import { fetchPriorFeedback } from '../../feedback-loop/prior-feedback-fetcher.js';
import { Logger } from '../../Logger.js';
import { hasTicketSection } from '../../ticket-body-sections.js';
import {
  concurrentMap,
  FANOUT_CONCURRENCY,
} from '../../util/concurrent-map.js';
import { ensureDocsDigest } from '../docs-digest.js';
import { buildMemoryPoolAdvisory } from './memory-pool-advisory.js';

/**
 * Digest-first `docsContext`: ensure the docs digest at the same per-Epic
 * temp path delivery consumes, and carry only its path. `null` when
 * `project.docsContextFiles` is unset — there is no scrape-all fallback.
 *
 * @param {{ seedIssueId: number, settings: object, cwd: string }} args
 * @returns {Promise<{ mode: 'digest', digestPath: string } | null>}
 */
async function buildPlanningDocsContext({ seedIssueId, settings, cwd }) {
  const docsContextFiles = Array.isArray(settings?.docsContextFiles)
    ? settings.docsContextFiles
    : [];
  if (docsContextFiles.length === 0) return null;

  const paths = getPaths({ project: { paths: settings?.paths } });
  const docsRoot = path.resolve(cwd, paths.docsRoot);
  const relPath = path.join(
    paths.tempRoot,
    `epic-${seedIssueId}`,
    'docs-digest.md',
  );
  const absPath = path.resolve(cwd, relPath);

  const result = await ensureDocsDigest({
    docsContextFiles,
    docsRoot,
    outputPath: absPath,
  });
  if (!result) return null;
  return { mode: 'digest', digestPath: relPath };
}

/**
 * Best-effort `.feature` scenario index, capped to the byte budget so a large
 * Gherkin corpus cannot consume the context-envelope ceiling.
 *
 * @returns {ReturnType<typeof capBddScenarios>}
 */
function scanBddScenariosBestEffort() {
  try {
    const featureRoots = resolveFeatureRoots({ cwd: PROJECT_ROOT });
    return capBddScenarios(scanBddScenarios({ featureRoots }));
  } catch (err) {
    Logger.warn(`[plan-context] BDD scenario scan skipped: ${err.message}`);
    return capBddScenarios([]);
  }
}

/**
 * The `epic.body` carried here is unbounded; envelope size is guarded by
 * `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING` in `plan-context.js`.
 */
export async function buildAuthoringContext(
  seedIssueId,
  provider,
  settings = {},
  opts = {},
) {
  // A prefetched `opts.epic` saves a second provider fetch.
  const epic = opts.epic ?? (await provider.getEpic(seedIssueId));
  if (!epic) {
    throw new Error(`Epic #${seedIssueId} not found.`);
  }

  const { cwd = PROJECT_ROOT } = opts;

  const githubCfg = opts.github ?? null;

  // Independent gathers under bounded concurrency; `concurrentMap` preserves
  // input order, so the destructuring is positional.
  const [
    docsContext,
    bddRunner,
    bddScenarios,
    memoryPoolAdvisory,
    priorFeedback,
  ] = await concurrentMap(
    [
      () => buildPlanningDocsContext({ seedIssueId: epic.id, settings, cwd }),
      () => verifyBddRunnerPendingTag({ cwd: PROJECT_ROOT }),
      () => scanBddScenariosBestEffort(),
      () => buildMemoryPoolAdvisory({ cwd: PROJECT_ROOT }),
      () =>
        fetchPriorFeedback({
          owner: githubCfg?.owner,
          repo: githubCfg?.repo,
        }),
    ],
    (gather) => gather(),
    { concurrency: FANOUT_CONCURRENCY },
  );

  return {
    epic: {
      id: epic.id,
      title: epic.title,
      body: epic.body ?? null,
      // A re-plan's prior managed sections ride in `body`, keeping AC IDs stable.
      planningSections: {
        techSpec: hasTicketSection(epic.body ?? '', 'techSpec'),
        acceptanceTable: hasTicketSection(epic.body ?? '', 'acceptanceTable'),
      },
    },
    docsContext,
    bddRunner,
    bddScenarios,
    memoryPoolAdvisory,
    priorFeedback,
  };
}
