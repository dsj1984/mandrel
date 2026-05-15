#!/usr/bin/env node

/**
 * delete-epic-branches.js — Local + remote branch cleanup for an Epic hierarchy.
 *
 * Encapsulates the deletion pattern that `/delete-epic-branches` previously
 * encoded as hand-authored PowerShell loops in the workflow markdown. The .md
 * is now a thin wrapper around this script — the script is the single source
 * of truth for which refs get deleted.
 *
 * Enumerates every local and remote ref matching:
 *   epic/<epicId>
 *   task/epic-<epicId>/*
 *   feature/epic-<epicId>/*
 *   story/epic-<epicId>/*
 *
 * Usage:
 *   node .agents/scripts/delete-epic-branches.js --epic <id> [--dry-run] [--json]
 *
 * Exit codes:
 *   0 — all targeted refs deleted (or nothing matched).
 *   1 — one or more deletions failed (see stderr / JSON payload).
 *   2 — usage / config error.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT } from './lib/config-resolver.js';
import {
  deleteBranchLocal,
  deleteBranchRemote,
} from './lib/git-branch-cleanup.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';

function branchPatterns(epicId) {
  return [
    `epic/${epicId}`,
    `task/epic-${epicId}/*`,
    `feature/epic-${epicId}/*`,
    `story/epic-${epicId}/*`,
  ];
}

function listLocalBranches(epicId, cwd = PROJECT_ROOT) {
  const res = gitSpawn(
    cwd,
    'branch',
    '--list',
    '--format=%(refname:short)',
    ...branchPatterns(epicId),
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function listRemoteBranches(epicId, cwd = PROJECT_ROOT) {
  const remotePatterns = branchPatterns(epicId).map((p) => `origin/${p}`);
  const res = gitSpawn(
    cwd,
    'branch',
    '-r',
    '--list',
    '--format=%(refname:short)',
    ...remotePatterns,
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^origin\//, ''));
}

function deleteLocalBranch(branch, cwd = PROJECT_ROOT) {
  const r = deleteBranchLocal(branch, { cwd, force: true });
  return {
    branch,
    deleted: r.deleted,
    reason: r.reason,
    // Legacy fields preserved for `executeDeletion` / `renderDeletionLine`
    // / existing tests; mirrors the lib's `deleted` / `reason === 'not-found'`.
    ok: r.deleted,
    alreadyGone: r.reason === 'not-found',
    stderr: r.stderr?.trim(),
  };
}

function deleteRemoteBranch(branch, cwd = PROJECT_ROOT) {
  const r = deleteBranchRemote(branch, { cwd });
  return {
    branch,
    deleted: r.deleted,
    reason: r.reason,
    // Legacy fields preserved for `executeDeletion` / `renderDeletionLine`
    // / existing tests; mirrors the lib's `deleted` / `reason === 'not-found'`.
    ok: r.deleted,
    alreadyGone: r.reason === 'not-found',
    stderr: r.stderr?.trim(),
  };
}

/**
 * Compute the deletion plan without touching git. Pure function — the CLI
 * entry point wraps this with `gitSpawn`-backed listers and deleters.
 *
 * @param {{
 *   epicId: number,
 *   localLister?: (epicId: number) => string[],
 *   remoteLister?: (epicId: number) => string[],
 * }} opts
 */
export function planDeletion({
  epicId,
  localLister = listLocalBranches,
  remoteLister = listRemoteBranches,
}) {
  const local = localLister(epicId);
  const remote = remoteLister(epicId);
  return { epicId, local, remote };
}

/**
 * Execute the deletion plan. Returns a result summary. Does not throw on
 * individual failures — aggregates them into `failures[]` and returns
 * `ok: false`.
 */
export function executeDeletion({
  plan,
  deleteLocal = deleteLocalBranch,
  deleteRemote = deleteRemoteBranch,
}) {
  const localResults = plan.local.map((b) => deleteLocal(b));
  const remoteResults = plan.remote.map((b) => deleteRemote(b));
  const failures = [
    ...localResults.filter((r) => !r.ok).map((r) => ({ ...r, scope: 'local' })),
    ...remoteResults
      .filter((r) => !r.ok)
      .map((r) => ({ ...r, scope: 'remote' })),
  ];
  return {
    epicId: plan.epicId,
    local: localResults,
    remote: remoteResults,
    failures,
    ok: failures.length === 0,
  };
}

/**
 * Pure: parse argv into the normalized CLI option bag. Exported for tests.
 *
 * @param {string[]} argv
 * @returns {{ epicId: number|null, dryRun: boolean, json: boolean }}
 */
export function parseDeleteArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: false,
  });
  const parsed = Number.parseInt(values.epic ?? '', 10);
  return {
    epicId: Number.isNaN(parsed) || parsed <= 0 ? null : parsed,
    dryRun: values['dry-run'] === true,
    json: values.json === true,
  };
}

/** Pure: render the dry-run plan as the operator-facing text block. */
export function renderDryRun(plan) {
  return [
    `[delete-epic-branches] Epic #${plan.epicId} — DRY RUN (nothing deleted)`,
    `  Local   (${plan.local.length}): ${plan.local.join(', ') || '(none)'}`,
    `  Remote  (${plan.remote.length}): ${plan.remote.join(', ') || '(none)'}`,
  ];
}

/**
 * Pure: render a per-branch line for the executed-deletion log.
 *
 * @param {{branch: string, ok: boolean, alreadyGone?: boolean}} result
 * @param {'local'|'remote'} scope
 */
export function renderDeletionLine(result, scope) {
  const icon = result.ok ? '✅' : '❌';
  if (scope === 'local') {
    return `[delete-epic-branches] ${icon} local  ${result.branch}`;
  }
  const note = result.alreadyGone ? ' (already gone)' : '';
  return `[delete-epic-branches] ${icon} remote ${result.branch}${note}`;
}

/** Pure: render the trailing summary line for an executed deletion result. */
export function renderExecutionSummary(epicId, result) {
  if (!result.ok) {
    return `[delete-epic-branches] ❌ ${result.failures.length} deletion(s) failed.`;
  }
  return `[delete-epic-branches] ✅ Epic #${epicId} — ${result.local.length} local + ${result.remote.length} remote branch(es) deleted.`;
}

function emitJson(payload, fail) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (fail) process.exit(1);
}

function emitDryRunHuman(plan) {
  for (const line of renderDryRun(plan)) Logger.info(line);
}

function emitExecutionHuman(epicId, result) {
  for (const r of result.local) Logger.info(renderDeletionLine(r, 'local'));
  for (const r of result.remote) Logger.info(renderDeletionLine(r, 'remote'));
  const summary = renderExecutionSummary(epicId, result);
  if (result.ok) {
    Logger.info(summary);
    return;
  }
  Logger.error(summary);
  process.exit(1);
}

/**
 * Pure stage: convert parsed args into the next step's intent. Returns a
 * tagged plan with one of three shapes — `{ kind: 'usage' }`,
 * `{ kind: 'dry-run', plan }`, or `{ kind: 'execute', plan }`. The CLI
 * `main` wrapper handles each shape with a flat dispatch, keeping its
 * cyclomatic complexity (and CRAP) below the 20 ceiling.
 */
export function planMainAction({ epicId, dryRun }) {
  if (epicId === null) return { kind: 'usage' };
  const plan = planDeletion({ epicId });
  if (dryRun) return { kind: 'dry-run', plan };
  return { kind: 'execute', plan };
}

/* node:coverage ignore next 4 */
function runDryRun(plan, { json, emit }) {
  if (json) emit.json({ ...plan, dryRun: true }, false);
  else emit.human(plan);
}

/* node:coverage ignore next 5 */
function runExecute(epicId, plan, { json, emit }) {
  const result = executeDeletion({ plan });
  if (json) emit.json(result, !result.ok);
  else emit.human(epicId, result);
}

/* node:coverage ignore next */
async function main() {
  const { epicId, dryRun, json } = parseDeleteArgs(process.argv.slice(2));
  const action = planMainAction({ epicId, dryRun });
  if (action.kind === 'usage') {
    throw new Error(
      'Usage: node delete-epic-branches.js --epic <id> [--dry-run] [--json]',
    );
  }
  if (action.kind === 'dry-run') {
    runDryRun(action.plan, {
      json,
      emit: { json: emitJson, human: emitDryRunHuman },
    });
    return;
  }
  runExecute(epicId, action.plan, {
    json,
    emit: { json: emitJson, human: emitExecutionHuman },
  });
}

runAsCli(import.meta.url, main, { source: 'delete-epic-branches' });
