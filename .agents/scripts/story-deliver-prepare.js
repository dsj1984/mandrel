#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-deliver-prepare.js — post-init / pre-implementation prep step.
 *
 * After `story-init.js` has prepared the worktree and the operator (or
 * sub-agent) has `cd`'d into the workCwd, this CLI consolidates the three
 * things `/story-deliver` Step 0.5/0.6 used to express in English prose:
 *
 *   1. Read the `story-init` structured comment off the Story ticket via
 *      `findStructuredComment`. The comment carries `workCwd`, the install
 *      tri-state, and the canonical task list — re-derived here so a
 *      resumed run doesn't have to retain `story-init` stdout.
 *
 *   2. Apply the `dependenciesInstalled` tri-state truth table:
 *        - `'true'`     → install already succeeded; skip.
 *        - `'false'`    → install was attempted and failed; run the install
 *                         command (default `npm ci`; `project.commands`
 *                         doesn't carry a dedicated `install` key today —
 *                         the `commands.test` adjacency is the spec hook for
 *                         a future override).
 *        - `'skipped'`  → no per-worktree install was performed (single-tree
 *                         or symlink/pnpm-store strategy); trust the strategy.
 *
 *   3. Upsert the initial `story-run-progress` snapshot with every Task
 *      pinned to `pending` and `phase: 'init'` via `upsertStoryRunProgress`.
 *
 * Stdout: a single JSON envelope `{ workCwd, dependenciesInstalled,
 * installAction, snapshot, renderedBody }` so the caller can decide what to
 * do next without re-reading the comment. `renderedBody` is the markdown
 * body that was upserted onto the Story ticket — `/story-deliver` relays it
 * as a chat message at the start of each Story so operators see the initial
 * task table before the first commit lands.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { runInstallCommand } from './lib/install-cmd-parser.js';
import {
  defaultStoryPhases,
  STORY_RUN_PROGRESS_TYPE,
  upsertStoryRunProgress,
} from './lib/orchestration/epic-runner/story-run-progress-writer.js';
import { parseFencedJsonComment } from './lib/orchestration/structured-comment-parser.js';
import { findStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { notify } from './notify.js';

const HELP = `Usage: node .agents/scripts/story-deliver-prepare.js \\
  --story <id> [--cwd <workCwd>] [--skip-install] [--install-cmd "<cmd>"]

Reads the story-init structured comment off Story #<id>, runs the install
command when dependenciesInstalled === 'false', then upserts the initial
story-run-progress snapshot (phase=init, every Task pending).
`;

const VALID_INSTALLED_STATES = new Set(['true', 'false', 'skipped']);

/**
 * Apply the dependenciesInstalled tri-state to derive the next install action.
 * Pure helper — exposes the Step 0.5 truth table as data so tests can pin
 * each branch without spinning up a child process.
 *
 * @param {'true' | 'false' | 'skipped'} dependenciesInstalled
 * @param {{ skipInstall?: boolean }} [options]
 * @returns {'skip' | 'install'}
 */
export function deriveInstallAction(dependenciesInstalled, options = {}) {
  if (!VALID_INSTALLED_STATES.has(dependenciesInstalled)) {
    throw new RangeError(
      `deriveInstallAction: dependenciesInstalled "${dependenciesInstalled}" must be one of: ${[...VALID_INSTALLED_STATES].join(', ')}`,
    );
  }
  if (options.skipInstall) return 'skip';
  return dependenciesInstalled === 'false' ? 'install' : 'skip';
}

/**
 * Resolve the install command to run when `dependenciesInstalled === 'false'`.
 * `project.commands` does not currently carry a dedicated install key,
 * so this defaults to `npm ci`. Operators can override per-invocation via
 * `--install-cmd` (mirrors the spec note about a `commands.test`-adjacent
 * future override).
 *
 * @param {{ override?: string }} [options]
 * @returns {string}
 */
export function resolveInstallCommand(options = {}) {
  const trimmed = options.override?.trim();
  if (trimmed) {
    return trimmed;
  }
  return 'npm ci';
}

/**
 * Hydrate the `story-init` payload off the Story ticket. Returns `null` when
 * the comment can't be located (the operator must run `story-init` first).
 *
 * @param {{ provider: object, storyId: number }} args
 * @returns {Promise<object | null>}
 */
export async function readStoryInitComment({ provider, storyId }) {
  const comment = await findStructuredComment(provider, storyId, 'story-init');
  if (!comment) return null;
  const payload = parseFencedJsonComment(comment);
  if (!payload || typeof payload !== 'object') return null;
  return payload;
}

/**
 * End-to-end prepare. DI-friendly: tests pass `provider`, `runner`, and
 * skip the real network/child-process side effects.
 *
 * @param {{
 *   storyId: number,
 *   cwd?: string,
 *   skipInstall?: boolean,
 *   installCmd?: string,
 *   provider?: object,
 *   runInstall?: (cmd: string, cwd: string) => { status: number, stderr?: string },
 *   tasksOverride?: object[],
 * }} args
 * @returns {Promise<{
 *   storyId: number,
 *   workCwd: string,
 *   dependenciesInstalled: string,
 *   installAction: 'skip' | 'install',
 *   installCmd: string | null,
 *   installResult: { status: number, stderr?: string } | null,
 *   snapshot: object,
 *   renderedBody: string,
 * }>}
 */
export async function runStoryDeliverPrepare(args) {
  const {
    storyId,
    cwd: cwdOverride,
    skipInstall = false,
    installCmd: installCmdOverride,
    provider: providerOverride,
    runInstall: runInstallOverride,
    tasksOverride,
  } = args ?? {};

  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new TypeError(
      'runStoryDeliverPrepare: --story must be a positive integer',
    );
  }

  const config = providerOverride ? null : resolveConfig();
  const provider = providerOverride ?? createProvider(config);
  const notifyFn = providerOverride
    ? null
    : (ticketId, payload, opts = {}) =>
        notify(ticketId, payload, {
          config,
          provider,
          ...opts,
        });

  // 1. Hydrate the story-init payload off the Story ticket.
  const initPayload = await readStoryInitComment({ provider, storyId });
  if (!initPayload) {
    throw new Error(
      `runStoryDeliverPrepare: no story-init comment found on #${storyId}; ` +
        `run \`node .agents/scripts/story-init.js --story ${storyId}\` first.`,
    );
  }
  const dependenciesInstalled = String(
    initPayload.dependenciesInstalled ?? 'skipped',
  );
  const workCwd = String(initPayload.workCwd ?? cwdOverride ?? process.cwd());

  // 2. Apply the install tri-state.
  const installAction = deriveInstallAction(dependenciesInstalled, {
    skipInstall,
  });
  let installCmd = null;
  let installResult = null;
  if (installAction === 'install') {
    installCmd = resolveInstallCommand({ override: installCmdOverride });
    installResult = (runInstallOverride ?? runInstallCommand)(
      installCmd,
      workCwd,
    );
    if (installResult.status !== 0) {
      throw new Error(
        `runStoryDeliverPrepare: install command \`${installCmd}\` failed with status ${installResult.status}: ${installResult.stderr ?? ''}`,
      );
    }
  }

  // 3. Upsert the initial story-run-progress snapshot.
  //
  //    The 3-tier migration (Epic #3078) made the inline-acceptance Story
  //    the only ticket shape: Stories have no child Tasks, so every
  //    production `story-init` comment records an empty `tasks[]`, and no
  //    CLI flag wires `tasksOverride` (it is a DI-only test seam — see
  //    `parseArgv`, which never sets it). The per-Task `tasks[]` branch
  //    below is therefore NOT exercised by any production caller; it is
  //    retained solely so unit-test fixtures that pin `tasksOverride` or a
  //    non-empty `tasks[]` payload still resolve. Shape selection:
  //
  //    - `tasksOverride` or `initPayload.tasks[]` non-empty → per-Task
  //      `tasks[]` snapshot (test-fixture path only).
  //    - Otherwise (every production run) → Story-phase `phases[]`
  //      snapshot (init/implement/validate/close pinned to `pending`).
  const hierarchy = String(initPayload.hierarchy ?? '3-tier');
  const branch = String(initPayload.storyBranch ?? `story-${storyId}`);

  const initPayloadTasks = Array.isArray(initPayload.tasks)
    ? initPayload.tasks
    : [];

  if (!tasksOverride && initPayloadTasks.length === 0) {
    const phases = defaultStoryPhases();
    const { body: renderedBody, payload: snapshot } =
      await upsertStoryRunProgress({
        provider,
        storyId,
        branch,
        phase: 'init',
        phases,
        notify: notifyFn,
      });
    return {
      storyId,
      workCwd,
      dependenciesInstalled,
      installAction,
      installCmd,
      installResult,
      hierarchy,
      snapshot,
      renderedBody,
    };
  }

  const tasks =
    tasksOverride ??
    initPayloadTasks.map((t) => ({
      id: Number(t.id ?? t.number),
      title: String(t.title ?? ''),
      state: 'pending',
    }));
  const { body: renderedBody, payload: snapshot } =
    await upsertStoryRunProgress({
      provider,
      storyId,
      branch,
      phase: 'init',
      tasks,
      notify: notifyFn,
    });

  return {
    storyId,
    workCwd,
    dependenciesInstalled,
    installAction,
    installCmd,
    installResult,
    hierarchy,
    snapshot,
    renderedBody,
  };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      cwd: { type: 'string' },
      'skip-install': { type: 'boolean' },
      'install-cmd': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return {
    help: Boolean(values.help),
    storyId: Number.parseInt(values.story ?? '', 10),
    cwd: values.cwd,
    skipInstall: Boolean(values['skip-install']),
    installCmd: values['install-cmd'],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const envelope = await runStoryDeliverPrepare(parsed);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

// Re-export for symmetry with the other prepare-suite CLIs.
export { STORY_RUN_PROGRESS_TYPE };

runAsCli(import.meta.url, main, { source: 'story-deliver-prepare' });
