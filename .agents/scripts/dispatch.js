#!/usr/bin/env node

/**
 * Dispatch a Story's delivery to a named environment, resume or stop it, or
 * read the board. `mandrel dispatch` calls {@link runDispatch} too, so both
 * share one implementation, one envelope and one set of exit codes.
 *
 * Exit codes: 0 success, 2 a refusal (`{ ok: false, reason, detail }`),
 * 1 the command itself could not run.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { parseBlockedBy } from './lib/dependency-parser.js';
import {
  agentStateOf,
  commandFor,
  computeLoads,
  ENV_LABEL_COLOR,
  environmentOf,
  envLabel,
  resolveEnvironments,
} from './lib/dispatch/environments.js';
import { launchCloud } from './lib/dispatch/launch-cloud.js';
import { launchLocal, stopLocal } from './lib/dispatch/launch-local.js';
import {
  readRecord,
  removeRecord,
  writeRecord,
} from './lib/dispatch/record.js';
import {
  buildStatus,
  fetchBoard,
  renderStatus,
} from './lib/dispatch/status.js';
import {
  dryRunFields,
  launchedFields,
  launcherFor,
  launchFailureFields,
  releasesLabel,
  stoppedFields,
} from './lib/dispatch/targets.js';
import { decide } from './lib/dispatch/verdict.js';
import { gh as defaultGh } from './lib/gh-exec.js';
import { AGENT_LABELS, TYPE_LABELS } from './lib/label-constants.js';
import {
  normalizeOperatorHandle,
  releaseLease,
} from './lib/orchestration/ticket-lease.js';
import { transitionTicketState } from './lib/orchestration/ticketing.js';
import { PROJECT_ROOT } from './lib/project-root.js';
import { createProvider } from './lib/provider-factory.js';

const DISPATCH_USAGE = `Usage: mandrel dispatch --env <name> <storyId>
       mandrel dispatch --resume [--env <name>] <storyId>
       mandrel dispatch --stop <storyId>
       mandrel dispatch --status [--json]
       (or: node .agents/scripts/dispatch.js with the same flags)

Starts an agent::ready Story's delivery in a named environment
(delivery.environments; one implicit "local" environment when unset),
labelling the Story env::<name> as the claim. The launched command is the
environment's argv with {id} replaced by the Story id, started detached
without a shell; its output goes to <tempRoot>/dispatch/story-<id>.log.
A claude-cloud environment instead fires its Claude Code routine once with
the payload "mandrel-deliver <id>" and posts the session URL on the Story.

Flags:
  --env <name>  Environment to dispatch to (required for a dispatch).
  --resume      Relaunch an agent::blocked Story in the environment its
                label names; changes no agent::* label.
  --stop        Stop the recorded process, release the lease, return the
                Story to agent::ready and remove its env:: label. The
                branch and worktree are kept. A cloud session is not
                stopped: archive it at the printed session URL.
  --status      Print environments, load and every Story's column.
  --json        With --status, emit the read model as JSON.
  --dry-run     Print the verdict and the argv (or the cloud request,
                Authorization redacted); write and start nothing.
  --help        Show this message.

stdout is one JSON envelope. Exit 0 on success, 2 on a refusal
({ ok: false, reason, detail }), 1 when the command could not run or a
cloud fire failed (reason launch-failed, rate-limited or
launch-unconfirmed).
`;

const STORY_ID_RE = /^[1-9]\d*$/;

function usageError(message) {
  return new Error(`${message} (see --help)`);
}

/**
 * @param {string[]} argv
 * @returns {{ mode: 'dispatch'|'resume'|'stop'|'status', envName: string|null,
 *   storyId: number|null, json: boolean, dryRun: boolean, help: boolean }}
 */
function parseDispatchArgv(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      env: { type: 'string' },
      resume: { type: 'boolean', default: false },
      stop: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const base = {
    envName: values.env ?? null,
    json: values.json,
    dryRun: values['dry-run'],
    help: values.help,
  };
  if (values.help) return { ...base, mode: 'status', storyId: null };
  const modes = ['resume', 'stop', 'status'].filter((m) => values[m]);
  if (modes.length > 1) {
    throw usageError(`--${modes.join(' and --')} are mutually exclusive`);
  }
  const mode = modes[0] ?? 'dispatch';
  if (mode === 'status') return { ...base, mode, storyId: null };
  if (positionals.length !== 1 || !STORY_ID_RE.test(positionals[0])) {
    throw usageError('exactly one positive integer Story id is required');
  }
  if (mode === 'dispatch' && !base.envName) {
    throw usageError('--env <name> is required to dispatch');
  }
  return { ...base, mode, storyId: Number(positionals[0]) };
}

async function openDependencies(provider, body) {
  const unmet = [];
  for (const id of parseBlockedBy(body ?? '')) {
    const dep = await provider.getTicket(id);
    if (String(dep?.state ?? '').toLowerCase() === 'open') unmet.push(id);
  }
  return unmet;
}

/** Everything `decide` needs about one Story, read live. */
async function gatherVerdictInput({ ctx, mode, storyId, envName }) {
  const { provider, environments } = ctx;
  const story = await provider.getTicket(storyId);
  const isEpic = (story.labels ?? []).includes(TYPE_LABELS.EPIC);
  const children = isEpic
    ? (await provider.getSubTickets(storyId)).map((c) => c.id)
    : [];
  const target = envName ?? environmentOf(story.labels);
  const held = environments.some((e) => e.name === target)
    ? await provider.listTicketsByLabel({
        state: 'open',
        labels: envLabel(target),
      })
    : [];
  return {
    action: mode,
    story,
    envName,
    environments,
    loads: computeLoads(environments, held),
    unmetDependencies: await openDependencies(provider, story.body),
    children,
    operator: ctx.operator,
  };
}

async function launch({ ctx, verdict, storyId }) {
  const { provider, deps, config } = ctx;
  const environment = ctx.environments.find(
    (e) => e.name === verdict.environment,
  );
  const label = envLabel(environment.name);
  if (verdict.applyLabel) {
    await provider.ensureLabels([
      {
        name: label,
        color: ENV_LABEL_COLOR,
        description: `Held by delivery environment "${environment.name}".`,
      },
    ]);
    await provider.updateTicket(storyId, { labels: { add: [label] } });
  }
  const head = {
    action: verdict.action,
    storyId,
    environment: environment.name,
  };
  let record;
  try {
    record = await launcherFor(
      environment,
      deps,
    )({
      storyId,
      environment,
      cwd: ctx.cwd,
      config,
      provider,
    });
  } catch (err) {
    if (releasesLabel(verdict.applyLabel, err)) {
      await provider.updateTicket(storyId, { labels: { remove: [label] } });
    }
    return { ok: false, ...head, ...launchFailureFields(err) };
  }
  deps.writeRecordImpl(record, { config });
  return { ok: true, ...head, ...launchedFields(record) };
}

async function stop({ ctx, verdict, storyId, story }) {
  const { provider, deps, config, operator } = ctx;
  const record = deps.readRecordImpl(storyId, { config });
  if (record?.pid) deps.stopImpl(record.pid);
  if (operator) {
    await deps.releaseLeaseImpl({ provider, ticketId: storyId, operator });
  }
  if (agentStateOf(story.labels) !== AGENT_LABELS.READY) {
    await deps.transitionImpl(provider, storyId, AGENT_LABELS.READY, {
      config,
    });
  }
  await provider.updateTicket(storyId, {
    labels: { remove: [envLabel(verdict.environment)] },
  });
  deps.removeRecordImpl(storyId, { config });
  return {
    ok: true,
    action: 'stop',
    storyId,
    environment: verdict.environment,
    pid: record?.pid ?? null,
    ...stoppedFields(record),
  };
}

function dryRunEnvelope({ ctx, verdict, storyId }) {
  const envelope = {
    ok: true,
    action: verdict.action,
    storyId,
    environment: verdict.environment,
    dryRun: true,
  };
  if (verdict.action === 'stop') return envelope;
  const environment = ctx.environments.find(
    (e) => e.name === verdict.environment,
  );
  return { ...envelope, ...dryRunFields(environment, storyId, commandFor) };
}

async function act(ctx, args) {
  const input = await gatherVerdictInput({ ctx, ...args });
  const verdict = decide(input);
  if (!verdict.ok) return { code: 2, envelope: verdict };
  const step = { ctx, verdict, storyId: args.storyId, story: input.story };
  if (args.dryRun) return { code: 0, envelope: dryRunEnvelope(step) };
  const envelope = args.mode === 'stop' ? await stop(step) : await launch(step);
  // A failed cloud fire is the command failing: exit 1.
  return { code: Number(!envelope.ok), envelope };
}

async function status(ctx, { json }) {
  const board = await ctx.deps.fetchBoardImpl({
    provider: ctx.provider,
    gh: ctx.deps.gh,
    config: ctx.config,
  });
  const model = buildStatus({
    environments: ctx.environments,
    ...board,
    operator: ctx.operator,
  });
  return json
    ? { code: 0, envelope: model }
    : { code: 0, text: renderStatus(model) };
}

/**
 * The shared entry: parse, decide, act, and write one envelope to stdout.
 *
 * @param {string[]} argv
 * @param {{
 *   config?: object, provider?: object, gh?: object, cwd?: string,
 *   write?: (s: string) => void,
 *   resolveConfigImpl?: typeof resolveConfig,
 *   createProviderImpl?: typeof createProvider,
 *   launchImpl?: typeof launchLocal, stopImpl?: typeof stopLocal,
 *   launchCloudImpl?: typeof launchCloud, fetchImpl?: typeof fetch,
 *   env?: Record<string, string|undefined>,
 *   fetchBoardImpl?: typeof fetchBoard,
 *   transitionImpl?: typeof transitionTicketState,
 *   releaseLeaseImpl?: typeof releaseLease,
 *   writeRecordImpl?: typeof writeRecord, readRecordImpl?: typeof readRecord,
 *   removeRecordImpl?: typeof removeRecord,
 * }} [overrides]
 * @returns {Promise<number>} The exit code.
 */
export async function runDispatch(argv, overrides = {}) {
  const deps = {
    write: (s) => process.stdout.write(s),
    resolveConfigImpl: resolveConfig,
    createProviderImpl: createProvider,
    launchImpl: launchLocal,
    stopImpl: stopLocal,
    launchCloudImpl: (args) =>
      launchCloud(args, { fetchImpl: deps.fetchImpl, env: deps.env }),
    env: process.env,
    fetchBoardImpl: fetchBoard,
    transitionImpl: transitionTicketState,
    releaseLeaseImpl: releaseLease,
    writeRecordImpl: writeRecord,
    readRecordImpl: readRecord,
    removeRecordImpl: removeRecord,
    gh: defaultGh,
    cwd: PROJECT_ROOT,
    ...overrides,
  };
  let result;
  try {
    const args = parseDispatchArgv(argv);
    if (args.help) {
      deps.write(DISPATCH_USAGE);
      return 0;
    }
    const config = deps.config ?? deps.resolveConfigImpl({ cwd: deps.cwd });
    const ctx = {
      deps,
      config,
      cwd: deps.cwd,
      provider: deps.provider ?? deps.createProviderImpl(config),
      environments: resolveEnvironments(config, deps.env),
      operator: normalizeOperatorHandle(config?.github?.operatorHandle),
    };
    result =
      args.mode === 'status' ? await status(ctx, args) : await act(ctx, args);
  } catch (err) {
    result = {
      code: 1,
      envelope: { ok: false, error: err?.message ?? String(err) },
    };
  }
  deps.write(result.text ?? `${JSON.stringify(result.envelope, null, 2)}\n`);
  return result.code;
}

runAsCli(import.meta.url, () => runDispatch(process.argv.slice(2)), {
  source: 'dispatch',
  usage: DISPATCH_USAGE,
  propagateExitCode: true,
});
