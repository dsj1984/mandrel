#!/usr/bin/env node

/**
 * update-self.js — Bump the `.agents` submodule to its remote HEAD
 *
 * Run from a consumer repo (parent of `.agents/`). Moves the submodule
 * pointer forward on demand so teammates share a deterministic SHA in git,
 * and CI honours the committed pointer rather than drifting on every
 * install.
 *
 * Steps:
 *   1. Refuse if `.agents/` has uncommitted changes.
 *   2. Capture OLD_SHA at `.agents/` HEAD.
 *   3. `git submodule update --init --force [--remote] .agents`
 *        `--remote` is skipped when CI=true.
 *        Retries up to 3 times with a 2s backoff.
 *   4. Capture NEW_SHA and print the SHA range + shortlog.
 *   5. Exec `node .agents/scripts/sync-claude-commands.js` so the
 *      consumer's `.claude/commands/` tracks the new workflows.
 *
 * Exit codes:
 *   0 — success (including a no-op when OLD === NEW).
 *   1 — dirty submodule, exhausted retries, or sync-claude-commands failure.
 *
 * Stdlib only; no new dependencies.
 */

// cli-opt-out: stdlib-only top-level script with bespoke fatal() helper; runAsCli would force a Logger import that violates the "no new dependencies" contract documented above.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from './lib/Logger.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 2000;
const SUBMODULE_PATH = '.agents';

function fatal(message) {
  Logger.error(`[update-self] ${message}`);
  process.exit(1);
}

function run(command, args, { cwd, inherit = false } = {}) {
  return spawnSync(command, args, {
    cwd,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function gitCapture(cwd, ...args) {
  const result = run('git', args, { cwd });
  if (result.error) {
    fatal(`git ${args.join(' ')} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fatal(
      `git ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

const consumerRoot = process.cwd();
const submoduleAbs = path.join(consumerRoot, SUBMODULE_PATH);

if (!fs.existsSync(submoduleAbs)) {
  fatal(
    `${SUBMODULE_PATH}/ not found at ${consumerRoot}. Run this script from the consumer repo root (the parent of .agents/).`,
  );
}

// Step 1 — refuse dirty submodule before touching anything.
const dirty = gitCapture(submoduleAbs, 'status', '--porcelain');
if (dirty) {
  Logger.error('[update-self] .agents/ has uncommitted changes:');
  Logger.error(dirty);
  Logger.error(
    '[update-self] Commit or discard changes inside .agents/ before re-running.',
  );
  process.exit(1);
}

// Step 2 — capture OLD_SHA before the pointer moves.
const oldSha = gitCapture(submoduleAbs, 'rev-parse', 'HEAD');

// Step 3 — run `git submodule update` with retries.
const isCI = process.env.CI === 'true';
const updateArgs = ['submodule', 'update', '--init', '--force'];
if (!isCI) updateArgs.push('--remote');
updateArgs.push(SUBMODULE_PATH);

if (isCI) {
  Logger.info(
    '[update-self] CI=true — skipping --remote; honouring committed SHA.',
  );
}

let updated = false;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const result = run('git', updateArgs, {
    cwd: consumerRoot,
    inherit: true,
  });
  if (result.status === 0) {
    updated = true;
    break;
  }
  Logger.error(
    `[update-self] Attempt ${attempt}/${MAX_ATTEMPTS} failed (exit code ${result.status})`,
  );
  if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS);
}

if (!updated) {
  fatal(
    `git ${updateArgs.join(' ')} failed after ${MAX_ATTEMPTS} attempts. Re-run when connectivity is restored.`,
  );
}

// Step 4 — report the diff.
const newSha = gitCapture(submoduleAbs, 'rev-parse', 'HEAD');
if (oldSha === newSha) {
  Logger.info(`[update-self] No changes — .agents/ already at ${newSha}.`);
} else {
  Logger.info(`[update-self] ${oldSha.slice(0, 12)}..${newSha.slice(0, 12)}`);
  const shortlog = gitCapture(
    submoduleAbs,
    'log',
    '--oneline',
    `${oldSha}..${newSha}`,
  );
  if (shortlog) {
    Logger.info('[update-self] New commits:');
    for (const line of shortlog.split('\n')) {
      Logger.info(`  ${line}`);
    }
  }
}

// Step 5 — regenerate .claude/commands/ via the authoritative writer.
const syncScript = path.join(
  submoduleAbs,
  'scripts',
  'sync-claude-commands.js',
);
if (!fs.existsSync(syncScript)) {
  fatal(
    `Expected ${syncScript} after submodule update but it is missing. Aborting.`,
  );
}

const syncResult = run('node', [syncScript], {
  cwd: consumerRoot,
  inherit: true,
});
if (syncResult.status !== 0) {
  fatal(
    `sync-claude-commands.js exited ${syncResult.status}. Fix the sync error and re-run.`,
  );
}

// Step 6 — warn-only check for host-level git perf settings (Windows only).
const perfCheckScript = path.join(
  submoduleAbs,
  'scripts',
  'check-windows-git-perf.js',
);
if (fs.existsSync(perfCheckScript)) {
  run('node', [perfCheckScript], { cwd: consumerRoot, inherit: true });
}

process.exit(0);
