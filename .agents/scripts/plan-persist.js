#!/usr/bin/env node

/**
 * plan-persist.js — flat Story GitHub-write surface for v2 `/plan`
 * (Stage 3 — `docs/roadmap.md`).
 *
 * Given the author-written planning artifacts (`stories.json`, optional shared
 * Tech Spec), this CLI validates and creates Story issue(s) directly:
 *
 *   ticket validator / DAG / capacity → reachability →
 *   split-policy partition → fold/spill Spec into each Story body →
 *   createIssue(s) with type::story, resumably by plan fingerprint (NOT
 *   agent::ready) → story-plan-state on every Story;
 *   plan-summary on the primary → flip every Story to agent::ready →
 *   comment + close superseded source tickets → temp cleanup + stale reap.
 *
 * Story #4542 retired the authored risk verdict: persist neither requires nor
 * accepts one, and no plan-time step produces one. Review depth and the
 * acceptance-critic mode are derived from the diff at close time
 * (`review-depth.js#deriveChangeLevel`). `--force-review` is the only review
 * gate the planner still carries, and it is an explicit operator flag.
 *
 * CLI:
 *   --stories <file>          Required Story ticket array (default length 1)
 *   --tech-spec <file>        Optional shared Tech Spec folded into each Story
 *   --plan-dir <dir>          Optional temp dir deleted at terminal success.
 *                             Also where the `plan-context.json` envelope is
 *                             auto-discovered from (see --plan-context)
 *   --plan-context <file>     Optional explicit path to the `plan-context.js`
 *                             envelope. Its `sourceTickets[]` is what makes
 *                             `--tickets` superseding work without a flag
 *   --plan-acceptance <file>  Optional JSON string[] for partition coverage
 *   --source-tickets <ids>    Explicit OVERRIDE of the envelope-derived source
 *                             ids, for hand-driven runs. Each id must be
 *                             claimed by exactly one Story's `supersedes[]`;
 *                             they are commented on and closed as superseded
 *   --no-close-superseded     Keep the source tickets open (no comment, no
 *                             close) — for a genuinely partial supersede
 *   --dry-run                 Assemble + validate without GitHub writes
 *   --force-review            Operator-forced review stop before persist lands
 *   --allow-over-budget / --allow-large-fan-out
 *
 * Run `--dry-run` first. It exercises every gate — validator, DAG, capacity,
 * budget, reachability, split/supersede partition, Spec fold — write-free, so
 * an authoring mistake surfaces before a single issue exists.
 *
 * stdout is reserved for the JSON result (Story #2278 discipline, extended to
 * this CLI by Story #4541): `routeAllOutputToStderr()` runs before any
 * pipeline code so a headless driver can `JSON.parse` stdout unconditionally.
 * Human-readable log lines go to stderr, matching the sibling `plan-context`.
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
  writeCheckpointV2,
} from './lib/orchestration/plan-persist/run-plan-persist.js';
import {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
} from './lib/orchestration/plan-persist/summary.js';
import { resolveSourceTicketIds } from './lib/orchestration/plan-persist/supersede-ops.js';
import { createProvider } from './lib/provider-factory.js';

export {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
  runPlanPersist,
  writeCheckpointV2,
};

const CLI_OPTIONS = {
  stories: { type: 'string' },
  'tech-spec': { type: 'string' },
  'plan-dir': { type: 'string' },
  'plan-context': { type: 'string' },
  'plan-acceptance': { type: 'string' },
  'source-tickets': { type: 'string' },
  'close-superseded': { type: 'boolean', default: true },
  'no-close-superseded': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'force-review': { type: 'boolean', default: false },
  'allow-over-budget': { type: 'boolean', default: false },
  'allow-large-fan-out': { type: 'boolean', default: false },
};

const USAGE =
  'Usage: plan-persist.js --stories <file> ' +
  '[--tech-spec <file>] [--plan-dir <dir>] [--plan-context <file>] ' +
  '[--plan-acceptance <file>] ' +
  '[--source-tickets <ids>] [--no-close-superseded] ' +
  '[--dry-run] [--force-review] ' +
  '[--allow-over-budget] [--allow-large-fan-out]';

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
 * Resolve every input path the CLI accepts, including where the
 * `plan-context.js` envelope is discovered from. Exported for tests.
 *
 * @param {object} values Parsed `parseArgs` values.
 */
export function resolveInputPaths(values) {
  const planDir = values['plan-dir'] ? path.resolve(values['plan-dir']) : null;
  return {
    storiesPath: path.resolve(values.stories),
    techSpecPath: values['tech-spec']
      ? path.resolve(values['tech-spec'])
      : null,
    planAcceptancePath: values['plan-acceptance']
      ? path.resolve(values['plan-acceptance'])
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
  const planAcceptance = paths.planAcceptancePath
    ? await readJsonFile(paths.planAcceptancePath, 'plan-acceptance')
    : null;
  const planContextEnvelope = await loadPlanContextEnvelope(
    paths.planContextPath,
  );

  return {
    stories,
    techSpecContent,
    planAcceptance,
    planContextEnvelope,
  };
}

/**
 * Assemble the `runPlanPersist` opts bag from parsed CLI values.
 *
 * Exported for tests: this is the join where the envelope-derived source ids
 * meet the persist engine, so a regression here silently un-wires
 * `/plan --tickets` superseding (Story #4554).
 *
 * @param {object} values Parsed `parseArgs` values.
 * @param {ReturnType<typeof resolveInputPaths>} paths
 * @param {object|null} planContextEnvelope
 * @returns {object} opts for `runPlanPersist`.
 */
export function buildPersistOptions(values, paths, planContextEnvelope) {
  const source = resolveSourceTicketIds({
    explicitIds: values['source-tickets'],
    envelope: planContextEnvelope,
  });

  return {
    forceReview: values['force-review'],
    allowOverBudget: values['allow-over-budget'],
    allowLargeFanOut: values['allow-large-fan-out'],
    dryRun: values['dry-run'],
    planDir: paths.planDir,
    skipCleanup: values['dry-run'],
    sourceTicketIds: source.ids,
    sourceTicketOrigin: source.origin,
    // Default-on: `--no-close-superseded` is the explicit escape and always
    // wins over the (default `true`) `--close-superseded`.
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
}) {
  const paths = resolveInputPaths(values);
  const settings = {
    baseBranch: config.project?.baseBranch,
    paths: config.project?.paths,
    planning: config.planning,
    docsContextFiles: config.project?.docsContextFiles,
  };

  return recordPlanInvocation(
    {
      cli: 'plan-persist',
      mode: values['dry-run'] ? 'dry-run' : 'persist',
      config,
    },
    () =>
      runPlanPersist({
        provider,
        artifacts,
        config,
        settings,
        opts: {
          ...buildPersistOptions(values, paths, artifacts.planContextEnvelope),
          metricsSince,
        },
      }),
  );
}

/**
 * Attach the plan-metrics roll-up for **this** invocation.
 *
 * Two Story #4541 fixes meet here. `readPlanMetrics` is declared
 * `(epicId, config)` but was called with `config` first, so it threw its
 * `epicId` guard on every run and the catch below turned that into a
 * silently missing summary — v2 persist is always Epic-less, hence the
 * explicit `null`. And the Epic-less ledger is shared across every plan the
 * repo has ever run, so `since` scopes the counts to the current invocation
 * instead of reporting lifetime totals under an invocation-shaped line.
 *
 * This runs *after* `recordPlanInvocation` has appended this run's own
 * record, so the summary always has at least that one entry to report.
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

  // stdout is reserved for the JSON result: flip every Logger sink that could
  // land on stdout to stderr BEFORE any pipeline code runs (Story #2278
  // discipline, extended here by Story #4541 — this CLI interleaved Logger
  // lines with its own JSON, so a headless driver could not parse stdout).
  routeAllOutputToStderr();

  // Boundary for this invocation's plan-metrics roll-up — stamped before any
  // ledger-writing work so every record this run appends falls inside it.
  const metricsSince = new Date().toISOString();

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }
  const provider = createProvider(config);
  const paths = resolveInputPaths(values);
  const artifacts = await loadArtifacts(paths);

  let result;
  try {
    result = await runPersistInvocation({
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

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'plan-persist' });
