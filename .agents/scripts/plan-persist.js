#!/usr/bin/env node

/**
 * plan-persist.js — validate authored plan artifacts and create the Story
 * issue(s). Without `--dry-run` it runs the write-free dry-run first and
 * persists in the same invocation only if every gate passes. stdout carries
 * only the JSON result; logs go to stderr.
 *
 * Exit codes: 0 success; 1 fatal; 3 reachability orphans (nothing mutated).
 */

import './lib/runtime-deps/ensure-installed.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import {
  readPlanMetrics,
  recordPlanInvocation,
  renderPlanMetricsSummaryLine,
  summarizePlanMetrics,
} from './lib/orchestration/plan-metrics.js';
import {
  loadPlanContextEnvelope,
  resolvePlanContextPath,
} from './lib/orchestration/plan-persist/plan-context-source.js';
import {
  runPlanPersist,
  writePlanSummaryComment,
} from './lib/orchestration/plan-persist/run-plan-persist.js';
import {
  buildPlanSummaryCommentBody,
  buildWaveTable,
} from './lib/orchestration/plan-persist/summary.js';
import { resolveSourceTicketIds } from './lib/orchestration/plan-persist/supersede-ops.js';
import { createProvider } from './lib/provider-factory.js';

export {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  runPlanPersist,
  writePlanSummaryComment,
};

const CLI_OPTIONS = {
  stories: { type: 'string' },
  'tech-spec': { type: 'string' },
  'plan-dir': { type: 'string' },
  'plan-context': { type: 'string' },
  'source-tickets': { type: 'string' },
  'close-superseded': { type: 'boolean', default: true },
  'no-close-superseded': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'force-review': { type: 'boolean', default: false },
  'epic-title': { type: 'string' },
  'epic-goal': { type: 'string' },
  epic: { type: 'string' },
};

const USAGE =
  'Usage: plan-persist.js --stories <file> ' +
  '[--tech-spec <file>] [--plan-dir <dir>] [--plan-context <file>] ' +
  '[--source-tickets <ids>] [--no-close-superseded] ' +
  '[--dry-run] [--force-review] ' +
  '[--epic-title <text> --epic-goal <text> | --epic <id>]';

async function readOptional(filePath, { required }) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (!required && err?.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${filePath}: ${err.message}`);
  }
}

async function readJsonFile(filePath, label) {
  const raw = await readOptional(filePath, { required: true });
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${label} file "${filePath}" as JSON: ${err.message}`,
    );
  }
}

/**
 * @param {object} values Parsed `parseArgs` values.
 */
export function resolveInputPaths(values) {
  const planDir = values['plan-dir'] ? path.resolve(values['plan-dir']) : null;
  return {
    storiesPath: path.resolve(values.stories),
    techSpecPath: values['tech-spec']
      ? path.resolve(values['tech-spec'])
      : null,
    planDir,
    planContextPath: resolvePlanContextPath(values['plan-context'], planDir),
  };
}

async function loadArtifacts(paths) {
  const stories = await readJsonFile(paths.storiesPath, 'stories');
  const techSpecContent = paths.techSpecPath
    ? await readOptional(paths.techSpecPath, { required: true })
    : null;
  const planContextEnvelope = await loadPlanContextEnvelope(
    paths.planContextPath,
  );

  return {
    stories,
    techSpecContent,
    planContextEnvelope,
  };
}

/**
 * Title and goal are required together; exactly one is a usage error rather
 * than a silent no-Epic run.
 *
 * @param {object} values
 * @returns {{ title: string, goal: string }|null}
 */
export function resolveEpicRequest(values) {
  const title = (values['epic-title'] ?? '').trim();
  const goal = (values['epic-goal'] ?? '').trim();
  if (title === '' && goal === '') return null;
  if (title === '' || goal === '') {
    throw new Error(
      '[plan-persist] --epic-title and --epic-goal must be supplied together ' +
        '(a container Epic needs both a name and a one-paragraph reason it ' +
        'groups these Stories).',
    );
  }
  return { title, goal };
}

/**
 * A run joins an Epic or opens one, never both.
 *
 * @param {object} values
 * @returns {void}
 * @throws {Error}
 */
export function assertEpicFlagsExclusive(values) {
  const adopts = (values.epic ?? '').trim() !== '';
  const creates =
    (values['epic-title'] ?? '').trim() !== '' ||
    (values['epic-goal'] ?? '').trim() !== '';
  if (adopts && creates) {
    throw new Error(
      '[plan-persist] --epic (join an existing container) and ' +
        '--epic-title/--epic-goal (open a new one) are mutually exclusive — ' +
        'a run either adopts an Epic or creates one, never both.',
    );
  }
}

/**
 * `--epic <id>` shape check before any provider call; existence is verified
 * later against live state.
 *
 * @param {object} values
 * @returns {number|null}
 */
export function resolveEpicAdoptionId(values) {
  const raw = (values.epic ?? '').trim();
  if (raw === '') return null;
  const id = Number.parseInt(raw.replace(/^#/, ''), 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[plan-persist] --epic expects a positive issue id (got "${raw}").`,
    );
  }
  return id;
}

/**
 * Where envelope-derived source ids meet the engine; a break here silently
 * un-wires `--tickets` superseding.
 *
 * @param {object} values
 * @param {ReturnType<typeof resolveInputPaths>} paths
 * @param {object|null} planContextEnvelope
 * @returns {object}
 */
export function buildPersistOptions(values, paths, planContextEnvelope) {
  const source = resolveSourceTicketIds({
    explicitIds: values['source-tickets'],
    envelope: planContextEnvelope,
  });

  return {
    forceReview: values['force-review'],
    dryRun: values['dry-run'],
    planDir: paths.planDir,
    skipCleanup: values['dry-run'],
    sourceTicketIds: source.ids,
    sourceTicketOrigin: source.origin,
    epic: resolveEpicRequest(values),
    adoptEpicId: resolveEpicAdoptionId(values),
    // `--no-close-superseded` always wins.
    closeSuperseded:
      values['no-close-superseded'] === true
        ? false
        : values['close-superseded'] !== false,
  };
}

async function runPersistInvocation({
  values,
  config,
  provider,
  artifacts,
  metricsSince,
  dryRun,
}) {
  const paths = resolveInputPaths(values);
  const effectiveDryRun =
    typeof dryRun === 'boolean' ? dryRun : values['dry-run'] === true;

  return recordPlanInvocation(
    {
      cli: 'plan-persist',
      mode: effectiveDryRun ? 'dry-run' : 'persist',
      config,
    },
    () =>
      runPlanPersist({
        provider,
        artifacts,
        config,
        opts: {
          ...buildPersistOptions(values, paths, artifacts.planContextEnvelope),
          dryRun: effectiveDryRun,
          skipCleanup: effectiveDryRun,
          metricsSince,
        },
      }),
  );
}

/**
 * Dry-run then persist over the SAME artifacts: a gate failure throws before
 * any issue exists, and the write replays exactly what was validated. The
 * repair pass mutates tickets in place, so pass 2 sees no repairs — carry pass
 * 1's evidence onto the returned envelope.
 *
 * @param {{ values: object, config: object, provider: object,
 *   artifacts: object, metricsSince: string }} args
 * @returns {Promise<object>} the persist result, plus a `chain` receipt.
 */
export async function runPersistChain({
  values,
  config,
  provider,
  artifacts,
  metricsSince,
}) {
  const dryResult = await runPersistInvocation({
    values,
    config,
    provider,
    artifacts,
    metricsSince,
    dryRun: true,
  });

  const persistResult = await runPersistInvocation({
    values,
    config,
    provider,
    artifacts,
    metricsSince,
    dryRun: false,
  });
  persistResult.repairs = mergeEvidence(
    dryResult.repairs,
    persistResult.repairs,
  );
  persistResult.warnings = mergeEvidence(
    dryResult.warnings,
    persistResult.warnings,
  );
  persistResult.chain = {
    attempted: true,
    persisted: true,
    reason: 'dry-run-clean',
  };
  return persistResult;
}

/**
 * Ordered union, deduped by serialized content.
 *
 * @param {unknown} first
 * @param {unknown} second
 * @returns {unknown[]}
 */
function mergeEvidence(first, second) {
  const merged = [];
  const seen = new Set();
  for (const entry of [
    ...(Array.isArray(first) ? first : []),
    ...(Array.isArray(second) ? second : []),
  ]) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/**
 * @param {object} values
 * @returns {boolean} `true` to run the gates and then persist.
 */
export function shouldChainPersist(values) {
  return values?.['dry-run'] !== true;
}

/**
 * Attach the plan-metrics roll-up for this invocation. The Epic-less (`null`)
 * ledger is shared by every plan run, so `since` scopes it to this one.
 *
 * @param {object} result Mutated in place with `planMetrics`.
 * @param {object} config
 * @param {string} since ISO-8601 instant this invocation started.
 */
async function attachPlanMetrics(result, config, since) {
  try {
    const summary = summarizePlanMetrics(await readPlanMetrics(null, config), {
      since,
    });
    if (summary) {
      result.planMetrics = summary;
      Logger.info(`[plan-persist] ${renderPlanMetricsSummaryLine(summary)}`);
    }
  } catch (err) {
    Logger.warn(`[plan-persist] plan-metrics summary skipped: ${err.message}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: CLI_OPTIONS });

  if (!values.stories) {
    throw new Error(USAGE);
  }

  // stdout is reserved for the JSON result.
  routeAllOutputToStderr();

  // Stamped before any ledger write so this run's records fall inside it.
  const metricsSince = new Date().toISOString();

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }
  // Argument-shape refusals fire before any I/O.
  assertEpicFlagsExclusive(values);
  resolveEpicRequest(values);
  resolveEpicAdoptionId(values);

  const provider = createProvider(config);
  const paths = resolveInputPaths(values);
  const artifacts = await loadArtifacts(paths);

  const useChain = shouldChainPersist(values);

  let result;
  try {
    result = useChain
      ? await runPersistChain({
          values,
          config,
          provider,
          artifacts,
          metricsSince,
        })
      : await runPersistInvocation({
          values,
          config,
          provider,
          artifacts,
          metricsSince,
        });
  } catch (err) {
    if (err?.code === 'PLAN_REACHABILITY_ORPHANS') {
      process.stdout.write(`${err.message}\n`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }

  await attachPlanMetrics(result, config, metricsSince);

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

runAsCli(import.meta.url, main, {
  source: 'plan-persist',
  usage: {
    invocation:
      'node .agents/scripts/plan-persist.js --stories <file> [--tech-spec <file>] [--dry-run] [options]',
    summary:
      'Validate an authored plan and persist it as GitHub Stories in one invocation (pass --dry-run to validate only). Prints the result envelope as JSON on stdout.',
    flags: [
      ['--stories <file>', 'Authored stories.json (required).'],
      ['--tech-spec <file>', 'Optional companion techspec.md.'],
      ['--plan-dir <dir>', 'Directory holding the plan artifacts.'],
      [
        '--plan-context <file>',
        'The plan-context envelope this draft was authored against.',
      ],
      ['--source-tickets <ids>', 'Ticket ids this plan supersedes.'],
      ['--dry-run', 'Validate and report; create nothing.'],
      ['--no-close-superseded', 'Leave superseded source tickets open.'],
      [
        '--force-review',
        'Require the review gate even when it would be skipped.',
      ],
      [
        '--epic-title <text>',
        'Group the persisted Stories under a container Epic with this title (needs --epic-goal).',
      ],
      [
        '--epic-goal <text>',
        'The container Epic’s one-paragraph goal (needs --epic-title).',
      ],
      [
        '--epic <id>',
        'Join an existing open container Epic instead of creating one (excludes --epic-title/--epic-goal).',
      ],
    ],
  },
});
