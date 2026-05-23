#!/usr/bin/env node
/* node:coverage ignore file -- thin CLI wrapper; logic covered by lib + fixture tests */

/**
 * epic-deliver-reconcile.js — host-crash watchdog CLI.
 *
 * Story #2506 (Epic #2501). Wraps `reconcileEpicAgentLabels` (see
 * `./lib/orchestration/epic-deliver-reconcile.js`) as an operator-facing
 * CLI invoked after a host reboot or unexpected agent death:
 *
 *   node .agents/scripts/epic-deliver-reconcile.js --epic 2501
 *   node .agents/scripts/epic-deliver-reconcile.js --epic 2501 --auto-recover
 *
 * Behavior:
 *   - Lists every direct child of the Epic still carrying `agent::executing`
 *     or `agent::closing`, probes the recorded dispatch PID, and partitions
 *     the Stories into `live / dead / unknown` buckets.
 *   - Always upserts a `friction` structured comment on the Epic naming the
 *     dead and unknown Stories so the operator (or the host LLM) has a
 *     durable artifact to act on.
 *   - With `--auto-recover`, writes `temp/epic-<id>/recovery-plan.json`
 *     listing the dead Stories — the host LLM consumes this envelope to
 *     re-dispatch them.
 *
 * This script is **read-only with respect to ticket state**: it never flips
 * labels. The operator (or a follow-up workflow) is responsible for
 * transitioning dead Stories back to `agent::ready` before re-dispatch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { reconcileEpicAgentLabels } from './lib/orchestration/epic-deliver-reconcile.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-reconcile.js --epic <id> [--auto-recover]

Reconcile an Epic's child Stories against running PIDs after a host crash.
Lists Stories still pinned at agent::executing or agent::closing, probes
each Story's recorded dispatch PID, and posts a friction structured
comment to the Epic naming the dead and unknown entries.

Flags:
  --epic <id>       Epic ticket ID to reconcile (required).
  --auto-recover    Write temp/epic-<id>/recovery-plan.json listing dead
                    Stories for the host LLM to re-dispatch.
  --provider <p>    Override the configured provider (default: inferred
                    from the .agentrc.json `github` block).
  --repo-root <p>   Override the repo-root path used to resolve PID files
                    (default: process.cwd()).
  --help            Show this message.
`;

function formatStoryLine(s) {
  const title = s.title ? ` — ${s.title}` : '';
  const pidPart = s.pid != null ? ` (pid ${s.pid})` : ' (no PID recorded)';
  return `- #${s.id}${title}${pidPart}`;
}

/**
 * Render the friction comment body. Exported for the fixture test.
 *
 * @param {{ epicId:number, dead:Array, unknown:Array, live:Array }} report
 * @returns {string}
 */
export function renderFrictionBody(report) {
  const { epicId, dead, unknown, live } = report;
  const lines = [];
  lines.push(`### Host-crash reconcile report — Epic #${epicId}`);
  lines.push('');
  lines.push(
    'The watchdog inspected every Story still pinned at `agent::executing` ' +
      'or `agent::closing` and probed its recorded dispatch PID.',
  );
  lines.push('');
  lines.push(`**Dead (${dead.length})** — recorded PID is no longer running:`);
  if (dead.length === 0) {
    lines.push('- _none_');
  } else {
    for (const s of dead) lines.push(formatStoryLine(s));
  }
  lines.push('');
  lines.push(`**Unknown (${unknown.length})** — no PID was recorded:`);
  if (unknown.length === 0) {
    lines.push('- _none_');
  } else {
    for (const s of unknown) lines.push(formatStoryLine(s));
  }
  lines.push('');
  lines.push(`**Live (${live.length})** — recorded PID still running.`);
  lines.push('');
  lines.push(
    'Dead Stories should be transitioned back to `agent::ready` and ' +
      're-dispatched. Unknown Stories require operator inspection — the ' +
      'agent may have died before recording its PID.',
  );
  return lines.join('\n');
}

/**
 * Build the `temp/epic-<id>/recovery-plan.json` envelope.
 *
 * @param {{ epicId:number, dead:Array }} report
 * @returns {{ epicId:number, generatedAt:string, recover: Array<{storyId:number,title?:string,reason:string,lastPid:number}> }}
 */
export function buildRecoveryPlan(report) {
  return {
    epicId: report.epicId,
    generatedAt: new Date().toISOString(),
    recover: report.dead.map((s) => ({
      storyId: s.id,
      title: s.title,
      reason: 'dispatch-pid-dead',
      lastPid: s.pid,
    })),
  };
}

function writeRecoveryPlan(repoRoot, plan) {
  const dir = path.join(repoRoot, 'temp', `epic-${plan.epicId}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'recovery-plan.json');
  fs.writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return target;
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      'auto-recover': { type: 'boolean' },
      provider: { type: 'string' },
      'repo-root': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

/**
 * Core implementation. Exported so tests can drive a fake provider and a
 * fake `probePid` without spawning a subprocess.
 *
 * @param {object} params
 * @param {number} params.epicId
 * @param {object} params.provider
 * @param {string} params.repoRoot
 * @param {boolean} [params.autoRecover]
 * @param {(pid:number)=>boolean} [params.probePid]
 * @param {(ticketId:number, type:string, body:string)=>Promise<unknown>} [params.postComment]
 *        Override for tests. Default: upsert friction comment via provider.
 */
export async function runReconcile({
  epicId,
  provider,
  repoRoot,
  autoRecover = false,
  probePid,
  postComment,
}) {
  const report = await reconcileEpicAgentLabels({
    epicId,
    provider,
    repoRoot,
    probePid,
  });
  const body = renderFrictionBody(report);

  if (postComment) {
    await postComment(epicId, 'friction', body);
  } else {
    await upsertStructuredComment(provider, epicId, 'friction', body);
  }

  let recoveryPlanPath = null;
  if (autoRecover) {
    const plan = buildRecoveryPlan(report);
    recoveryPlanPath = writeRecoveryPlan(repoRoot, plan);
  }

  return {
    epicId,
    live: report.live,
    dead: report.dead,
    unknown: report.unknown,
    frictionBody: body,
    recoveryPlanPath,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const epicId = Number.parseInt(values.epic ?? '', 10);
  if (!Number.isFinite(epicId) || epicId <= 0) {
    process.stderr.write('[epic-deliver-reconcile] --epic <id> is required.\n');
    process.stderr.write(HELP);
    process.exit(2);
  }

  const config = resolveConfig();
  const effectiveConfig = values.provider
    ? { ...config, provider: values.provider }
    : config;
  const provider = createProvider(effectiveConfig);

  const repoRoot = values['repo-root'] ?? process.cwd();
  const envelope = await runReconcile({
    epicId,
    provider,
    repoRoot,
    autoRecover: Boolean(values['auto-recover']),
  });

  // Don't dump the full friction body to stdout — it's already on the Epic.
  // The JSON envelope is what the host LLM parses.
  const summary = {
    epicId: envelope.epicId,
    live: envelope.live.map((s) => s.id),
    dead: envelope.dead.map((s) => s.id),
    unknown: envelope.unknown.map((s) => s.id),
    recoveryPlanPath: envelope.recoveryPlanPath,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-reconcile' });
