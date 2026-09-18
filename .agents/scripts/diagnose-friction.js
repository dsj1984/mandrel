#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * Diagnostic interceptor: runs a command (argv words, no shell) and on
 * failure prints remediation and appends a local `friction` NDJSON signal —
 * never a ticket comment. With no resolvable Story the write is skipped: a
 * missing signal beats a halted runner.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as osConstants } from 'node:os';
import { INTERCEPTOR_MAX_BUFFER_BYTES } from './lib/child-exec.js';
import { getLimits, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { appendSignal } from './lib/observability/signals-writer.js';

function parseArguments(args) {
  let storyId = null;
  let epicId = null;
  let cmdArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--story') {
      storyId = args[++i] || null;
    } else if (args[i] === '--epic') {
      epicId = args[++i] || null;
    } else if (args[i] === '--cmd') {
      cmdArgs = args.slice(i + 1);
      break;
    }
  }
  return { storyId, epicId, cmdArgs };
}

/**
 * First rule with any matching marker wins.
 * @type {ReadonlyArray<{markers: string[], category: string, remediation: string}>}
 */
const FRICTION_RULES = [
  {
    markers: ['EADDRINUSE', 'address already in use'],
    category: 'Tool Limitation',
    remediation: ' - Port collision detected. Try: `npx kill-port <PORT>`.',
  },
  {
    markers: ['Cannot find module', 'TS2307'],
    category: 'Missing Skill',
    remediation:
      ' - Missing dependency or bad import path. Ensure you are in the correct workspace root and have run `npm install`.',
  },
  {
    markers: ['SyntaxError'],
    category: 'Execution Error',
    remediation:
      ' - Syntax/parsing error. Check recently modified files for missing brackets, quotes, or invalid structures.',
  },
];

const FRICTION_DEFAULT = {
  category: 'Execution Error',
  remediation:
    ' - Generic failure. Review stderr above, refine your approach, or check `.agents/instructions.md`.',
};

function classifyFrictionCategory(errorOutput) {
  const matched = FRICTION_RULES.find((rule) =>
    rule.markers.some((m) => errorOutput.includes(m)),
  );
  if (!matched) return FRICTION_DEFAULT;
  return { category: matched.category, remediation: matched.remediation };
}

/**
 * `spawnSync`'s timeout kills with SIGTERM; any other signal came from outside.
 * @type {string}
 */
const INTERCEPTOR_TIMEOUT_SIGNAL = 'SIGTERM';

/**
 * A maxBuffer overflow is also a SIGTERM; only this error code tells it
 * apart from a timeout.
 * @type {string}
 */
const OVERFLOW_ERROR_CODE = 'ENOBUFS';

const SIGNAL_EXIT_BASE = 128;

/**
 * For a `null` status, which must never reach `process.exit` (null exits 0).
 * SIGTERM + ENOBUFS = buffer overflow, SIGTERM otherwise = timeout, any other
 * signal = the host. Kept module-local: exporting it for tests would trip the
 * `--production` dead-exports gate.
 * @param {{signal: (string|null), error?: {message?: string, code?: string}}}
 *   result
 * @param {{executionTimeoutMs: number, executionMaxBuffer: number}} bounds
 * @returns {{category: string, remediation: string, details: object,
 *   preview: string, exitCode: number}}
 */
function describeAbnormalExit(
  result,
  { executionTimeoutMs, executionMaxBuffer },
) {
  const signal = typeof result.signal === 'string' ? result.signal : null;
  if (signal === null) {
    return {
      category: FRICTION_DEFAULT.category,
      remediation: FRICTION_DEFAULT.remediation,
      details: {
        killedBySignal: null,
        killOrigin: 'spawn-failure',
        executionTimeoutMs,
      },
      preview: `Command did not exit normally and reported no signal: ${result.error?.message ?? 'spawn produced no exit status'}.`,
      exitCode: 1,
    };
  }

  const sentByInterceptor = signal === INTERCEPTOR_TIMEOUT_SIGNAL;
  const overflowed =
    sentByInterceptor && result.error?.code === OVERFLOW_ERROR_CODE;
  let killOrigin = 'external';
  if (overflowed) killOrigin = 'buffer-overflow';
  else if (sentByInterceptor) killOrigin = 'interceptor-timeout';

  const shapes = {
    'buffer-overflow': {
      category: 'Tool Limitation',
      remediation: ` - ${signal} was sent because the command's output overflowed the interceptor's executionMaxBuffer bound (${executionMaxBuffer} bytes / 10 MiB) — the executionTimeoutMs bound (${executionTimeoutMs}ms) did not fire. Do NOT split the command into smaller steps: quieten or redirect its output, or raise the buffer bound.`,
      extraDetails: { executionMaxBuffer },
    },
    'interceptor-timeout': {
      category: 'Execution Timeout',
      remediation: ` - ${signal} matches the interceptor's own executionTimeoutMs bound (${executionTimeoutMs}ms), so the command was almost certainly cut off rather than broken. Split it into smaller steps, or raise the bound.`,
      extraDetails: {},
    },
    external: {
      category: 'Execution Killed',
      remediation: ` - ${signal} originated outside the interceptor — the executionTimeoutMs bound (${executionTimeoutMs}ms) did not fire, so suspect an OOM kill or a hard kill from the host. Reduce the command's memory footprint or give the host more headroom.`,
      extraDetails: {},
    },
  };

  const shape = shapes[killOrigin];
  const signum = osConstants.signals[signal];
  return {
    category: shape.category,
    remediation: shape.remediation,
    details: {
      killedBySignal: signal,
      killOrigin,
      executionTimeoutMs,
      ...shape.extraDetails,
    },
    preview: `Command terminated by signal ${signal} (${killOrigin}); executionTimeoutMs=${executionTimeoutMs}.`,
    exitCode: Number.isInteger(signum) ? SIGNAL_EXIT_BASE + signum : 1,
  };
}

function toIntOrNull(value) {
  if (value == null) return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveContextIds({ storyId, epicId }, settings) {
  const resolvedStoryId =
    toIntOrNull(storyId) ?? toIntOrNull(process.env.STORY_ID);
  const resolvedEpicId =
    toIntOrNull(epicId) ??
    toIntOrNull(process.env.EPIC_ID) ??
    toIntOrNull(process.env.SPRINT_ID) ??
    toIntOrNull(settings.epicId);

  return { storyId: resolvedStoryId, epicId: resolvedEpicId };
}

function buildFrictionSignal({
  epicId,
  storyId,
  category,
  commandStr,
  errorPreview,
  terminationDetails = null,
}) {
  return {
    kind: 'friction',
    eventId: crypto.randomUUID(),
    ts: new Date().toISOString(),
    epicId: epicId ?? null,
    storyId: storyId ?? null,
    // No Task tier; kept for schema compatibility.
    taskId: null,
    category,
    // `classifySignalSource` scans `emitter.command` first to attribute source.
    emitter: {
      tool: 'diagnose-friction.js',
      command: commandStr,
    },
    details: { errorPreview, ...(terminationDetails ?? {}) },
  };
}

export async function main(args = process.argv.slice(2)) {
  const { storyId, epicId, cmdArgs } = parseArguments(args);

  if (cmdArgs.length === 0) {
    throw new Error(
      'Usage: node diagnose-friction.js [--story <STORY_ID>] [--epic <EPIC_ID>] --cmd <cmd> <args...>',
    );
  }

  // No shell, so one whitespace-bearing arg is a usage error that must not
  // reach the ledger. Discriminate on argv shape, not ENOENT: a genuinely
  // absent binary yields the same spawn result and is real friction.
  if (cmdArgs.length === 1 && /\s/.test(cmdArgs[0])) {
    throw new Error(
      `Usage: --cmd takes the command as separate argv words, not one quoted string. Received a single quoted argument: "${cmdArgs[0]}". Drop the quotes so each word is its own argv entry — \`--cmd ${cmdArgs[0]}\`. No friction signal was recorded.`,
    );
  }

  const config = resolveConfig();
  const { executionTimeoutMs } = getLimits();
  // Deliberately below `MAX_BUFFER_BYTES`: a reported policy bound, not an
  // overflow guard.
  const executionMaxBuffer = INTERCEPTOR_MAX_BUFFER_BYTES;

  const commandStr = cmdArgs.join(' ');
  Logger.error(`[Diagnostic Interceptor] Executing: ${commandStr}`);

  const result = spawnSync(cmdArgs[0], cmdArgs.slice(1), {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: executionTimeoutMs,
    maxBuffer: executionMaxBuffer,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const abnormal =
      result.status === null
        ? describeAbnormalExit(result, {
            executionTimeoutMs,
            executionMaxBuffer,
          })
        : null;
    const noOutputFallback = abnormal
      ? abnormal.preview
      : `Unknown exit code ${result.status}`;
    const errorOutput = (
      result.stderr ||
      result.stdout ||
      noOutputFallback
    ).trim();
    const errorPreview = errorOutput.substring(0, 500);

    Logger.error('\n--- 🛑 DIAGNOSTIC ANALYSIS Triggered ---');
    Logger.error(
      'Command failed. Appending friction signal to NDJSON stream...',
    );

    // A killed command's output may be truncated, so it classifies itself.
    const classified = classifyFrictionCategory(errorOutput);
    const category = abnormal?.category ?? classified.category;
    const remediation = abnormal?.remediation ?? classified.remediation;

    const { storyId: resolvedStoryId, epicId: resolvedEpicId } =
      resolveContextIds({ storyId, epicId }, config);

    const signal = buildFrictionSignal({
      epicId: resolvedEpicId,
      storyId: resolvedStoryId,
      category,
      commandStr,
      errorPreview,
      terminationDetails: abnormal?.details ?? null,
    });

    // A null epicId routes to the standalone Story stream.
    if (resolvedStoryId != null) {
      try {
        const ok = await appendSignal({
          epicId: resolvedEpicId,
          storyId: resolvedStoryId,
          signal,
          config,
        });
        if (ok) {
          Logger.error(
            `✅ Friction signal appended (epic=${resolvedEpicId ?? 'standalone'}, story=${resolvedStoryId}).`,
          );
        } else {
          Logger.error(
            `⚠️ signals-writer returned false for epic=${resolvedEpicId ?? 'standalone'} story=${resolvedStoryId}.`,
          );
        }
      } catch (err) {
        Logger.error(`⚠️ Failed to append friction signal: ${err.message}`);
      }
    } else {
      Logger.error(
        `ℹ️ Skipping friction signal write — story context unresolved (story=null, epic=${resolvedEpicId ?? 'null'}).`,
      );
    }

    Logger.error('\n💡 [Auto-Remediation Suggestions]:');
    Logger.error(remediation);
    Logger.error('----------------------------------------\n');

    process.exit(abnormal?.exitCode ?? result.status);
  } else {
    process.exit(0);
  }
}

import { runAsCli } from './lib/cli-utils.js';

runAsCli(import.meta.url, main, {
  source: 'DiagnoseFriction',
  usage: {
    invocation:
      'node .agents/scripts/diagnose-friction.js [--story <id>] [--epic <id>] --cmd <cmd> <args...>',
    summary:
      'Run a command through the diagnostic interceptor: stream its output, then append a local friction signal describing the failure. Never posts to the ticket.',
    flags: [
      ['--story <id>', 'Story the friction belongs to.'],
      ['--epic <id>', 'Epic the friction belongs to.'],
      [
        '--cmd <cmd> <args...>',
        'The command to execute; everything after it is the argv, as separate words — never one quoted string (required).',
      ],
    ],
  },
});
