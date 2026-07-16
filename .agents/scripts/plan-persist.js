#!/usr/bin/env node

/**
 * plan-persist.js — flat Story GitHub-write surface for v2 `/plan`
 * (Stage 3 — `docs/roadmap.md`).
 *
 * Given the author-written planning artifacts (`stories.json` +
 * `risk-verdict.json`, optional shared Tech Spec), this CLI validates and
 * creates Story issue(s) directly:
 *
 *   risk-verdict → ticket validator / DAG / capacity → reachability →
 *   split-policy partition → fold/spill Spec into each Story body →
 *   createIssue(s) with type::story + agent::ready → risk-verdict +
 *   story-plan-state on every Story; plan-summary on the primary →
 *   comment + close superseded source tickets → temp cleanup.
 *
 * CLI:
 *   --stories <file>          Required Story ticket array (default length 1)
 *   --risk-verdict <file>     Required risk verdict (no deliveryShape)
 *   --tech-spec <file>        Optional shared Tech Spec folded into each Story
 *   --plan-dir <dir>          Optional temp dir deleted at terminal success
 *   --plan-acceptance <file>  Optional JSON string[] for partition coverage
 *   --plan-run-id <id>        Optional plan-run token when N>1
 *   --source-tickets <ids>    Ids passed to `/plan --tickets` — each must be
 *                             claimed by exactly one Story's `supersedes[]`;
 *                             they are commented on and closed as superseded
 *   --no-close-superseded     Keep the source tickets open (no comment, no
 *                             close) — for a genuinely partial supersede
 *   --dry-run                 Assemble + validate without GitHub writes
 *   --force-review            Record operator-forced review routing
 *   --allow-over-budget / --allow-large-fan-out
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
import { Logger } from './lib/Logger.js';
import {
  readPlanMetrics,
  recordPlanInvocation,
  renderPlanMetricsSummaryLine,
  summarizePlanMetrics,
} from './lib/orchestration/plan-metrics.js';
import {
  runPlanPersist,
  writeCheckpointV2,
} from './lib/orchestration/plan-persist/run-plan-persist.js';
import {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
} from './lib/orchestration/plan-persist/summary.js';
import { normalizeSourceTicketIds } from './lib/orchestration/plan-persist/supersede-ops.js';
import { loadRiskVerdict } from './lib/orchestration/planning/risk-verdict.js';
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
  'risk-verdict': { type: 'string' },
  'tech-spec': { type: 'string' },
  'plan-dir': { type: 'string' },
  'plan-acceptance': { type: 'string' },
  'plan-run-id': { type: 'string' },
  'source-tickets': { type: 'string' },
  'close-superseded': { type: 'boolean', default: true },
  'no-close-superseded': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'force-review': { type: 'boolean', default: false },
  'allow-over-budget': { type: 'boolean', default: false },
  'allow-large-fan-out': { type: 'boolean', default: false },
};

const USAGE =
  'Usage: plan-persist.js --stories <file> --risk-verdict <file> ' +
  '[--tech-spec <file>] [--plan-dir <dir>] [--plan-acceptance <file>] ' +
  '[--plan-run-id <id>] [--source-tickets <ids>] [--no-close-superseded] ' +
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

function resolveInputPaths(values) {
  return {
    storiesPath: path.resolve(values.stories),
    riskVerdictPath: path.resolve(values['risk-verdict']),
    techSpecPath: values['tech-spec']
      ? path.resolve(values['tech-spec'])
      : null,
    planAcceptancePath: values['plan-acceptance']
      ? path.resolve(values['plan-acceptance'])
      : null,
    planDir: values['plan-dir'] ? path.resolve(values['plan-dir']) : null,
  };
}

async function loadArtifacts(paths) {
  const riskVerdict = loadRiskVerdict(paths.riskVerdictPath);
  const stories = await readJsonFile(paths.storiesPath, 'stories');
  const techSpecContent = paths.techSpecPath
    ? await readOptional(paths.techSpecPath, { required: true })
    : null;
  const planAcceptance = paths.planAcceptancePath
    ? await readJsonFile(paths.planAcceptancePath, 'plan-acceptance')
    : null;

  return { stories, riskVerdict, techSpecContent, planAcceptance };
}

function buildPersistOptions(values, paths) {
  return {
    forceReview: values['force-review'],
    allowOverBudget: values['allow-over-budget'],
    allowLargeFanOut: values['allow-large-fan-out'],
    dryRun: values['dry-run'],
    planRunId: values['plan-run-id'],
    planDir: paths.planDir,
    skipCleanup: values['dry-run'],
    sourceTicketIds: normalizeSourceTicketIds(values['source-tickets']),
    // Default-on: `--no-close-superseded` is the explicit escape and always
    // wins over the (default `true`) `--close-superseded`.
    closeSuperseded:
      values['no-close-superseded'] === true
        ? false
        : values['close-superseded'] !== false,
  };
}

async function runPersistInvocation({ values, config, provider, artifacts }) {
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
        opts: buildPersistOptions(values, paths),
      }),
  );
}

async function attachPlanMetrics(result, config) {
  try {
    const summary = summarizePlanMetrics(await readPlanMetrics(config));
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

  if (!values.stories || !values['risk-verdict']) {
    throw new Error(USAGE);
  }

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
    });
  } catch (err) {
    if (err?.code === 'PLAN_REACHABILITY_ORPHANS') {
      process.stdout.write(`${err.message}\n`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }

  await attachPlanMetrics(result, config);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'plan-persist' });
