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

function classifyFrictionCategory(errorOutput) {
  if (
    errorOutput.includes('EADDRINUSE') ||
    errorOutput.includes('address already in use')
  ) {
    return {
      category: 'Tool Limitation',
      remediation: ' - Port collision detected. Try: `npx kill-port <PORT>`.',
    };
  }
  if (
    errorOutput.includes('Cannot find module') ||
    errorOutput.includes('TS2307')
  ) {
    return {
      category: 'Missing Skill',
      remediation:
        ' - Missing dependency or bad import path. Ensure you are in the correct workspace root and have run `npm install`.',
    };
  }
  if (errorOutput.includes('SyntaxError')) {
    return {
      category: 'Execution Error',
      remediation:
        ' - Syntax/parsing error. Check recently modified files for missing brackets, quotes, or invalid structures.',
    };
  }
  if (errorOutput.includes('Astro') || errorOutput.includes('astro')) {
    return {
      category: 'Missing Skill',
      remediation:
        ' - Framework error: Refer to `.agents/skills/stack/frontend/astro/SKILL.md` for Astro rules.',
    };
  }
  return {
    category: 'Execution Error',
    remediation:
      ' - Generic failure. Review stderr above, refine your approach, or check `.agents/instructions.md`.',
  };
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
      console.error(
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
    Logger.fatal(
      'Usage: node diagnose-friction.js [--task <TASK_ID>] [--story <STORY_ID>] [--epic <EPIC_ID>] --cmd <command with args...>',
    );
  }

  const { settings } = resolveConfig();
  const limits = getLimits({ agentSettings: settings });
  const executionTimeoutMs = limits.executionTimeoutMs;
  const executionMaxBuffer = limits.executionMaxBuffer;

  const commandStr = cmdArgs.join(' ');
  console.error(`[Diagnostic Interceptor] Executing: ${commandStr}`);

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

    console.error('\n--- 🛑 DIAGNOSTIC ANALYSIS Triggered ---');
    console.error(
      'Command failed. Appending friction signal to NDJSON stream...',
    );

    const { category, remediation } = classifyFrictionCategory(errorOutput);

    const provider = createProvider(resolveConfig().orchestration);
    const { storyId: resolvedStoryId, epicId: resolvedEpicId } =
      await resolveContextIds(provider, { taskId, storyId, epicId }, settings);

    const signal = buildFrictionSignal({
      epicId: resolvedEpicId,
      storyId: resolvedStoryId,
      taskId,
      category,
      commandStr,
      errorPreview,
    });

    if (resolvedEpicId != null && resolvedStoryId != null) {
      try {
        const ok = await appendSignal({
          epicId: resolvedEpicId,
          storyId: resolvedStoryId,
          signal,
        });
        if (ok) {
          console.error(
            `✅ Friction signal appended (epic=${resolvedEpicId}, story=${resolvedStoryId}, task=${taskId ?? 'n/a'}).`,
          );
        } else {
          console.error(
            `⚠️ signals-writer returned false for epic=${resolvedEpicId} story=${resolvedStoryId}.`,
          );
        }
      } catch (err) {
        console.error(`⚠️ Failed to append friction signal: ${err.message}`);
      }
    } else {
      console.error(
        `ℹ️ Skipping friction signal write — story/epic context unresolved (story=${resolvedStoryId ?? 'null'}, epic=${resolvedEpicId ?? 'null'}).`,
      );
    }

    console.error('\n💡 [Auto-Remediation Suggestions]:');
    console.error(remediation);
    console.error('----------------------------------------\n');

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
