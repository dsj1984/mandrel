#!/usr/bin/env node

/**
 * One beat of a multi-Story `/mandrel-deliver` run: tick from live state with
 * the run ledger as the dispatched list, write a dispatch prompt per ready
 * Story, and render each hand-off's close command. Scheduling is entirely the
 * tick's, and so is the exit-code contract — the loop's stopping rules must
 * not get a second dialect.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildDispatchChecklist } from './lib/audit-suite/index.js';
import { runAsCli } from './lib/cli-utils.js';
import { getPaths, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { ensureDocsDigest } from './lib/orchestration/docs-digest.js';
import { parse as parseStoryBody } from './lib/story-body/story-body.js';
import { expandIdList } from './lib/util/parse-id-list.js';
import { runProbedStoriesWaveTick } from './stories-wave-tick.js';

const INPUT_ERROR_EXIT_CODE = 1;

const USAGE = {
  invocation:
    'node .agents/scripts/deliver-run.js --stories <ids> [--handoff <id>]... [--concurrency <n>] [--run-id <id>] [--cwd <path>]',
  summary:
    'Run one beat of a multi-Story delivery: tick from live state, write a dispatch prompt per ready Story, and render the close command for each hand-off. Prints one JSON envelope.',
  flags: [
    [
      '--stories <ids>',
      'Story ids in the run. Singles, commas and inclusive A-B ranges (5340,5342-5345).',
    ],
    [
      '--handoff <id>',
      'A Story whose worker has pushed its branch. Repeatable. Each one gets a close[] entry carrying the exact single-story-close.js command.',
    ],
    [
      '--concurrency <n>',
      'Per-beat concurrency override, forwarded to the tick. Omit it so delivery.deliverRunner.concurrencyCap (and any .agentrc.local.json override) wins.',
    ],
    [
      '--run-id <id>',
      'Pin the run directory under <tempRoot>. Default: a stable digest of the Story id set, so every beat of the same run finds the same ledger.',
    ],
    ['--cwd <path>', 'Main checkout. Default: the current directory.'],
  ],
  notes: [
    'The run ledger (<tempRoot>/run-<id>/ledger.json) records every id handed out\nas ready, so a repeat beat withholds it with no --dispatched bookkeeping from\nthe caller. It is additive: the tick still filters it against live state, so a\nledgered id that has since gone agent::done is dropped for you.',
    'A ledgered id that live state still reports as agent::ready is named in\nstalledDispatch[], with stalledDispatchReason carrying the recovery. It is a\nreport, never a release: a slow init and a dead spawn read alike here, so the\noperator edits the ledger and re-beats with --run-id.',
    '--merge-watch-mode async is added to every close command when the run holds\nmore than one Story, and omitted for a run of one. Close sees a single Story\nand cannot make that call for itself.',
    'Exit codes:\n  0  beat emitted\n  1  input error\n  2  dependency cycle (cycleError)\n  3  wedged\n  4  blocked — the HITL pause; stop the loop, do not poll',
  ],
};

/**
 * Stable across beats of one run, distinct across concurrent runs — only the
 * sorted id set satisfies both.
 * @param {number[]} ids
 * @returns {string}
 */
export function deriveRunId(ids) {
  const key = [...new Set(ids)].sort((a, b) => a - b).join(',');
  return createHash('sha1').update(key).digest('hex').slice(0, 8);
}

/**
 * An unreadable ledger is empty, not fatal: refusing the beat would strand a
 * live run on a bookkeeping artifact.
 * @param {string} ledgerPath
 * @param {{ readFileFn?: (p: string, enc: string) => string }} [deps]
 * @returns {number[]}
 */
export function readLedgerDispatched(
  ledgerPath,
  { readFileFn = fs.readFileSync } = {},
) {
  let raw;
  try {
    raw = readFileFn(ledgerPath, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.dispatched) ? parsed.dispatched : [];
    return ids.filter((id) => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

/**
 * Append-only: nothing removes an id, so none can be forgotten.
 * @param {object} args
 * @param {string} args.ledgerPath
 * @param {string} args.runId
 * @param {number[]} args.stories
 * @param {number[]} args.dispatched
 * @param {number[]} args.ready
 * @param {{ writeFileFn?: (p: string, c: string, enc: string) => void }} [deps]
 * @returns {number[]}
 */
function writeLedger(
  { ledgerPath, runId, stories, dispatched, ready },
  { writeFileFn = fs.writeFileSync } = {},
) {
  const merged = [...new Set([...dispatched, ...ready])].sort((a, b) => a - b);
  const payload = {
    kind: 'deliver-run-ledger',
    runId,
    stories,
    dispatched: merged,
    updatedAt: new Date().toISOString(),
  };
  writeFileFn(ledgerPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return merged;
}

/**
 * `--merge-watch-mode async` is a run-topology call close cannot make: with
 * siblings, sync closes serialize every merge wait; alone, sync lands fastest.
 * @param {{ storyId: number, mainRepo: string, storyCount: number }} args
 * @returns {string}
 */
export function renderCloseCommand({ storyId, mainRepo, storyCount }) {
  const parts = [
    'node',
    path.join(mainRepo, '.agents', 'scripts', 'single-story-close.js'),
    `--story ${storyId}`,
    `--cwd ${mainRepo}`,
  ];
  if (storyCount > 1) parts.push('--merge-watch-mode async');
  return parts.join(' ');
}

/**
 * The whole spawn payload for one ready Story.
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.mainRepo
 * @param {string|null} args.docsDigestPath
 * @param {string|null} args.checklistPath
 * @returns {string}
 */
export function renderDispatchPrompt({
  storyId,
  mainRepo,
  docsDigestPath,
  checklistPath,
}) {
  const lines = [
    `# Deliver Story #${storyId}`,
    '',
    `Main checkout: \`${mainRepo}\`.`,
    '',
    `You own Steps 0 through 2.5 of \`.agents/workflows/helpers/deliver-story.md\`.`,
    'The orchestrator owns Step 3 (close): do not open a PR, do not run',
    '`single-story-close.js`, and do not compose a terminal envelope.',
    '',
    '## Reads',
    '',
    '1. `.agents/workflows/helpers/deliver-digest.md` — once, first.',
    '2. `.agents/workflows/helpers/deliver-story.md` — the steps.',
    `3. The Story body (\`gh issue view ${storyId}\`) — its \`## Spec\`,`,
    '   `acceptance[]` and `verify[]` are the contract.',
    '',
    `- Docs digest: ${docsDigestPath ? `\`${docsDigestPath}\`` : 'none (project.docsContextFiles is unset) — no mandatory docs read'}`,
    `- Write-time checklist: ${checklistPath ? `\`${checklistPath}\`` : 'none matched this footprint — the maker-blind close-scope pass still covers it'}`,
    '',
    '## Worktree',
    '',
    'Initialize from the main checkout, synchronously, at the maximum Bash',
    'timeout — never in the background:',
    '',
    '```bash',
    `node ${path.join(mainRepo, '.agents', 'scripts', 'single-story-init.js')} --story ${storyId}`,
    '```',
    '',
    'Capture `workCwd` from its envelope and prefix **every** path-based',
    'Read/Edit/Write with that absolute worktree root — `cd` alone does not',
    'scope those tools. `remoteVerified: false` → flip `agent::blocked` quoting',
    '`remoteProbe.detail` and stop.',
    '',
    '## Change-set discipline',
    '',
    'Derive the change set, the level and the ceremony with **one** call, and',
    'hand that one list to the verdict owner — never let a critic re-run its',
    'own `git diff`:',
    '',
    '```bash',
    `node ${path.join(mainRepo, '.agents', 'scripts', 'ceremony-derive.js')} --story ${storyId} --cwd <workCwd>`,
    '```',
    '',
    '## Hand-off',
    '',
    'Run the bounded acceptance self-eval (digest § 4), the one credited suite',
    'run (digest § 5), then push `story-' + storyId + '` to `origin` and',
    'confirm the remote ref moved. Return: Story id, `workCwd`, branch, pushed',
    'head SHA, the self-eval verdict, and the `verify[]` evidence. Say the',
    'branch is pushed and unclosed.',
    '',
  ];
  return lines.join('\n');
}

/**
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.body
 * @param {string} args.runTempDir
 * @param {string} args.mainRepo
 * @param {string|null} args.docsDigestPath
 * @param {object} [deps]
 * @returns {{ id: number, promptPath: string }}
 */
function buildDispatchEntry(
  { storyId, body, runTempDir, mainRepo, docsDigestPath },
  {
    buildChecklistFn = buildDispatchChecklist,
    writeFileFn = fs.writeFileSync,
  } = {},
) {
  let changes = [];
  let references = [];
  try {
    // Path entries live on `.body`, not at the top level of the parse result.
    const { body: parsed } = parseStoryBody(body ?? '');
    changes = parsed?.changes ?? [];
    references = parsed?.references ?? [];
  } catch {
    // Costs the checklist, never the dispatch: the worker reads the body itself.
    changes = [];
    references = [];
  }
  const { checklistPath } = buildChecklistFn({
    storyId,
    changes,
    references,
    runTempDir,
  });
  const promptPath = path.join(runTempDir, `dispatch-${storyId}.md`);
  writeFileFn(
    promptPath,
    renderDispatchPrompt({
      storyId,
      mainRepo,
      docsDigestPath,
      checklistPath,
    }),
    'utf8',
  );
  return { id: storyId, promptPath };
}

/**
 * @param {object} envelope
 * @returns {Array<{id: number, blockedBy: number, reason: string, paths: string[]}>}
 */
function collectWithheld(envelope) {
  const reservation = envelope?.inFlightReservation?.withheld ?? [];
  const guard = envelope?.footprintGuard?.withheld ?? [];
  return [
    ...reservation.map((w) => ({
      id: w.id,
      blockedBy: w.blockedBy,
      reason: w.reason ?? 'in-flight-earlier-beat',
      paths: w.paths ?? [],
    })),
    ...guard.map((w) => ({
      id: w.id,
      blockedBy: w.blockedBy,
      reason: 'beat-peer',
      paths: w.paths ?? [],
    })),
  ];
}

/**
 * Report, never release: a slow init and a dead spawn look identical here,
 * and releasing the first re-dispatches a live Story onto its own branch.
 * @param {number[]} ids
 * @param {{ ledgerPath: string, runId: string }} run
 * @returns {string|null}
 */
export function renderStalledDispatchReason(ids, { ledgerPath, runId }) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const list = ids.map((id) => `#${id}`).join(', ');
  const subject = ids.length === 1 ? 'it' : 'they';
  return (
    `${list}: handed out as ready on an earlier beat, but live state still ` +
    `reports ${subject} as agent::ready. Either single-story-init.js is still ` +
    'running, or the spawn never reached it and the id is pinned in flight ' +
    'for every later beat. This beat does not release it — re-dispatching a ' +
    'live Story onto its own branch is the failure the ledger prevents. ' +
    'Confirm no worker is running, then remove the id from "dispatched" in ' +
    `${ledgerPath} and beat again with --run-id ${runId} so the same run ` +
    'directory is reused.'
  );
}

/**
 * Shaped like a beat envelope so callers branching on `kind` need no special case.
 * @param {string} message
 * @returns {{ envelope: object, exitCode: 1 }}
 */
function inputError(message) {
  return {
    envelope: { kind: 'deliver-run-beat', inputError: message },
    exitCode: INPUT_ERROR_EXIT_CODE,
  };
}

/**
 * @param {{ stories?: string, handoff?: string[] }} args
 * @returns {{ ids: number[]|null, handoffIds: number[], error: string|null }}
 */
export function resolveRunIds({ stories, handoff }) {
  const { ids, error } = expandIdList(stories, {
    flag: '--stories',
    prefix: '[deliver-run] ',
  });
  if (error) return { ids: null, handoffIds: [], error };
  if (ids.length === 0) {
    return {
      ids: null,
      handoffIds: [],
      error:
        '[deliver-run] --stories is required: node .agents/scripts/deliver-run.js --stories 5340,5341',
    };
  }
  const raw = (Array.isArray(handoff) ? handoff : [handoff]).filter(
    (v) => v != null && v !== '',
  );
  const handoffIds = [];
  for (const token of raw) {
    const expanded = expandIdList(String(token), {
      flag: '--handoff',
      prefix: '[deliver-run] ',
    });
    if (expanded.error)
      return { ids: null, handoffIds: [], error: expanded.error };
    handoffIds.push(...expanded.ids);
  }
  return { ids, handoffIds: [...new Set(handoffIds)], error: null };
}

/**
 * @param {object} args
 * @param {string} args.stories
 * @param {string[]} [args.handoff]
 * @param {string} [args.concurrency]
 * @param {string} [args.runId]
 * @param {string} [args.cwd]
 * @param {object} [args.config]
 * @param {Function} [args.probe]
 * @param {Function} [args.context]
 * @param {object} [deps]
 * @returns {Promise<{ envelope: object, exitCode: number }>}
 */
export async function runDeliverRunBeat(
  {
    stories,
    handoff = [],
    concurrency,
    runId: runIdOverride,
    cwd,
    config,
    probe,
    context,
  } = {},
  deps = {},
) {
  const {
    tickFn = runProbedStoriesWaveTick,
    resolveConfigFn = resolveConfig,
    ensureDocsDigestFn = ensureDocsDigest,
    mkdirFn = fs.mkdirSync,
    ...entryDeps
  } = deps;

  const { ids, handoffIds, error } = resolveRunIds({ stories, handoff });
  if (error) return inputError(error);

  const mainRepo = path.resolve(cwd ?? process.cwd());
  const resolved = config ?? resolveConfigFn({ cwd: mainRepo });
  const runId = runIdOverride ?? deriveRunId(ids);
  const runTempDir = path.resolve(
    mainRepo,
    getPaths(resolved).tempRoot,
    `run-${runId}`,
  );
  mkdirFn(runTempDir, { recursive: true });
  const ledgerPath = path.join(runTempDir, 'ledger.json');
  const ledgered = readLedgerDispatched(ledgerPath, entryDeps);

  const {
    envelope: tick,
    exitCode,
    records = [],
  } = await tickFn({
    stories,
    concurrency,
    // Additive, never authoritative: the probe filters it against live state.
    dispatched: ledgered.join(','),
    cwd: mainRepo,
    ...(config ? { config } : {}),
    ...(probe ? { probe } : {}),
    ...(context ? { context } : {}),
  });

  if (tick?.inputError) return inputError(tick.inputError);

  const stalledDispatch = Array.isArray(tick.stalledDispatch)
    ? tick.stalledDispatch
    : [];

  const readyIds = Array.isArray(tick.ready) ? tick.ready : [];
  const digest = await ensureDocsDigestFn({
    docsContextFiles: resolved?.project?.docsContextFiles,
    docsRoot: getPaths(resolved).docsRoot,
    outputPath: path.join(runTempDir, 'docs-digest.md'),
  });
  const docsDigestPath = digest?.outputPath ?? null;

  const bodyById = new Map(
    records.map((record) => [record.id, record.body ?? '']),
  );
  const ready = readyIds.map((storyId) =>
    buildDispatchEntry(
      {
        storyId,
        body: bodyById.get(storyId) ?? '',
        runTempDir,
        mainRepo,
        docsDigestPath,
      },
      entryDeps,
    ),
  );

  writeLedger(
    { ledgerPath, runId, stories: ids, dispatched: ledgered, ready: readyIds },
    entryDeps,
  );

  return {
    envelope: {
      kind: 'deliver-run-beat',
      runId,
      runTempDir,
      stories: ids,
      ready,
      close: handoffIds.map((storyId) => ({
        id: storyId,
        command: renderCloseCommand({
          storyId,
          mainRepo,
          storyCount: ids.length,
        }),
      })),
      done: tick.epilogueDue === true,
      doneStories: tick.done ?? [],
      inFlight: tick.inFlight ?? 0,
      concurrencyCap: tick.concurrencyCap ?? null,
      docsDigestPath,
      cycleError: tick.cycleError ?? null,
      wedged: tick.wedged ?? null,
      blocked: tick.blocked ?? [],
      blockedReason: tick.blockedReason ?? null,
      foreignHeld: tick.foreignHeld ?? [],
      // Not in `withheld[]`: it has no blocking peer, only an operator recovery.
      stalledDispatch,
      stalledDispatchReason: renderStalledDispatchReason(stalledDispatch, {
        ledgerPath,
        runId,
      }),
      withheld: collectWithheld(tick),
    },
    exitCode,
  };
}

/**
 * @param {string[]} argv
 * @returns {{ stories?: string, handoff: string[], concurrency?: string, runId?: string, cwd?: string }}
 */
function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      stories: { type: 'string' },
      handoff: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      'run-id': { type: 'string' },
      cwd: { type: 'string' },
    },
    strict: false,
    allowPositionals: false,
  });
  return {
    stories: values.stories,
    handoff: values.handoff ?? [],
    concurrency: values.concurrency,
    runId: values['run-id'],
    cwd: values.cwd,
  };
}

async function main(argv) {
  const { envelope, exitCode } = await runDeliverRunBeat(parseArgv(argv));
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  if (exitCode !== 0) {
    Logger.error(
      `deliver-run: ${
        envelope.inputError ??
        envelope.cycleError ??
        envelope.blockedReason ??
        envelope.wedged?.reason ??
        'error'
      }`,
    );
  }
  return exitCode;
}

runAsCli(import.meta.url, () => main(process.argv.slice(2)), {
  source: 'deliver-run',
  propagateExitCode: true,
  errorPrefix: '[deliver-run] ❌ Fatal error',
  usage: USAGE,
});
