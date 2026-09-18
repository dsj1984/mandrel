#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * diagnose-friction.js — v5 Diagnostic Interceptor & Friction Signal Detector
 *
 * Wraps a shell command with telemetry capture. On failure:
 *   1. Prints static diagnostic suggestions to stdout.
 *   2. Appends a structured `friction` record to the per-Story
 *      `signals.ndjson` stream via `signals-writer.appendSignal` (when
 *      both `--story` and `--epic` can be resolved).
 *
 * In v5 (Epic #1030), friction is a **local NDJSON signal**, not a GitHub
 * comment. The detector posts no comments; the analyzer reads the NDJSON
 * stream out-of-band. See Tech Spec #1032 §observability.
 *
 * Usage:
 *   node diagnose-friction.js [--story <STORY_ID>] \
 *     [--epic <EPIC_ID>] --cmd <cmd> <args...>
 *
 * `--cmd` consumes the remaining argv as separate words and spawns them with
 * no shell. Quoting the whole command as one string is a usage error, not
 * friction — it is refused loudly and writes no ledger row.
 *
 * Story/Epic resolution order:
 *   1. CLI flags (--story, --epic).
 *   2. Environment vars (STORY_ID, EPIC_ID / SPRINT_ID).
 *
 * If neither story nor epic can be resolved, the script still prints
 * diagnostic suggestions but skips the signal write (a missing signal is
 * preferable to a halted runner — see signals-writer best-effort contract).
 *
 * @see docs/v5-implementation-plan.md Sprint 3E
 * @see .agents/scripts/lib/observability/signals-writer.js
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as osConstants } from 'node:os';
import { INTERCEPTOR_MAX_BUFFER_BYTES } from './lib/child-exec.js';
import { getLimits, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { appendSignal } from './lib/observability/signals-writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Ordered classification rules. The first rule whose `markers` are found
 * (any-match) wins. Table-driven so adding a new pattern doesn't grow the
 * cyclomatic complexity of `classifyFrictionCategory`.
 *
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
 * `spawnSync`'s own `timeout` option kills the child with `SIGTERM`, so a
 * SIGTERM observed here almost always means the interceptor's configured
 * `executionTimeoutMs` bound fired. Any other signal — a `SIGKILL` from the
 * OOM killer, an operator `kill -9` — originated outside this process.
 *
 * @type {string}
 */
const INTERCEPTOR_TIMEOUT_SIGNAL = 'SIGTERM';

/**
 * A `maxBuffer` overflow presents identically to a timeout — `status: null`,
 * `signal: 'SIGTERM'` — because Node kills the child the same way. The only
 * discriminator is `result.error.code`, so a SIGTERM carrying this code is a
 * buffer overflow and must never be reported as a timeout (Story #4915).
 *
 * @type {string}
 */
const OVERFLOW_ERROR_CODE = 'ENOBUFS';

/** Shell convention for "the process died by signal N": exit `128 + N`. */
const SIGNAL_EXIT_BASE = 128;

/**
 * Describe a child that never exited normally — `status === null`, Node's
 * documented representation of "did not exit normally". The raw status must
 * never reach `process.exit`, because `process.exit(null)` exits **0**: the
 * interceptor would report success for a command it just watched get killed
 * (Story #4851).
 *
 * Which signal fired is the diagnostic value: SIGTERM points at one of the
 * interceptor's own bounds, anything else at the host. A SIGTERM splits again
 * on `error.code`: `ENOBUFS` means the output blew past `executionMaxBuffer`,
 * anything else means `executionTimeoutMs` fired. Recording that plus the
 * bound itself is what makes the row actionable to a consumer who cannot edit
 * the materialized framework tree.
 *
 * Deliberately module-local and pure — exporting it for tests would fail the
 * `--production` dead-exports ratchet, and folding it into `main` would spend
 * the file's per-file maintainability-delta headroom. The CLI contract is the
 * seam the unit tests drive.
 *
 * @param {{signal: (string|null), error?: {message?: string, code?: string}}}
 *   result A `spawnSync` result whose `status` is `null`.
 * @param {{executionTimeoutMs: number, executionMaxBuffer: number}} bounds The
 *   resolved interceptor bounds — the timeout in ms, the buffer in bytes.
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
    // 2-tier hierarchy (Epic #3163): no Task tier, so friction signals
    // carry no Task id. The field is retained for schema compatibility
    // and always null.
    taskId: null,
    category,
    // `emitter.command` is what `classifySignalSource` step 1 scans, so the
    // command-scan stays authoritative for `source`: a consumer command killed
    // by its own host remains consumer-actionable (Story #4851).
    emitter: {
      tool: 'diagnose-friction.js',
      command: commandStr,
    },
    details: { errorPreview, ...(terminationDetails ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Main Execution
// ---------------------------------------------------------------------------

export async function main(args = process.argv.slice(2)) {
  const { storyId, epicId, cmdArgs } = parseArguments(args);

  if (cmdArgs.length === 0) {
    throw new Error(
      'Usage: node diagnose-friction.js [--story <STORY_ID>] [--epic <EPIC_ID>] --cmd <cmd> <args...>',
    );
  }

  // Story #4915 — the interceptor spawns `cmdArgs[0]` directly, with no shell.
  // A single argument containing whitespace therefore names an executable that
  // cannot exist, and the resulting ENOENT is a usage error in the
  // interceptor's OWN invocation, not friction in the wrapped command. It must
  // be reported as one and MUST NOT reach the ledger — otherwise the real
  // friction is discarded and the roll-up eventually auto-files a framework-gap
  // ticket about the framework's own instrumentation being misused. The
  // discriminator is this argv shape, never the ENOENT result: a correctly
  // split command whose binary is genuinely absent yields the identical
  // `spawnSync` result and stays real friction.
  if (cmdArgs.length === 1 && /\s/.test(cmdArgs[0])) {
    throw new Error(
      `Usage: --cmd takes the command as separate argv words, not one quoted string. Received a single quoted argument: "${cmdArgs[0]}". Drop the quotes so each word is its own argv entry — \`--cmd ${cmdArgs[0]}\`. No friction signal was recorded.`,
    );
  }

  const config = resolveConfig();
  const { executionTimeoutMs } = getLimits();
  // The interceptor's bound is deliberately *below* the framework-wide
  // `MAX_BUFFER_BYTES` ceiling: it is a reported policy bound whose value the
  // emitted friction row carries (`details.executionMaxBuffer`), not an
  // overflow guard. Story #5009 moved its definition to the shared
  // child-process surface so it is no longer a hand-copied literal here.
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
    // A `null` status means the child never exited normally; the cause lives in
    // `result.signal`, not in the status.
    const abnormal =
      result.status === null
        ? describeAbnormalExit(result, {
            executionTimeoutMs,
            executionMaxBuffer,
          })
        : null;
    // With both streams empty an abnormal termination names its signal; the
    // `Unknown exit code` fallback is therefore reachable only with a real
    // numeric status, never as `Unknown exit code null`.
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

    // An abnormal termination classifies itself: the marker scan reads output
    // the kill may have truncated (or never produced), so it cannot name the
    // signal.
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

    // Story #2874 — accept story-only context (no parent Epic). When
    // only the story is resolved, write to the standalone signals
    // stream at `<tempRoot>/standalone/stories/story-<sid>/signals.ndjson`
    // by passing `epicId: null` through to the writer. The only case
    // we still skip is fully-no-context (story unresolved).
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

    // Never `process.exit(result.status)` on a null status — that exits 0 and
    // reports success for a killed command.
    process.exit(abnormal?.exitCode ?? result.status);
  } else {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Call main if run directly
// ---------------------------------------------------------------------------

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
