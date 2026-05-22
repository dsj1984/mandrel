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
 *   node diagnose-friction.js [--task <TASK_ID>] [--story <STORY_ID>] \
 *     [--epic <EPIC_ID>] --cmd <command with args...>
 *
 * Story/Epic resolution order:
 *   1. CLI flags (--story, --epic).
 *   2. Environment vars (STORY_ID, EPIC_ID / SPRINT_ID).
 *   3. Task ticket body parse (`parent: #<storyId>`, `Epic: #<epicId>`).
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
import { getLimits, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { appendSignal } from './lib/observability/signals-writer.js';
import { createProvider } from './lib/provider-factory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArguments(args) {
  let taskId = null;
  let storyId = null;
  let epicId = null;
  let cmdArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task') {
      taskId = args[++i] || null;
    } else if (args[i] === '--story') {
      storyId = args[++i] || null;
    } else if (args[i] === '--epic') {
      epicId = args[++i] || null;
    } else if (args[i] === '--cmd') {
      cmdArgs = args.slice(i + 1);
      break;
    }
  }
  return { taskId, storyId, epicId, cmdArgs };
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
  {
    markers: ['Astro', 'astro'],
    category: 'Missing Skill',
    remediation:
      ' - Framework error: Refer to `.agents/skills/stack/frontend/astro/SKILL.md` for Astro rules.',
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

function toIntOrNull(value) {
  if (value == null) return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function resolveContextIds(
  provider,
  { taskId, storyId, epicId },
  settings,
) {
  let resolvedStoryId =
    toIntOrNull(storyId) ?? toIntOrNull(process.env.STORY_ID);
  let resolvedEpicId =
    toIntOrNull(epicId) ??
    toIntOrNull(process.env.EPIC_ID) ??
    toIntOrNull(process.env.SPRINT_ID) ??
    toIntOrNull(settings.epicId);

  if (
    (resolvedStoryId == null || resolvedEpicId == null) &&
    taskId &&
    !process.env.NO_NETWORK
  ) {
    try {
      const ticket = await provider.getTicket(taskId);
      const body = ticket.body ?? '';
      if (resolvedStoryId == null) {
        const storyMatch = body.match(/^parent:\s*#(\d+)/im);
        if (storyMatch) resolvedStoryId = toIntOrNull(storyMatch[1]);
      }
      if (resolvedEpicId == null) {
        const epicMatch = body.match(/(?:^|\n)Epic:\s*#(\d+)/i);
        if (epicMatch) resolvedEpicId = toIntOrNull(epicMatch[1]);
      }
    } catch (err) {
      Logger.error(
        `⚠️ Failed to resolve story/epic context from task #${taskId}: ${err.message}`,
      );
    }
  }

  return { storyId: resolvedStoryId, epicId: resolvedEpicId };
}

function buildFrictionSignal({
  epicId,
  storyId,
  taskId,
  category,
  commandStr,
  errorPreview,
}) {
  return {
    kind: 'friction',
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    epicId: epicId ?? null,
    storyId: storyId ?? null,
    taskId: taskId ? Number.parseInt(taskId, 10) : null,
    category,
    source: {
      tool: 'diagnose-friction.js',
      command: commandStr,
    },
    details: errorPreview,
  };
}

// ---------------------------------------------------------------------------
// Main Execution
// ---------------------------------------------------------------------------

export async function main(args = process.argv.slice(2)) {
  const { taskId, storyId, epicId, cmdArgs } = parseArguments(args);

  if (cmdArgs.length === 0) {
    throw new Error(
      'Usage: node diagnose-friction.js [--task <TASK_ID>] [--story <STORY_ID>] [--epic <EPIC_ID>] --cmd <command with args...>',
    );
  }

  const config = resolveConfig();
  const limits = getLimits(config);
  const executionTimeoutMs = limits.executionTimeoutMs;
  // Hardcoded post-reshape (Epic #1720 Story #1739). Node `spawnSync`
  // buffer ceiling — 10 MiB is the framework-wide value used by every
  // child-process spawn site. An OOM symptom, not a domain knob.
  const executionMaxBuffer = 10485760;

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
    const errorOutput = (
      result.stderr ||
      result.stdout ||
      `Unknown exit code ${result.status}`
    ).trim();
    const errorPreview = errorOutput.substring(0, 500);

    Logger.error('\n--- 🛑 DIAGNOSTIC ANALYSIS Triggered ---');
    Logger.error(
      'Command failed. Appending friction signal to NDJSON stream...',
    );

    const { category, remediation } = classifyFrictionCategory(errorOutput);

    const provider = createProvider(resolveConfig().orchestration);
    const { storyId: resolvedStoryId, epicId: resolvedEpicId } =
      await resolveContextIds(
        provider,
        { taskId, storyId, epicId },
        config.agentSettings,
      );

    const signal = buildFrictionSignal({
      epicId: resolvedEpicId,
      storyId: resolvedStoryId,
      taskId,
      category,
      commandStr,
      errorPreview,
    });

    // Story #2874 — accept story-only context (no parent Epic). When
    // only the story is resolved, write to the standalone signals
    // stream at `<tempRoot>/standalone/story-<sid>/signals.ndjson`
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
            `✅ Friction signal appended (epic=${resolvedEpicId ?? 'standalone'}, story=${resolvedStoryId}, task=${taskId ?? 'n/a'}).`,
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

    process.exit(result.status);
  } else {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Call main if run directly
// ---------------------------------------------------------------------------

import { runAsCli } from './lib/cli-utils.js';

runAsCli(import.meta.url, main, { source: 'DiagnoseFriction' });
