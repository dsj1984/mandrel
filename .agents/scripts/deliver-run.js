#!/usr/bin/env node

/**
 * deliver-run.js — one beat of a multi-Story `/mandrel-deliver` run
 * (Story #5345).
 *
 * The multi-Story path used to be a hand-driven protocol: loop
 * `stories-wave-tick.js`, keep an append-only `--dispatched` list across
 * beats, paste a `node --input-type=module -e` block to build each worker's
 * checklist, and remember to add `--merge-watch-mode async` to every close
 * because close cannot see run topology. Four pieces of bookkeeping, all of
 * them carried in the session's head, each of them silently wrong when
 * forgotten — a dropped `--dispatched` id joins a second worker to a live
 * branch, and a forgotten async flag serializes the run's merge waits.
 *
 * This CLI is that bookkeeping, scripted. One beat per invocation:
 *
 *   1. Tick with `--probe-live`, seeding `dispatched` from the **run ledger**
 *      rather than from the caller (`<tempRoot>/run-<id>/ledger.json`).
 *   2. Write one dispatch prompt per ready Story — id, `workCwd` conventions,
 *      docs digest path, checklist path, change-set discipline — so the
 *      session's spawn is "use this file as the prompt" and nothing else.
 *   3. Print the exact `single-story-close.js` command for every hand-off,
 *      with `--merge-watch-mode async` decided from run topology here, where
 *      the topology is known.
 *
 * Stdout is one compact JSON envelope (`kind: "deliver-run-beat"`). The
 * tick's exit-code contract is preserved byte for byte — 0 ok · 1 input
 * error · 2 cycle · 3 wedged · 4 blocked — because the loop's stopping rules
 * are the tick's and this script must not invent a second dialect of them.
 *
 * Scheduling itself is untouched: the ready set, the concurrency cap, the
 * footprint guard and the foreign-lease withholding all come from
 * `stories-wave-tick.js#runProbedStoriesWaveTick`. This is a ledger, a
 * prompt writer and a command renderer around that one beat.
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
    '--merge-watch-mode async is added to every close command when the run holds\nmore than one Story, and omitted for a run of one. Close sees a single Story\nand cannot make that call for itself.',
    'Exit codes:\n  0  beat emitted\n  1  input error\n  2  dependency cycle (cycleError)\n  3  wedged\n  4  blocked — the HITL pause; stop the loop, do not poll',
  ],
};

/**
 * Derive the run's stable identity from its Story id set.
 *
 * The identity must be the same on every beat of one run (so the ledger is
 * found again) and different across runs (so two concurrent deliveries do not
 * share a dispatched list). The sorted id set is the only thing that satisfies
 * both — a timestamp fails the first, and a single id fails the second.
 *
 * @param {number[]} ids
 * @returns {string} an 8-hex-character digest
 */
export function deriveRunId(ids) {
  const key = [...new Set(ids)].sort((a, b) => a - b).join(',');
  return createHash('sha1').update(key).digest('hex').slice(0, 8);
}

/**
 * Read the run ledger's dispatched ids, tolerating absence and corruption.
 *
 * A ledger that cannot be read is treated as empty rather than fatal: the
 * consequence is one extra beat of the init window (which `--dispatched`
 * existed to close), whereas refusing the beat would strand a live run on a
 * bookkeeping artifact.
 *
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
 * Persist the union of the previously-ledgered ids and the ids handed out on
 * this beat. Append-only by construction: nothing here removes an id, so the
 * caller cannot get the "forgot to re-list one" failure `--dispatched` had.
 *
 * @param {object} args
 * @param {string} args.ledgerPath
 * @param {string} args.runId
 * @param {number[]} args.stories
 * @param {number[]} args.dispatched  ids already ledgered
 * @param {number[]} args.ready       ids handed out this beat
 * @param {{ writeFileFn?: (p: string, c: string, enc: string) => void }} [deps]
 * @returns {number[]} the persisted dispatched set
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
 * Render the close command for one hand-off.
 *
 * `--merge-watch-mode async` is a **run-topology** decision, which is why it
 * is made here: the close process sees one Story and cannot tell whether a
 * sibling is queued behind its merge wait. On a multi-Story run the serialized
 * close tail is the dominant cost, and each synchronous close holds the
 * foreground for its full merge wait before the next may start; on a run of
 * one there is no sibling to unblock and the sync default reaches `landed`
 * fastest.
 *
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
 * Render one ready Story's dispatch prompt — the whole spawn payload, so the
 * session's `Agent` call is this file and nothing else.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.mainRepo
 * @param {string|null} args.docsDigestPath
 * @param {string|null} args.checklistPath
 * @returns {string} markdown
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
 * Build one ready Story's dispatch prompt file and return its entry.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.body        the Story body the probe already fetched
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
    // `parse` returns `{ body, warnings, info }` — the path entries live on
    // `.body`, not at the top level. The retired `node -e` snippet in
    // `helpers/deliver-reference.md` destructured the top level and so built
    // every checklist from an empty footprint.
    const { body: parsed } = parseStoryBody(body ?? '');
    changes = parsed?.changes ?? [];
    references = parsed?.references ?? [];
  } catch {
    // An unparseable body costs a footprint-matched checklist, never the
    // dispatch: the worker reads the real Story body itself, and close-scope
    // lens coverage runs maker-blind regardless.
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
 * Flatten the two withhold reports the tick emits into one list, so an
 * unfilled dispatch slot is explained in a single place.
 *
 * @param {object} envelope the tick envelope
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
 * The input-error result, shaped like a beat envelope so a caller branching on
 * `kind` never has to special-case the failure.
 *
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
 * Resolve the ids for `--stories` and `--handoff`, or the error to report.
 *
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
 * Run one beat: tick, write the dispatch prompts, persist the ledger, render
 * the close commands, and shape the envelope.
 *
 * Every collaborator is injectable so the beat is testable without a provider,
 * a network call or the repository's own temp root.
 *
 * @param {object} args
 * @param {string} args.stories            raw `--stories` value
 * @param {string[]} [args.handoff]        raw `--handoff` values
 * @param {string} [args.concurrency]      raw `--concurrency` value
 * @param {string} [args.runId]            explicit run id
 * @param {string} [args.cwd]              main checkout
 * @param {object} [args.config]           pre-resolved config (test injection)
 * @param {Function} [args.probe]          tick probe seam (test injection)
 * @param {Function} [args.context]        tick provider-context seam
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
    // The ledger IS the dispatched list. It is additive, never authoritative:
    // the probe unions it into the label-derived in-flight set and then
    // filters it against live state, so an id that has since gone done is
    // dropped rather than pinned in flight forever.
    dispatched: ledgered.join(','),
    cwd: mainRepo,
    ...(config ? { config } : {}),
    ...(probe ? { probe } : {}),
    ...(context ? { context } : {}),
  });

  if (tick?.inputError) return inputError(tick.inputError);

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
      withheld: collectWithheld(tick),
    },
    exitCode,
  };
}

/**
 * Parse argv into the beat's inputs.
 *
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
      help: { type: 'boolean', short: 'h' },
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
