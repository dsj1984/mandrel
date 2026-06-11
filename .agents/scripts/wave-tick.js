#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * wave-tick.js — thin CLI shim around `lib/wave-runner/tick.js`.
 *
 * Reads the `epic-run-state` checkpoint plus fresh Story labels and
 * prints one `WaveTickResult` envelope. The slash-command operator
 * (`/deliver`) consumes the envelope to decide whether to dispatch
 * the next wave, observe in-flight stories, or finalize the Epic.
 *
 * Usage:
 *   node .agents/scripts/wave-tick.js --epic <epicId> [--check-idle <minutes>]
 *
 * The tick is stateless — "loop until terminal" is the caller's job
 * (today: the markdown's wave loop).
 *
 * Output: one JSON object on stdout. Schema in `lib/wave-runner/tick.js`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { epicLedgerPath } from './lib/config/temp-paths.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';
import { tick } from './lib/wave-runner/tick.js';

const HELP = `Usage: node .agents/scripts/wave-tick.js --epic <epicId> [--check-idle <minutes>]

Stateless wave-loop planner. Reads the epic-run-state checkpoint on
Epic #<id>, evaluates the live story-label state, and prints one
WaveTickResult envelope describing the next dispatchable action.

When --check-idle <minutes> is supplied, the planner skips the normal
WaveTickResult emit and instead scans the per-Epic lifecycle ledger
(temp/epic-<id>/lifecycle.ndjson) for in-flight Stories whose most
recent lifecycle event is older than the threshold. Emits a single
JSON envelope on stdout and exits non-zero when at least one stalled
Story is detected. The envelope shape mirrors the wave-stall
structured-comment payload so the slash-command host can post it
verbatim.
`;

export async function runWaveTickCli({
  epicId,
  cwd,
  injectedProvider,
  injectedConfig,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runWaveTickCli: --epic must be a positive integer');
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config);

  const result = await tick({
    epic: epicId,
    collaborators: { provider },
    ctx: { config },
  });

  return result;
}

/**
 * Scan the per-Epic lifecycle ledger and compute, per in-flight Story,
 * the timestamp of its most recent lifecycle event. A Story is
 * "in-flight" when the ledger carries a `story.dispatch.start` record
 * without a matching `story.dispatch.end`. Any other `story.*` event
 * (notably `story.heartbeat` from Story #3057) refreshes the Story's
 * last-event timestamp.
 *
 * Pure helper — exported for unit tests.
 *
 * @param {string} ledgerPath Absolute path to `lifecycle.ndjson`.
 * @returns {Map<number, string>} `storyId → ISO-8601 timestamp`. Empty
 *   when the ledger is missing, unreadable, or carries no in-flight
 *   Stories.
 */
export function readLedgerLastEvents(ledgerPath) {
  if (!ledgerPath || !existsSync(ledgerPath)) return new Map();
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return new Map();
  }
  if (!raw) return new Map();
  const started = new Set();
  const ended = new Set();
  const lastTs = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || record.kind !== 'emitted') continue;
    const event = typeof record.event === 'string' ? record.event : '';
    if (!event.startsWith('story.')) continue;
    const storyId = record.payload?.storyId;
    if (!Number.isInteger(storyId) || storyId <= 0) continue;
    if (event === 'story.dispatch.start') started.add(storyId);
    else if (event === 'story.dispatch.end') ended.add(storyId);
    const ts = typeof record.ts === 'string' ? record.ts : null;
    if (ts) {
      const prior = lastTs.get(storyId);
      if (!prior || prior < ts) lastTs.set(storyId, ts);
    }
  }
  const out = new Map();
  for (const id of started) {
    if (ended.has(id)) continue;
    const ts = lastTs.get(id);
    if (ts) out.set(id, ts);
  }
  return out;
}

/**
 * Deterministic branch-activity resolver (Story #3900). Returns the epoch-ms
 * timestamp of the most recent commit on `story-<storyId>` via
 * `git log -1 --format=%cI`, or `null` when the branch does not exist, has no
 * commits, or git is unavailable.
 *
 * This is the secondary liveness signal the idle watchdog consults before
 * flagging a Story as stalled: a healthy long-running Story routinely exceeds
 * the heartbeat threshold during `implementing → closing` (heartbeats fire
 * only at phase transitions), but its branch keeps gaining commits. A recent
 * commit is hard, deterministic evidence of forward progress that does not
 * depend on a heartbeat landing in the ledger. Pure-ish (shells out to git)
 * and injectable so unit tests never spawn a subprocess.
 *
 * @param {number} storyId
 * @param {{ cwd?: string, exec?: typeof execFileSync }} [deps]
 * @returns {number|null} epoch-ms of the last commit, or null.
 */
export function branchLastCommitMs(storyId, deps = {}) {
  const exec = deps.exec ?? execFileSync;
  const cwd = deps.cwd ?? process.cwd();
  try {
    const out = exec(
      'git',
      ['log', '-1', '--format=%cI', `story-${storyId}`, '--'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    // Branch absent / git unavailable — no deterministic signal.
    return null;
  }
}

/**
 * Build the wave-stall envelope. Pure helper — exported for unit tests.
 *
 * A Story whose latest ledger event is older than the threshold is *not*
 * flagged as stalled when its `story-<id>` branch carries a commit newer
 * than the threshold (Story #3900). Branch commits are deterministic
 * forward-progress evidence that survives the heartbeat-cadence gap during
 * `implementing → closing`, so consulting them eliminates the false-positive
 * re-dispatch hazard (two agents on one branch) the watchdog otherwise
 * manufactures for every healthy long-running Story.
 *
 * @param {object} args
 * @param {number} args.epicId
 * @param {number} args.thresholdMinutes
 * @param {Map<number, string>} args.lastEvents `storyId → ISO-8601 ts`
 *   from {@link readLedgerLastEvents}.
 * @param {Date} args.now Reference clock for the staleness comparison.
 * @param {(storyId: number) => (number|null)} [args.branchActivity]
 *   Resolver for the last commit epoch-ms on `story-<id>`. Defaults to
 *   {@link branchLastCommitMs}. Injected for tests.
 * @returns {{
 *   kind: 'wave-stall',
 *   epicId: number,
 *   thresholdMinutes: number,
 *   checkedAt: string,
 *   stalled: Array<{storyId: number, lastEventAt: string, idleMinutes: number}>,
 *   inFlight: number[]
 * }}
 */
export function buildWaveStallEnvelope({
  epicId,
  thresholdMinutes,
  lastEvents,
  now,
  branchActivity = branchLastCommitMs,
}) {
  const checkedAt = now.toISOString();
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const stalled = [];
  const inFlight = [];
  for (const [storyId, ts] of lastEvents) {
    inFlight.push(storyId);
    const eventMs = Date.parse(ts);
    if (!Number.isFinite(eventMs)) continue;
    const idleMs = now.getTime() - eventMs;
    if (idleMs < thresholdMs) continue;

    // Ledger says idle — consult the branch as a deterministic liveness
    // signal before declaring a stall. A recent commit means the Story is
    // making progress despite the heartbeat-cadence gap.
    const commitMs = branchActivity(storyId);
    if (
      typeof commitMs === 'number' &&
      Number.isFinite(commitMs) &&
      now.getTime() - commitMs < thresholdMs
    ) {
      continue;
    }

    stalled.push({
      storyId,
      lastEventAt: ts,
      idleMinutes: Math.floor(idleMs / 60000),
    });
  }
  inFlight.sort((a, b) => a - b);
  stalled.sort((a, b) => a.storyId - b.storyId);
  return {
    kind: 'wave-stall',
    epicId,
    thresholdMinutes,
    checkedAt,
    stalled,
    inFlight,
  };
}

/**
 * Run the `--check-idle` path. Exported so unit tests can drive the
 * branch without spawning the CLI subprocess.
 *
 * @param {object} args
 * @param {number} args.epicId
 * @param {number} args.thresholdMinutes
 * @param {string} [args.ledgerPath] Override for tests; defaults to the
 *   canonical `temp/epic-<id>/lifecycle.ndjson`.
 * @param {Date} [args.now] Override for tests; defaults to wall clock.
 * @param {object} [args.config] Optional resolved config for tempRoot.
 * @param {(storyId: number) => (number|null)} [args.branchActivity]
 *   Branch-liveness resolver; defaults to {@link branchLastCommitMs}.
 *   Injected for tests so the watchdog never spawns git.
 * @returns {{envelope: object, stalledCount: number}}
 */
export function runCheckIdle({
  epicId,
  thresholdMinutes,
  ledgerPath,
  now = new Date(),
  config,
  branchActivity = branchLastCommitMs,
}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runCheckIdle: epicId must be a positive integer');
  }
  if (!Number.isInteger(thresholdMinutes) || thresholdMinutes <= 0) {
    throw new TypeError(
      'runCheckIdle: thresholdMinutes must be a positive integer',
    );
  }
  const resolvedPath = ledgerPath ?? epicLedgerPath(epicId, config);
  const lastEvents = readLedgerLastEvents(resolvedPath);
  const envelope = buildWaveStallEnvelope({
    epicId,
    thresholdMinutes,
    lastEvents,
    now,
    branchActivity,
  });
  return { envelope, stalledCount: envelope.stalled.length };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      'check-idle': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const epicId = Number.parseInt(
    String(values.epic ?? '').replace(/^#/, ''),
    10,
  );
  if (!Number.isInteger(epicId) || epicId <= 0) {
    Logger.error('wave-tick: --epic <id> is required (positive integer)');
    process.exitCode = 2;
    return;
  }

  if (values['check-idle'] !== undefined) {
    const thresholdMinutes = Number.parseInt(String(values['check-idle']), 10);
    if (!Number.isInteger(thresholdMinutes) || thresholdMinutes <= 0) {
      Logger.error(
        'wave-tick: --check-idle <minutes> must be a positive integer',
      );
      process.exitCode = 2;
      return;
    }
    const { envelope, stalledCount } = runCheckIdle({
      epicId,
      thresholdMinutes,
    });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    process.exitCode = stalledCount > 0 ? 1 : 0;
    return;
  }

  const result = await runWaveTickCli({ epicId });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, () => main(process.argv.slice(2)), {
  source: 'wave-tick',
});
