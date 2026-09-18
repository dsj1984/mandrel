#!/usr/bin/env node

/**
 * plan-persist.js — flat Story GitHub-write surface for v2 `/mandrel-plan`
 * (Stage 3 — `docs/roadmap.md`).
 *
 * Given the author-written planning artifacts (`stories.json`, optional shared
 * Tech Spec), this CLI validates and creates Story issue(s) directly:
 *
 *   changes[] repair → ticket validator / DAG → reachability →
 *   split-policy partition → fold Spec into each Story body →
 *   createIssue(s) with type::story, resumably by plan fingerprint (NOT
 *   agent::ready) → one `story-plan-state` comment (the plan summary) on
 *   every Story → flip every Story to agent::ready →
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
 *   --source-tickets <ids>    Explicit OVERRIDE of the envelope-derived source
 *                             ids, for hand-driven runs. Each id must be
 *                             claimed by exactly one Story's `supersedes[]`;
 *                             they are commented on and closed as superseded
 *   --no-close-superseded     Keep the source tickets open (no comment, no
 *                             close) — for a genuinely partial supersede
 *   --dry-run                 Assemble + validate without GitHub writes
 *   --force-review            Operator-forced review stop before persist lands
 *
 * **Persist is one command (Story #5342).** Without `--dry-run` the CLI runs
 * the write-free dry-run first — the
 * changes[] repair, the validator, DAG, reachability, split/supersede
 * partition, Spec fold — and, when the gate list comes back clean, chains
 * straight into the real persist in the SAME invocation. A dry-run failure
 * stops before any `createIssue`, and the run lists every warning (a
 * footprint probe that disagrees with the base branch, an empty `verify[]`,
 * an open question in a body) either way. `--dry-run` still creates nothing.
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
 * Resolve the optional container-Epic request from the CLI flags.
 *
 * Both halves are required together: an Epic with a title and no goal is a
 * container with nothing explaining the grouping, and a goal with no title
 * cannot be opened at all. Supplying exactly one is a **usage error**, not a
 * silent no-Epic run — the operator asked for a container and would otherwise
 * never learn they did not get one.
 *
 * @param {object} values Parsed `parseArgs` values.
 * @returns {{ title: string, goal: string }|null} `null` when no Epic was requested.
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
 * Refuse `--epic` alongside `--epic-title`/`--epic-goal`.
 *
 * A run either joins a container or opens one; asking for both names no
 * coherent outcome, so it is a usage error rather than a silent precedence
 * rule the operator would have to know.
 *
 * @param {object} values Parsed `parseArgs` values.
 * @returns {void}
 * @throws {Error} When both forms were supplied.
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
 * Resolve `--epic <id>`: the existing open container this run joins.
 *
 * Story #5155. Parsed here rather than deep in the engine so a typo costs a
 * usage error before any provider call — the id itself is verified against
 * live state later, before the first create.
 *
 * @param {object} values Parsed `parseArgs` values.
 * @returns {number|null} `null` when no adoption was requested.
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
 * Assemble the `runPlanPersist` opts bag from parsed CLI values.
 *
 * Exported for tests: this is the join where the envelope-derived source ids
 * meet the persist engine, so a regression here silently un-wires
 * `/mandrel-plan --tickets` superseding (Story #4554).
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
    dryRun: values['dry-run'],
    planDir: paths.planDir,
    skipCleanup: values['dry-run'],
    sourceTicketIds: source.ids,
    sourceTicketOrigin: source.origin,
    epic: resolveEpicRequest(values),
    adoptEpicId: resolveEpicAdoptionId(values),
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
 * The default persist path (Story #4741 AC-1/AC-3; widened to any plan by
 * Story #5312; made the default by Story #5342): chain a clean dry-run into
 * the real persist in ONE operator invocation.
 *
 * Two passes over the **same** loaded artifacts:
 *
 *   1. A write-free dry-run. Every gate runs before any `createIssue` can
 *      happen, so a validation failure — which throws or returns reachability
 *      orphans — stops here, before a single issue exists (AC-3).
 *   2. The real write, run when the dry-run passed clean. Because it replays
 *      the identical artifacts, the persisted output is byte-identical to
 *      what the dry-run validated (AC-1). The lite-route condition that used
 *      to gate this step went with the plan-side lite claim: a clean dry-run
 *      is the review the chain exists to fold.
 *
 * The caller reads the **second** pass's envelope, so the first pass's
 * evidence has to be carried onto it (Story #5361). The repair pass mutates
 * the loaded tickets in place, which is what makes replaying the identical
 * artifacts possible at all — and it is also why pass 2 recomputes an empty
 * `repairs[]`: by then there is nothing left to repair. The evidence is
 * preserved rather than re-derived, because re-running the repair pass would
 * report repairs the persisting pass did not make.
 *
 * Exported for tests — this is where the round-trip collapse lives, so a
 * regression here silently re-opens the second operator round-trip (or
 * worse, persists a plan the dry-run never gated).
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
 * Union two evidence lists, dry-run first, dropping an entry the second pass
 * reported identically. Order is the operator's reading order; the dedupe is
 * by rendered content because a repair is a plain record and a warning is a
 * string, so two passes that noticed the same thing noticed it byte-for-byte.
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
 * Decide whether this invocation persists after its gates, or only validates.
 *
 * Story #5342: chaining is the default, not a flag. Every invocation that is
 * not an explicit `--dry-run` runs the gate list and then persists what it
 * passed, so the two operator round-trips collapse without anyone having to
 * remember an opt-in. Story #5361 removed the no-op alias Story #5342 had
 * kept for existing call-sites, rather than accepting and ignoring it: a flag
 * that cannot change an outcome is a shim, and `parseArgs` refuses an unknown
 * option, so passing it now fails loudly instead of reading as honoured.
 *
 * Exported for tests: this one predicate is what makes the CLI one command.
 *
 * @param {object} values Parsed `parseArgs` values.
 * @returns {boolean} `true` to run the gates and then persist.
 */
export function shouldChainPersist(values) {
  return values?.['dry-run'] !== true;
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
  // Argument-shape refusals fire before any I/O (Story #5155): a usage error
  // the operator can see without waiting on artifact reads or a provider.
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
