#!/usr/bin/env node

/* node:coverage ignore file */

/**
 * epic-plan-healthcheck.js — Post-Plan Readiness Check
 *
 * Runs at the end of /sprint-plan (Phase 4) to validate the backlog and
 * optionally prime the execution environment before handing off to
 * /sprint-execute.
 *
 * Modes (additive — fast checks always run):
 *   --fast (default)  — config validation + git remote check only.
 *                       Targets <2s.
 *   --paranoid        — adds ticket-hierarchy + dependency-cycle
 *                       revalidation.
 *   --prime-install   — adds the pnpm content-addressable-store priming
 *                       path (up to 300s).
 *
 * Output: a single line of structured JSON on stdout —
 *   { ok, degraded, reason, checks: [{name, ok, durationMs, detail}] }
 *
 * The script always exits 0; callers decide whether to act on `ok: false`.
 * The plan is already committed to GitHub, so failing the script does not
 * un-create tickets.
 *
 * Usage:
 *   node epic-plan-healthcheck.js --epic <EPIC_ID> \
 *     [--fast|--paranoid] [--prime-install] [--dry-run]
 *
 * @see .agents/workflows/sprint-plan.md Phase 4
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseTicketId } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { parseBlockedBy } from './lib/dependency-parser.js';
import { buildGraph, detectCycle } from './lib/Graph.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { createProvider } from './lib/provider-factory.js';

const progress = Logger.createProgress('plan-healthcheck', { stderr: true });

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/**
 * Parse the healthcheck-specific CLI surface. Kept local to the script so the
 * shared `parseSprintArgs` helper does not have to learn about every script's
 * private flags.
 *
 * @param {string[]} [argv]
 * @returns {{ epicId: number|null, fast: boolean, paranoid: boolean,
 *   primeInstall: boolean, dryRun: boolean }}
 */
export function parseHealthcheckArgs(argv = process.argv) {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      epic: { type: 'string', short: 'e' },
      fast: { type: 'boolean', default: false },
      paranoid: { type: 'boolean', default: false },
      'prime-install': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    epicId: parseTicketId(values.epic) ?? parseTicketId(positionals[0]),
    fast: !!values.fast,
    paranoid: !!values.paranoid,
    primeInstall: !!values['prime-install'],
    dryRun: !!values['dry-run'],
  };
}

// ---------------------------------------------------------------------------
// Individual checks
//
// Each check returns { ok: boolean, detail: string }. The orchestrator wraps
// it with `name` and `durationMs` for the structured output.
// ---------------------------------------------------------------------------

/** Validate `.agentrc.json` orchestration block. */
function checkConfig(orchestration) {
  try {
    validateOrchestrationConfig(orchestration);
    return { ok: true, detail: 'Orchestration config is valid.' };
  } catch (err) {
    return { ok: false, detail: `Config validation failed: ${err.message}` };
  }
}

/** Verify `origin` is reachable and `baseBranch` exists on it. */
function checkGitRemote(baseBranch, cwd) {
  const remote = gitSpawn(
    cwd,
    'ls-remote',
    '--exit-code',
    'origin',
    baseBranch,
  );
  if (remote.status === 0) {
    return {
      ok: true,
      detail: `Remote reachable, base branch '${baseBranch}' exists.`,
    };
  }
  if (
    remote.stderr.includes('Could not resolve host') ||
    remote.stderr.includes('unable to access')
  ) {
    return {
      ok: false,
      detail: `Git remote 'origin' is not reachable: ${remote.stderr.slice(0, 200)}`,
    };
  }
  return {
    ok: false,
    detail: `Base branch '${baseBranch}' not found on origin.`,
  };
}

/** Validate Epic ticket hierarchy and dependency-graph acyclicity. */
async function checkTickets(provider, epicId) {
  if (!epicId) {
    return {
      ok: false,
      detail: '--paranoid requires --epic <ID> to fetch the ticket hierarchy.',
    };
  }

  let tickets;
  try {
    tickets = await provider.getSubTickets(epicId);
  } catch (err) {
    return {
      ok: false,
      detail: `Could not fetch Epic #${epicId} tickets: ${err.message}`,
    };
  }

  if (tickets.length === 0) {
    return { ok: false, detail: `Epic #${epicId} has no child tickets.` };
  }

  const features = tickets.filter((t) =>
    t.labels.includes(TYPE_LABELS.FEATURE),
  );
  const stories = tickets.filter((t) => t.labels.includes(TYPE_LABELS.STORY));
  const tasks = tickets.filter((t) => t.labels.includes(TYPE_LABELS.TASK));

  const errors = [];
  if (features.length === 0) errors.push('no type::feature tickets');
  if (stories.length === 0) errors.push('no type::story tickets');
  if (tasks.length === 0) errors.push('no type::task tickets');

  if (tasks.length > 1) {
    const graphTasks = tasks.map((t) => ({
      ...t,
      dependsOn: parseBlockedBy(t.body ?? '').filter((dep) =>
        tasks.some((tt) => tt.id === dep),
      ),
    }));
    const { adjacency } = buildGraph(graphTasks);
    const cycle = detectCycle(adjacency);
    if (cycle) errors.push(`dependency cycle: #${cycle.join(' -> #')}`);
  }

  if (errors.length > 0) {
    return { ok: false, detail: errors.join('; ') };
  }

  const missingComplexity = stories.filter(
    (s) => !s.labels.some((l) => l.startsWith('complexity::')),
  );
  const advisory =
    missingComplexity.length > 0
      ? ` (advisory: ${missingComplexity.length} story/stories missing complexity label)`
      : '';

  return {
    ok: true,
    detail: `${features.length} features, ${stories.length} stories, ${tasks.length} tasks — hierarchy valid, no cycles${advisory}.`,
  };
}

/** Prime the pnpm content-addressable store via `pnpm install --frozen-lockfile`. */
function primePnpmStore(cwd, dryRun) {
  const lockFile = path.join(cwd, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockFile)) {
    return {
      ok: false,
      detail: 'No pnpm-lock.yaml found — cannot prime store.',
    };
  }
  if (dryRun) {
    return { ok: true, detail: 'pnpm store prime skipped (dry-run).' };
  }

  progress('PRIME', 'Priming pnpm content-addressable store...');
  const start = Date.now();
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: 300_000,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.status === 0) {
    return { ok: true, detail: `pnpm store primed in ${elapsed}s.` };
  }
  const reason =
    result.signal === 'SIGTERM'
      ? `timeout after ${elapsed}s`
      : `exit ${result.status}`;
  return {
    ok: false,
    detail: `pnpm store prime failed (${reason}). First worktree install will be slower. stderr: ${(result.stderr ?? '').slice(0, 300)}`,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function timed(name, fn) {
  const start = Date.now();
  const { ok, detail } = await fn();
  return { name, ok, durationMs: Date.now() - start, detail };
}

/**
 * Run the post-plan health check.
 *
 * @param {object} [opts]
 * @param {number} [opts.epicId]              Epic ID (required for --paranoid).
 * @param {boolean} [opts.fast]               Run fast checks only (default).
 * @param {boolean} [opts.paranoid]           Add hierarchy + dep-cycle checks.
 * @param {boolean} [opts.primeInstall]       Add pnpm-store priming.
 * @param {boolean} [opts.dryRun]             Skip real install side effects.
 * @param {object}  [opts.injectedProvider]   Test-only injection point.
 * @param {object}  [opts.injectedConfig]     Test-only injection point.
 * @returns {Promise<{ok: boolean, degraded: boolean, reason: string|null,
 *   checks: Array<{name: string, ok: boolean, durationMs: number, detail: string}>}>}
 */
export async function runPlanHealthcheck(opts = {}) {
  const ARG_KEYS = ['epicId', 'fast', 'paranoid', 'primeInstall', 'dryRun'];
  const hasExplicitArgs = ARG_KEYS.some((k) => Object.hasOwn(opts, k));
  const parsed = hasExplicitArgs
    ? {
        epicId: opts.epicId ?? null,
        fast: !!opts.fast,
        paranoid: !!opts.paranoid,
        primeInstall: !!opts.primeInstall,
        dryRun: !!opts.dryRun,
      }
    : parseHealthcheckArgs();

  const { epicId, paranoid, primeInstall, dryRun } = parsed;
  const cwd = PROJECT_ROOT;

  const { settings, orchestration } = opts.injectedConfig || resolveConfig();
  const baseBranch = settings.baseBranch ?? 'main';

  progress(
    'HEALTH',
    `Running post-plan health check${epicId ? ` for Epic #${epicId}` : ''} (mode=${paranoid ? 'paranoid' : 'fast'}${primeInstall ? '+prime-install' : ''})...`,
  );

  const checks = [];

  // Fast lane: config + git remote always run.
  progress('CHECK', 'Validating orchestration config...');
  checks.push(await timed('config', async () => checkConfig(orchestration)));

  progress('CHECK', 'Checking git remote...');
  checks.push(
    await timed('git-remote', async () => checkGitRemote(baseBranch, cwd)),
  );

  // Paranoid lane: ticket-hierarchy + dep-cycle revalidation.
  if (paranoid) {
    const provider = opts.injectedProvider || createProvider(orchestration);
    progress('CHECK', 'Validating ticket hierarchy...');
    checks.push(
      await timed('ticket-hierarchy', () => checkTickets(provider, epicId)),
    );
  }

  // Optional pnpm-store priming.
  if (primeInstall) {
    progress('CHECK', 'Priming pnpm store...');
    checks.push(
      await timed('prime-install', async () => primePnpmStore(cwd, dryRun)),
    );
  }

  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;
  const result = {
    ok,
    degraded: !ok,
    reason: ok ? null : failed.map((c) => `${c.name}: ${c.detail}`).join('; '),
    checks,
  };

  if (ok) {
    progress('HEALTH', `All ${checks.length} check(s) passed.`);
  } else {
    progress(
      'HEALTH',
      `${failed.length} of ${checks.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}.`,
    );
  }

  // The structured result is the only thing on stdout.
  console.log(JSON.stringify(result));

  return result;
}

// ---------------------------------------------------------------------------
// Main guard
// ---------------------------------------------------------------------------

runAsCli(import.meta.url, runPlanHealthcheck, {
  source: 'epic-plan-healthcheck',
});
