#!/usr/bin/env node
/* node:coverage ignore file -- top-level CLI gate; spawns lint/format/test and asserts exit codes — heavy mocking would assert only mock structure */

/**
 * git-pr-quality-gate.js — Lint / test / baselines gate for `/git-merge-pr`.
 *
 * `/git-merge-pr` Steps 3–4 previously hardcoded the command sequence
 * (`npm run lint`, `npm run format:check`, `npm test`) in the workflow
 * markdown. That coupled the .md to specific tooling names; a project that
 * renames `lint` to `lint:ci` or swaps Biome for ESLint had to patch the
 * skill every time.
 *
 * This script runs the gate and emits a structured result so the .md routes
 * on outcome rather than re-implementing the command sequence. The checks it
 * runs are read from
 * `.agentrc.json → github.branchProtection.requiredChecks` when present,
 * falling back to the hardcoded default trio, which mirrors the live required
 * check set (`lint`, `test`, `baselines` — Story #4356, Epic #4355; the stale
 * `lifecycle-doc-drift` check was pruned in the same slice).
 *
 * Usage:
 *   node .agents/scripts/git-pr-quality-gate.js [--json] [--skip <name>[,<name>]]
 *
 * `--skip` takes a comma-separated list of check names to bypass (useful when
 * a flake needs a targeted rerun).
 *
 * Output (always JSON when --json; human-readable otherwise):
 *   {
 *     ok: boolean,
 *     checks: [{ name, cmd, status, stdout, stderr, durationMs }, ...],
 *     failed: [{ name, reason }, ...]
 *   }
 *
 * Exit codes:
 *   0 — every check passed.
 *   1 — one or more checks failed (see `failed[]`).
 *   2 — usage / config error.
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

/**
 * Default check suite when `.agentrc.json` supplies no override. Each entry:
 *   name — short identifier surfaced in output
 *   cmd  — argv array (no shell expansion; first element is the binary)
 */
export const DEFAULT_CHECKS = Object.freeze([
  { name: 'lint', cmd: ['npm', 'run', 'lint'] },
  { name: 'test', cmd: ['npm', 'test'] },
  { name: 'baselines', cmd: ['node', '.agents/scripts/check-baselines.js'] },
]);

function resolveChecks(config) {
  // Canonical: required checks live under `github.branchProtection.requiredChecks`.
  const configured = config?.github?.branchProtection?.requiredChecks;
  if (!Array.isArray(configured) || configured.length === 0) {
    return DEFAULT_CHECKS;
  }
  return configured.map((c) => ({ name: c.name, cmd: c.cmd }));
}

function runCheck(check, cwd) {
  const start = Date.now();
  const [bin, ...args] = check.cmd;
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 600_000,
  });
  const durationMs = Date.now() - start;
  return {
    name: check.name,
    cmd: check.cmd.join(' '),
    status: result.status ?? -1,
    stdout: (result.stdout ?? '').slice(-4000),
    stderr: (result.stderr ?? '').slice(-4000),
    durationMs,
  };
}

/**
 * Pure test seam: run the supplied check suite with a caller-provided runner.
 *
 * @param {{
 *   checks: Array<{ name: string, cmd: string[] }>,
 *   cwd?: string,
 *   skip?: Set<string>|string[],
 *   runner?: (check: {name: string, cmd: string[]}, cwd: string) => { name, cmd, status, stdout, stderr, durationMs },
 * }} opts
 */
export function runQualityGate({
  checks,
  cwd = PROJECT_ROOT,
  skip,
  runner = runCheck,
}) {
  const skipSet =
    skip instanceof Set ? skip : new Set((skip ?? []).filter(Boolean));
  const results = [];
  for (const c of checks) {
    if (skipSet.has(c.name)) {
      results.push({
        name: c.name,
        cmd: c.cmd.join(' '),
        status: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        skipped: true,
      });
      continue;
    }
    results.push(runner(c, cwd));
  }
  const failed = results
    .filter((r) => !r.skipped && r.status !== 0)
    .map((r) => ({
      name: r.name,
      reason: `exit ${r.status} — ${(r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' | ')}`,
    }));
  return { ok: failed.length === 0, checks: results, failed };
}

/**
 * Pure: format the per-check status line shown in the human report.
 *
 * @param {{ name: string, status: number, durationMs: number, skipped?: boolean }} check
 */
export function formatCheckLine(check) {
  const icon = check.skipped ? '⏭' : check.status === 0 ? '✅' : '❌';
  const suffix = check.skipped ? ' (skipped)' : ` (${check.durationMs}ms)`;
  return `[quality-gate] ${icon} ${check.name}${suffix}`;
}

/**
 * Pure: render the human report for a quality-gate verdict, returning info
 * lines (always emitted) and error lines (emitted on failure).
 *
 * @param {{ ok: boolean, checks: Array<object>, failed: Array<{ name: string, reason: string }> }} result
 */
export function renderHumanReport(result) {
  const info = result.checks.map(formatCheckLine);
  const errors = [];
  if (!result.ok) {
    errors.push(
      `[quality-gate] ❌ ${result.failed.length} check(s) failed:`,
      ...result.failed.map((f) => `  - ${f.name}: ${f.reason}`),
    );
  } else {
    info.push(`[quality-gate] ✅ All ${result.checks.length} check(s) passed.`);
  }
  return { info, errors };
}

/**
 * Pure: split a comma-separated `--skip` value into a clean list of check
 * names.
 *
 * @param {string|null|undefined} value
 */
export function parseSkipList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      skip: { type: 'string' },
    },
    strict: false,
  });
  const config = resolveConfig();
  const checks = resolveChecks(config);
  const skip = parseSkipList(values.skip);

  const result = runQualityGate({ checks, skip });

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exit(1);
    return;
  }

  const { info, errors } = renderHumanReport(result);
  for (const line of info) Logger.info(line);
  for (const line of errors) Logger.error(line);
  if (!result.ok) process.exit(1);
}

// Re-export Logger so callers that dynamic-import this module can surface
// fatal errors through the same channel as other scripts.
export { Logger };

runAsCli(import.meta.url, main, { source: 'git-pr-quality-gate' });
