#!/usr/bin/env node

/**
 * coordination.js — publish a typed coordination event, or read the inbox of
 * events pertinent to a Story (runbooks/coordination-channel.md).
 *
 * The channel is advisory. Exit codes: 0 on success, degraded, disabled or
 * throttled; 1 on an input the envelope refuses.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { publishEvent } from './lib/coordination/channel.js';
import { EVENT_KINDS, renderEvents } from './lib/coordination/event.js';
import { POLL_TIMEOUT, readInbox } from './lib/coordination/inbox.js';
import { storyIdFromBranch } from './lib/coordination/pertinence.js';
import { flushStdio } from './lib/stdio-flush.js';

const USAGE = `Usage:
  node .agents/scripts/coordination.js publish --kind <kind> --summary <text> [--paths a,b] [--stories 1,2] [--link <ref>] [--story <id>] [--once]
  node .agents/scripts/coordination.js inbox [--story <id> | --all] [--peek] [--since-start] [--throttle] [--json]

The coordination channel: typed events posted as GitHub issue comments, and
an inbox that returns only the ones pertinent to a Story. Advisory: nothing
gates on it. Runbook: .agents/docs/runbooks/coordination-channel.md.

Kinds: ${Object.keys(EVENT_KINDS).join(', ')}.

publish flags:
  --kind <kind>       One of the kinds above (required).
  --summary <text>    One line, at most 200 characters (required).
  --paths a,b         Repo-relative paths or globs the event concerns.
  --stories 1,2       Story ids the event concerns.
  --link <ref>        A repo-relative path or a URL under this repository.
  --story <id>        The acting Story (default: the current story-<id>
                      branch). With none, the event posts on the
                      meta::coordination issue.
  --once              Post nothing when an event of this kind is already on
                      that issue.

inbox flags:
  --story <id>        The reading Story (default: the current branch).
  --all               Every trusted event, unfiltered.
  --peek              Read without advancing the cursor.
  --since-start       Re-list everything pertinent since the reader started;
                      the cursor is untouched.
  --throttle          Skip the read when the last one was under 120 seconds
                      ago.
  --json              Print the envelope as JSON instead of the text block.

  --help              Show this message.

Exit codes: 0 on success, degraded, disabled or throttled; 1 on an input the
envelope refuses.
`;

class UsageError extends Error {}

const PUBLISH_OPTIONS = {
  kind: { type: 'string' },
  summary: { type: 'string' },
  paths: { type: 'string' },
  stories: { type: 'string' },
  link: { type: 'string' },
  story: { type: 'string' },
  once: { type: 'boolean' },
};

const INBOX_OPTIONS = {
  story: { type: 'string' },
  all: { type: 'boolean' },
  peek: { type: 'boolean' },
  'since-start': { type: 'boolean' },
  throttle: { type: 'boolean' },
  json: { type: 'boolean' },
};

/**
 * @param {string[]} args
 * @param {object} options
 * @returns {object}
 */
function parseFlags(args, options) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false })
      .values;
  } catch (err) {
    throw new UsageError(err.message);
  }
}

/**
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function csv(raw) {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * @param {string} raw
 * @param {string} flag
 * @returns {number}
 */
function toId(raw, flag) {
  const text = raw.trim().replace(/^#/, '');
  if (!/^[1-9]\d*$/.test(text)) {
    throw new UsageError(`${flag} needs a positive issue number; got "${raw}"`);
  }
  return Number(text);
}

/** `--story`, else the id of the current `story-<id>` branch, else null. */
function actingStory(story, ctx) {
  if (story !== undefined) return toId(story, '--story');
  try {
    return storyIdFromBranch(ctx.cwd, ctx.git);
  } catch {
    return null;
  }
}

async function publishCommand(args, ctx) {
  const flags = parseFlags(args, PUBLISH_OPTIONS);
  const result = await publishEvent(
    {
      kind: flags.kind,
      summary: flags.summary,
      paths: csv(flags.paths),
      stories: csv(flags.stories).map((id) => toId(id, '--stories')),
      link: flags.link ?? null,
      storyId: actingStory(flags.story, ctx),
    },
    { ...ctx.lib, config: ctx.config(), once: flags.once === true },
  );
  ctx.stdout.write(`${JSON.stringify(result)}\n`);
  return result.refused ? 1 : 0;
}

/**
 * @param {object} result A `readInbox` envelope.
 * @returns {string}
 */
function renderInbox(result) {
  if (result.disabled) return '[Coordination] disabled — nothing read.';
  if (result.skipped) return `[Coordination] ${result.skipped} — nothing read.`;
  if (result.degraded) {
    return `[Coordination] degraded (${result.degraded}) — nothing read.`;
  }
  const { untrusted, invalid } = result.dropped;
  const dropped =
    untrusted + invalid > 0
      ? `\n(dropped: ${untrusted} untrusted, ${invalid} invalid)`
      : '';
  return `${renderEvents(result.events)}${dropped}`;
}

async function inboxCommand(args, ctx) {
  const flags = parseFlags(args, INBOX_OPTIONS);
  if (flags.all && flags.story !== undefined) {
    throw new UsageError('--story and --all are mutually exclusive');
  }
  const storyId = flags.all ? null : actingStory(flags.story, ctx);
  if (!flags.all && storyId === null) {
    throw new UsageError(
      'no Story to read for: pass --story <id> or --all (the current branch is not a story-<id> branch)',
    );
  }
  const result = await readInbox({
    ...ctx.lib,
    config: ctx.config(),
    storyId,
    cwd: ctx.cwd,
    git: ctx.git,
    peek: flags.peek === true,
    sinceStart: flags['since-start'] === true,
    throttle: flags.throttle === true,
  });
  ctx.stdout.write(
    `${flags.json ? JSON.stringify(result) : renderInbox(result)}\n`,
  );
  // The timed-out read is still in flight and would hold the process open.
  if (result.degraded === POLL_TIMEOUT) await ctx.abandon?.();
  return 0;
}

const COMMANDS = { publish: publishCommand, inbox: inboxCommand };

/**
 * @param {string[]} [argv]
 * @param {{ stdout?: object, stderr?: object, env?: NodeJS.ProcessEnv,
 *   cwd?: string, git?: object, provider?: object, notifyFn?: Function,
 *   now?: () => Date, timeoutMs?: number, abandon?: () => Promise<void>,
 *   resolveConfigImpl?: typeof resolveConfig }} [deps]
 * @returns {Promise<number>} The exit code.
 */
export async function runCoordination(argv = process.argv.slice(2), deps = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    cwd = process.cwd(),
    git,
    abandon,
    resolveConfigImpl = resolveConfig,
    ...lib
  } = deps;
  const [command, ...args] = argv;
  try {
    if (!Object.hasOwn(COMMANDS, command ?? '')) {
      throw new UsageError(
        `unknown command ${JSON.stringify(command)}; expected publish or inbox`,
      );
    }
    return await COMMANDS[command](args, {
      stdout,
      cwd,
      git,
      abandon,
      lib,
      config: () => resolveConfigImpl({ cwd }),
    });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`[coordination] ${err.message}\n`);
    return 1;
  }
}

async function main() {
  return runCoordination(process.argv.slice(2), {
    abandon: async () => {
      await flushStdio();
      process.exit(0);
    },
  });
}

runAsCli(import.meta.url, main, {
  source: 'coordination',
  propagateExitCode: true,
  usage: USAGE,
});
