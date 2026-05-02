#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * wave-prepare.js — read the dispatch-manifest, select the wave's Stories,
 * and emit the `StoryLauncher.planWave` plan as JSON.
 *
 * `/wave-execute` historically expressed Steps 1–2 as English prose: "find
 * the dispatch-manifest comment, JSON-parse the fence, filter
 * `payload.stories.filter(s => s.wave === N)`, then call planWave on the
 * result." This CLI is the imperative form: one operator-runnable invocation
 * that returns the canonical `{ epicId, wave, concurrencyCap, plan }`
 * envelope the wave runner consumes.
 *
 * Selection contract — the canonical persisted field is `wave` (Story #964
 * reconciled this with the in-memory `earliestWave` used by the manifest
 * renderer). Stories whose `wave` does not match `--wave` are filtered out.
 *
 * Failure modes that are reported as a `friction` structured comment on the
 * Epic (and exit 2):
 *   - the dispatch-manifest comment is missing;
 *   - the dispatch-manifest comment is malformed (parser returns null /
 *     missing `stories` array);
 *   - no Stories on the manifest match the requested wave.
 *
 * CLI:
 *   --epic <id>   Epic ticket id (required, positive integer).
 *   --wave <n>    Wave number to prepare (required, non-negative integer).
 *
 * Stdout: a single JSON envelope:
 *   {
 *     epicId: number,
 *     wave: number,
 *     concurrencyCap: number,
 *     plan: [{ storyId, title, modelTier, worktree }]
 *   }
 *
 * Title is sourced from the dispatch-manifest entry; modelTier and worktree
 * come from `StoryLauncher.planWave` (which respects per-Story `modelTier`
 * label or `model::*` ticket labels and the configured worktree resolver).
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getRunners } from './lib/config/runners.js';
import { resolveConfig } from './lib/config-resolver.js';
import { StoryLauncher } from './lib/orchestration/epic-runner/story-launcher.js';
import { parseFencedJsonComment } from './lib/orchestration/structured-comment-parser.js';
import {
  findStructuredComment,
  postStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/wave-prepare.js --epic <EPIC_ID> --wave <N>

Reads the dispatch-manifest structured comment off Epic #<EPIC_ID>, filters
its stories list to those whose \`wave === N\`, runs StoryLauncher.planWave
on the selection, and prints the wave dispatch plan as JSON.

Exit codes:
  0 — plan emitted on stdout.
  2 — manifest missing/malformed, or no stories match the requested wave.
      A \`friction\` structured comment is posted on the Epic explaining
      the failure before exit.
`;

const FRICTION_TYPE = 'friction';

/**
 * Build a friction comment body for the given failure shape. Pure helper —
 * no provider call. Exposed so tests can pin the rendered shape without
 * round-tripping through the provider.
 *
 * @param {{
 *   epicId: number,
 *   wave: number,
 *   reason: 'missing-manifest' | 'malformed-manifest' | 'no-stories-for-wave',
 *   detail?: string,
 * }} args
 * @returns {string}
 */
export function renderFrictionBody({ epicId, wave, reason, detail }) {
  const lines = [
    `### 🚧 wave-prepare friction — Epic #${epicId}, wave ${wave}`,
    '',
    `**Reason:** \`${reason}\``,
  ];
  if (detail) {
    lines.push('', detail);
  }
  lines.push(
    '',
    'Resolve and re-run `node .agents/scripts/wave-prepare.js ' +
      `--epic ${epicId} --wave ${wave}\`.`,
  );
  return lines.join('\n');
}

/**
 * Post a friction structured comment on the Epic and signal exit 2 to the
 * caller. Returns the failure envelope the test harness asserts against —
 * `runAsCli` callers see exit-2 instead.
 *
 * @param {{ provider: object, epicId: number, wave: number, reason: string, detail?: string }} args
 * @returns {Promise<never>}
 */
async function reportFriction({ provider, epicId, wave, reason, detail }) {
  const body = renderFrictionBody({ epicId, wave, reason, detail });
  try {
    await postStructuredComment(provider, epicId, FRICTION_TYPE, body);
  } catch (err) {
    console.error(
      `[wave-prepare] Failed to post friction comment on #${epicId}: ${err.message}`,
    );
  }
  const summary = `[wave-prepare] ${reason} (epic=${epicId}, wave=${wave})`;
  console.error(summary);
  if (detail) console.error(detail);
  // Propagate via a typed error so `runWavePrepare` callers in tests can
  // assert on `err.code === 'WAVE_PREPARE_FRICTION'` instead of relying on
  // process.exit interception.
  const err = new Error(summary);
  err.code = 'WAVE_PREPARE_FRICTION';
  err.reason = reason;
  err.detail = detail;
  throw err;
}

/**
 * End-to-end wave prepare. DI-friendly: tests pass `injectedProvider` and
 * an injected `concurrencyCap` via the orchestration config, so no real
 * network or filesystem reads are required.
 *
 * @param {{
 *   epicId: number,
 *   wave: number,
 *   injectedProvider?: object,
 *   injectedConcurrencyCap?: number,
 *   injectedWorktreeResolver?: (storyId: number) => string,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   wave: number,
 *   concurrencyCap: number,
 *   plan: Array<{ storyId: number, title: string, modelTier: string, worktree?: string }>,
 * }>}
 */
export async function runWavePrepare(args = {}) {
  const {
    epicId,
    wave,
    injectedProvider,
    injectedConcurrencyCap,
    injectedWorktreeResolver,
  } = args;

  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runWavePrepare: --epic must be a positive integer');
  }
  if (!Number.isInteger(wave) || wave < 0) {
    throw new TypeError(
      'runWavePrepare: --wave must be a non-negative integer',
    );
  }

  const config = resolveConfig();
  const provider = injectedProvider ?? createProvider(config.orchestration);

  // 1. Read the dispatch-manifest comment.
  const comment = await findStructuredComment(
    provider,
    epicId,
    'dispatch-manifest',
  );
  if (!comment) {
    await reportFriction({
      provider,
      epicId,
      wave,
      reason: 'missing-manifest',
      detail:
        `No \`dispatch-manifest\` structured comment found on Epic #${epicId}. ` +
        'Run `node .agents/scripts/dispatcher.js <epicId>` to produce one.',
    });
  }

  // 2. Parse the fenced JSON payload.
  const payload = parseFencedJsonComment(comment);
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.stories)
  ) {
    await reportFriction({
      provider,
      epicId,
      wave,
      reason: 'malformed-manifest',
      detail:
        `dispatch-manifest comment #${comment.id} on Epic #${epicId} could ` +
        'not be parsed as JSON or did not contain a `stories` array.',
    });
  }

  // 3. Filter stories for the requested wave. The canonical persisted field
  //    is `wave` (Story #964 reconciled this with the in-memory
  //    `earliestWave` used by the manifest renderer).
  const eligible = payload.stories.filter(
    (s) => Number(s?.wave) === Number(wave),
  );
  if (eligible.length === 0) {
    await reportFriction({
      provider,
      epicId,
      wave,
      reason: 'no-stories-for-wave',
      detail:
        `dispatch-manifest carries ${payload.stories.length} story(ies) but ` +
        `none have \`wave === ${wave}\`. ` +
        'Verify the manifest was regenerated for the current sprint.',
    });
  }

  // 4. Resolve concurrency cap from config.
  const epicRunner = getRunners(config).epicRunner ?? {};
  const concurrencyCap =
    injectedConcurrencyCap ?? Number(epicRunner.concurrencyCap) ?? 1;
  if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
    throw new RangeError(
      `runWavePrepare: resolved concurrencyCap "${concurrencyCap}" must be a positive integer; ` +
        'set `orchestration.runners.epicRunner.concurrencyCap` in agent-settings.json5.',
    );
  }

  // 5. Plan the wave. We pass the manifest entries directly — `planWave`
  //    accepts `{ id?, storyId?, modelTier?, labels? }`-shaped objects. The
  //    manifest carries `storyId` already.
  const launcher = new StoryLauncher({
    concurrencyCap,
    worktreeResolver: injectedWorktreeResolver,
  });
  const planRows = launcher.planWave(
    eligible.map((s) => ({
      id: Number(s.storyId ?? s.id),
      storyId: Number(s.storyId ?? s.id),
      title: String(s.title ?? ''),
      modelTier: s.modelTier,
      labels: Array.isArray(s.labels) ? s.labels : undefined,
    })),
  );

  // 6. Cross-look the manifest title onto each plan row. `planWave` does not
  //    propagate title, but the operator-facing JSON should carry it.
  const titleById = new Map(
    eligible.map((s) => [Number(s.storyId ?? s.id), String(s.title ?? '')]),
  );
  const plan = planRows.map((row) => ({
    storyId: row.storyId,
    title: titleById.get(row.storyId) ?? '',
    modelTier: row.modelTier,
    worktree: row.worktree,
  }));

  return { epicId, wave, concurrencyCap, plan };
}

/**
 * Parse argv into the runner contract.
 *
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      wave: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return {
    help: Boolean(values.help),
    epicId: Number.parseInt(values.epic ?? '', 10),
    wave: Number.parseInt(values.wave ?? '', 10),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    const envelope = await runWavePrepare(parsed);
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } catch (err) {
    if (err && err.code === 'WAVE_PREPARE_FRICTION') {
      process.exit(2);
    }
    throw err;
  }
}

runAsCli(import.meta.url, main, { source: 'wave-prepare' });
