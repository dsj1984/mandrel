#!/usr/bin/env node

/**
 * check-windows-git-perf.js — Verify host-level git perf settings on Windows.
 *
 * The framework drives many git operations per Story (worktree create / fetch /
 * status / branch deletes). On Windows, three settings shave seconds off every
 * `git status`-shaped call across the lifecycle:
 *
 *   - `core.fsmonitor true` (global) — built-in FS monitor daemon.
 *   - `feature.manyFiles true` (global) — commit-graph, untracked cache,
 *     sparse index defaults.
 *   - `git maintenance start` (per repo) — schedules background prefetch /
 *     commit-graph rebuilds / loose-object cleanup / incremental repack.
 *
 * This script is **warn-only and idempotent**. It probes the settings, prints
 * the exact commands to run for any that are missing, and always exits 0.
 * It is a no-op on non-Windows hosts (those settings are not meaningfully
 * faster on macOS/Linux and `--global` mutation of someone's git config is
 * out of scope for an automated check).
 *
 * Stdlib only — no new dependencies.
 */

// cli-opt-out: stdlib-only top-level script with no error path; runAsCli would force a Logger import that violates the "no new dependencies" contract documented above.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TAG = '[check-windows-git-perf]';

if (process.platform !== 'win32') {
  process.exit(0);
}

function gitOutput(args, { cwd } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function gitMultiOutput(args, { cwd } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const recommendations = [];

const fsmonitor = gitOutput(['config', '--global', 'core.fsmonitor']);
if (fsmonitor !== 'true') {
  recommendations.push({
    setting: 'core.fsmonitor',
    current: fsmonitor ?? '(unset)',
    command: 'git config --global core.fsmonitor true',
    why: 'enables the FS-monitor daemon so `git status` skips full lstat walks',
  });
}

const manyFiles = gitOutput(['config', '--global', 'feature.manyFiles']);
if (manyFiles !== 'true') {
  recommendations.push({
    setting: 'feature.manyFiles',
    current: manyFiles ?? '(unset)',
    command: 'git config --global feature.manyFiles true',
    why: 'opts into commit-graph, untracked cache, and sparse-index defaults',
  });
}

const consumerRoot = process.cwd();
const repoTopLevel = gitOutput(['rev-parse', '--show-toplevel'], {
  cwd: consumerRoot,
});

if (repoTopLevel) {
  const registered = gitMultiOutput([
    'config',
    '--global',
    '--get-all',
    'maintenance.repo',
  ]);
  const normalized = path.resolve(repoTopLevel).toLowerCase();
  const isRegistered = registered
    .map((entry) => path.resolve(entry).toLowerCase())
    .some((entry) => entry === normalized);

  if (!isRegistered) {
    recommendations.push({
      setting: 'maintenance.repo (per-repo schedule)',
      current: '(this repo is not registered)',
      command: 'git maintenance start',
      why: 'schedules background prefetch, commit-graph, and incremental repack for this clone',
      runFromRepo: true,
    });
  }
}

if (recommendations.length === 0) {
  console.log(`${TAG} OK — Windows git perf settings are configured.`);
  process.exit(0);
}

console.log(
  `${TAG} Detected ${recommendations.length} missing setting(s) that materially speed up git operations on Windows.`,
);
console.log(
  `${TAG} These are warnings only; the framework keeps working without them.`,
);
console.log('');

for (const rec of recommendations) {
  console.log(`  • ${rec.setting} — ${rec.why}`);
  console.log(`      current: ${rec.current}`);
  console.log(
    `      apply:   ${rec.command}${rec.runFromRepo ? '   (run from the consumer repo root)' : ''}`,
  );
  console.log('');
}

console.log(
  `${TAG} Re-run this script after applying to confirm. It exits 0 either way.`,
);

process.exit(0);
