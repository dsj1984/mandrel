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
 *   --plan-dir <dir>          Optional temp dir deleted at terminal success.
 *                             Also where the `plan-context.json` envelope is
 *                             auto-discovered from (see --plan-context)
 *   --plan-context <file>     Optional explicit path to the `plan-context.js`
 *                             envelope. Its `sourceTickets[]` is what makes
 *                             `--tickets` superseding work without a flag
 *   --plan-acceptance <file>  Optional JSON string[] for partition coverage
 *   --plan-run-id <id>        Optional plan-run token when N>1
 *   --source-tickets <ids>    Explicit OVERRIDE of the envelope-derived source
 *                             ids, for hand-driven runs. Each id must be
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
import { resolveSourceTicketIds } from './lib/orchestration/plan-persist/supersede-ops.js';
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
  'plan-context': { type: 'string' },
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
  '[--tech-spec <file>] [--plan-dir <dir>] [--plan-context <file>] ' +
  '[--plan-acceptance <file>] ' +
  '[--plan-run-id <id>] [--source-tickets <ids>] [--no-close-superseded] ' +
  '[--dry-run] [--force-review] ' +
  '[--allow-over-budget] [--allow-large-fan-out]';

/**
 * Filename `plan-context.js`'s envelope is captured to inside `--plan-dir`.
 * `/plan` step 1 redirects stdout here, which is what lets persist derive the
 * `--tickets` source ids with no flag (Story #4554).
 */
const PLAN_CONTEXT_FILENAME = 'plan-context.json';

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
  const planDir = values['plan-dir'] ? path.resolve(values['plan-dir']) : null;
  return {
    storiesPath: path.resolve(values.stories),
    riskVerdictPath: path.resolve(values['risk-verdict']),
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

/**
 * Where to look for the `plan-context.js` envelope: an explicit
 * `--plan-context` path wins; otherwise the conventional file inside
 * `--plan-dir`. Neither given → nothing to read.
 *
 * @param {string|undefined} explicitPath
 * @param {string|null} planDir
 * @returns {{ path: string, explicit: boolean }|null}
 */
function resolvePlanContextPath(explicitPath, planDir) {
  if (explicitPath) {
    return { path: path.resolve(explicitPath), explicit: true };
  }
  if (planDir) {
    return { path: path.join(planDir, PLAN_CONTEXT_FILENAME), explicit: false };
  }
  return null;
}

/**
 * Read the `plan-context.js` envelope so persist can derive the `--tickets`
 * source ids from the run that actually fetched them (Story #4554).
 *
 * Failure policy — the point is that a `--tickets` run can never *quietly*
 * lose its source set:
 *
 * - An **explicit** `--plan-context` that is missing or unparseable throws:
 *   the operator named a file and meant it.
 * - An auto-discovered `<plan-dir>/plan-context.json` that is simply absent
 *   warns and degrades to `--source-tickets` — a seed-mode run legitimately
 *   has no source tickets, so absence alone is not an error.
 * - A **present but unparseable** envelope throws either way: a corrupt
 *   envelope is not the same as no envelope, and silently treating it as
 *   "no source tickets" is exactly the vacuous pass this Story closes.
 *
 * @param {{ path: string, explicit: boolean }|null} planContext
 * @returns {Promise<object|null>}
 */
async function loadPlanContextEnvelope(planContext) {
  if (!planContext) return null;

  let raw;
  try {
    raw = await readFile(planContext.path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' && !planContext.explicit) {
      Logger.warn(
        `[plan-persist] no plan-context envelope at ${planContext.path} — ` +
          'source tickets can only come from --source-tickets. Capture ' +
          "step 1's stdout there so `/plan --tickets` supersedes without a flag.",
      );
      return null;
    }
    throw new Error(
      `Cannot read plan-context envelope ${planContext.path}: ${err.message}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse plan-context envelope "${planContext.path}" as JSON: ` +
        `${err.message}. Re-capture it with ` +
        `\`node .agents/scripts/plan-context.js … > ${planContext.path}\`.`,
    );
  }
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
  const planContextEnvelope = await loadPlanContextEnvelope(
    paths.planContextPath,
  );

  return {
    stories,
    riskVerdict,
    techSpecContent,
    planAcceptance,
    planContextEnvelope,
  };
}

function buildPersistOptions(values, paths, planContextEnvelope) {
  const source = resolveSourceTicketIds({
    explicitIds: values['source-tickets'],
    envelope: planContextEnvelope,
  });

  return {
    forceReview: values['force-review'],
    allowOverBudget: values['allow-over-budget'],
    allowLargeFanOut: values['allow-large-fan-out'],
    dryRun: values['dry-run'],
    planRunId: values['plan-run-id'],
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
        opts: buildPersistOptions(values, paths, artifacts.planContextEnvelope),
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
