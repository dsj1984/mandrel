#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-automerge.js — Phase 7.5 of `/epic-deliver`.
 *
 * After `gh pr checks --watch` returns 0, this CLI evaluates the auto-merge
 * predicate (`lib/orchestration/automerge-predicate.js`). When every signal
 * is clean — no manual interventions recorded, every wave complete with no
 * story blockers, code-review has zero 🔴/🟠 findings, retro picked the
 * compact path — it fires `gh pr merge --squash --delete-branch`. Otherwise
 * it relays the disqualifying reasons and exits with the operator-merges-
 * button outcome.
 *
 * Always emits a JSON envelope on stdout so the host LLM can branch on the
 * verdict.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-automerge.js --epic <id> --pr <prNumber> \
 *     [--dry-run] [--strategy squash|merge|rebase]
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { evaluateAutoMergePredicate } from './lib/orchestration/automerge-predicate.js';
import { Checkpointer } from './lib/orchestration/epic-runner/checkpointer.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-automerge.js \\
  --epic <id> --pr <prNumber> [--dry-run] [--strategy squash|merge|rebase]

Evaluates the auto-merge predicate against Epic #<id>'s structured comments
and run-state checkpoint. If clean, fires \`gh pr merge --squash
--delete-branch\` (or the operator-supplied strategy). Otherwise relays the
disqualifying reasons.
`;

const VALID_STRATEGIES = Object.freeze(['squash', 'merge', 'rebase']);

/**
 * Pure: parse argv. Exported for tests.
 */
export function parseAutomergeArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      pr: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      strategy: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  const prNumber = Number.parseInt(values.pr ?? '', 10);
  const strategy =
    typeof values.strategy === 'string' &&
    VALID_STRATEGIES.includes(values.strategy)
      ? values.strategy
      : 'squash';
  return {
    epicId: Number.isNaN(epicId) || epicId <= 0 ? null : epicId,
    prNumber: Number.isNaN(prNumber) || prNumber <= 0 ? null : prNumber,
    dryRun: values['dry-run'] === true,
    strategy,
    help: values.help === true,
  };
}

/**
 * Build the `gh pr merge` argv. Pure. Exported for tests so we can assert
 * the `--delete-branch` + strategy flag combination doesn't drift.
 */
export function buildGhMergeArgs({ prNumber, strategy = 'squash' }) {
  return ['pr', 'merge', String(prNumber), `--${strategy}`, '--delete-branch'];
}

function defaultGhSpawn(args, cwd) {
  const result = spawnSync('gh', args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Runner-shaped entry. DI-friendly.
 *
 * @param {{
 *   epicId: number,
 *   prNumber: number,
 *   strategy?: 'squash'|'merge'|'rebase',
 *   dryRun?: boolean,
 *   cwd?: string,
 *   injectedConfig?: object,
 *   injectedProvider?: object,
 *   checkpointerFactory?: Function,
 *   evaluatePredicateFn?: typeof evaluateAutoMergePredicate,
 *   ghSpawnFn?: (args: string[], cwd: string) => { status: number, stdout: string, stderr: string },
 *   loggerImpl?: { info?: Function, warn?: Function, error?: Function },
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   prNumber: number,
 *   strategy: string,
 *   merged: boolean,
 *   verdict: { clean: boolean, reasons: string[], signals: object },
 *   dryRun: boolean,
 *   ghStderr?: string,
 * }>}
 */
export async function runEpicDeliverAutomerge({
  epicId,
  prNumber,
  strategy = 'squash',
  dryRun = false,
  cwd,
  injectedConfig,
  injectedProvider,
  checkpointerFactory,
  evaluatePredicateFn = evaluateAutoMergePredicate,
  ghSpawnFn = defaultGhSpawn,
  loggerImpl,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverAutomerge: epicId must be a positive integer',
    );
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new TypeError(
      'runEpicDeliverAutomerge: prNumber must be a positive integer',
    );
  }
  if (!VALID_STRATEGIES.includes(strategy)) {
    throw new TypeError(
      `runEpicDeliverAutomerge: strategy must be one of ${VALID_STRATEGIES.join(', ')}`,
    );
  }
  const logger = loggerImpl ?? Logger;
  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config.orchestration);
  const factory = checkpointerFactory ?? ((deps) => new Checkpointer(deps));

  logger.info?.(
    `[epic-deliver-automerge] Evaluating predicate for Epic #${epicId} (PR #${prNumber})...`,
  );
  const verdict = await evaluatePredicateFn({
    provider,
    epicId,
    checkpointerFactory: factory,
  });

  if (!verdict.clean) {
    logger.info?.(
      `[epic-deliver-automerge] Predicate DIRTY — operator-merges-button path. Reasons: ${verdict.reasons.join('; ')}`,
    );
    return { epicId, prNumber, strategy, merged: false, verdict, dryRun };
  }

  logger.info?.(
    `[epic-deliver-automerge] Predicate CLEAN — auto-merging via gh pr merge --${strategy} --delete-branch...`,
  );

  if (dryRun) {
    return { epicId, prNumber, strategy, merged: false, verdict, dryRun: true };
  }

  const ghArgs = buildGhMergeArgs({ prNumber, strategy });
  const ghResult = ghSpawnFn(ghArgs, cwd ?? PROJECT_ROOT);
  if (ghResult.status !== 0) {
    logger.error?.(
      `[epic-deliver-automerge] gh pr merge exit ${ghResult.status}: ${ghResult.stderr}`,
    );
    return {
      epicId,
      prNumber,
      strategy,
      merged: false,
      verdict,
      dryRun: false,
      ghStderr: ghResult.stderr,
    };
  }

  logger.info?.(
    `[epic-deliver-automerge] PR #${prNumber} merged via --${strategy}.`,
  );
  return { epicId, prNumber, strategy, merged: true, verdict, dryRun: false };
}

/**
 * Pure: classify parsed CLI args into a runnable intent. Extracting this
 * decision out of `main` keeps the side-effecting wrapper at CC ≤ 2 and
 * lets unit tests cover every branch directly.
 *
 * Shapes:
 *   - { kind: 'help' }
 *   - { kind: 'usage-error', messages: string[] }
 *   - { kind: 'run', epicId, prNumber, strategy, dryRun }
 */
export function classifyAutomergeInvocation(args) {
  if (args?.help) return { kind: 'help' };
  if (args?.epicId === null || args?.prNumber === null) {
    return {
      kind: 'usage-error',
      messages: [
        '[epic-deliver-automerge] ERROR: --epic <id> and --pr <prNumber> are required.',
        HELP,
      ],
    };
  }
  return {
    kind: 'run',
    epicId: args.epicId,
    prNumber: args.prNumber,
    strategy: args.strategy,
    dryRun: args.dryRun,
  };
}

async function main() {
  const intent = classifyAutomergeInvocation(
    parseAutomergeArgs(process.argv.slice(2)),
  );
  if (intent.kind === 'help') {
    Logger.info(HELP);
    return;
  }
  if (intent.kind === 'usage-error') {
    for (const m of intent.messages) Logger.error(m);
    process.exit(2);
  }
  const out = await runEpicDeliverAutomerge({
    epicId: intent.epicId,
    prNumber: intent.prNumber,
    strategy: intent.strategy,
    dryRun: intent.dryRun,
  });
  Logger.info(JSON.stringify(out, null, 2));
  if (out.ghStderr) process.exit(1);
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-automerge' });
