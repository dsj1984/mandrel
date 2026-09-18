#!/usr/bin/env node

/**
 * mandrel-update-preflight.js — first-run guard for `/mandrel-update`, run
 * before the version bump. Hard-stops outside a consumer repo (no `mandrel`
 * dependency or no `.agents/`). Warns on a dirty index (the update leaves the
 * lockfile staged, so the commit step would sweep unrelated staged files in)
 * and when the registry is unreachable. Kept out of `lib/cli/update.js`, which
 * stays git-free.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

/**
 * @typedef {object} PreflightFinding
 * @property {string} id        Stable check id.
 * @property {'blocker'|'warning'} severity
 * @property {string} summary   One-line human-readable description.
 * @property {string} [fix]     Copy-pasteable remediation hint.
 */

/**
 * @param {string} projectRoot
 */
export function makeProbes(projectRoot) {
  return {
    /** `null` when missing or unparseable. */
    readPackageJson() {
      const pkgPath = path.join(projectRoot, 'package.json');
      if (!existsSync(pkgPath)) return null;
      try {
        return JSON.parse(readFileSync(pkgPath, 'utf8'));
      } catch {
        return null;
      }
    },
    agentsDirExists() {
      return existsSync(path.join(projectRoot, '.agents'));
    },
    /** False on any git error: a missing index is not a dirty one. */
    hasStagedChanges() {
      try {
        const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim().length > 0;
      } catch {
        return false;
      }
    },
    registryReachable() {
      try {
        execFileSync('npm', ['ping'], {
          cwd: projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 10_000,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Pure: all I/O is behind `probes`. `ok` means no findings at all.
 *
 * @param {object} options
 * @param {ReturnType<typeof makeProbes>} options.probes
 * @returns {{ ok: boolean, blocked: boolean, findings: PreflightFinding[] }}
 */
export function runMandrelUpdatePreflight({ probes }) {
  /** @type {PreflightFinding[]} */
  const findings = [];

  const pkg = probes.readPackageJson();
  const deps = pkg
    ? {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
        ...(pkg.optionalDependencies ?? {}),
      }
    : {};
  const hasMandrelDep = Object.hasOwn(deps, 'mandrel');
  const hasAgentsDir = probes.agentsDirExists();

  if (!pkg || !hasMandrelDep || !hasAgentsDir) {
    const missing = [];
    if (!pkg) missing.push('no readable package.json');
    else if (!hasMandrelDep)
      missing.push('package.json does not list "mandrel" as a dependency');
    if (!hasAgentsDir) missing.push('no .agents/ directory');
    findings.push({
      id: 'consumer-shape',
      severity: 'blocker',
      summary: `Not a Mandrel consumer project (${missing.join('; ')}). Run /mandrel-update from a consumer repo that depends on "mandrel" and has a materialized .agents/ tree — not the framework repo itself or an unrelated project.`,
      fix: 'cd into the consumer project root, or run `npm install -D mandrel && npx mandrel sync` to bootstrap one.',
    });
  }

  if (probes.hasStagedChanges()) {
    findings.push({
      id: 'dirty-index',
      severity: 'warning',
      summary:
        "The git index already has staged changes. `mandrel update` leaves the lockfile staged, and the workflow's commit step (Step 5) would sweep these unrelated staged files into the `chore: update mandrel` commit.",
      fix: 'Unstage unrelated changes first: `git restore --staged <path>` (or `git reset` to clear the whole index), then re-run the preflight.',
    });
  }

  if (!probes.registryReachable()) {
    findings.push({
      id: 'offline',
      severity: 'warning',
      summary:
        'The npm registry is not reachable. `npx mandrel update` resolves the newest published version via the registry and will fail its version probe while offline.',
      fix: 'Check your network connection (or registry auth/proxy config) before running `npx mandrel update`.',
    });
  }

  const blocked = findings.some((f) => f.severity === 'blocker');
  return { ok: findings.length === 0, blocked, findings };
}

/**
 * @param {{ ok: boolean, blocked: boolean, findings: PreflightFinding[] }} result
 * @param {{ info: Function, warn: Function, error: Function }} logger
 */
export function reportPreflight(result, logger) {
  if (result.ok) {
    logger.info(
      '✅ [mandrel-update-preflight] All checks passed — safe to run `npx mandrel update`.',
    );
    return;
  }
  for (const f of result.findings) {
    const line = `[${f.id}] ${f.summary}${f.fix ? `\n  ↳ Fix: ${f.fix}` : ''}`;
    if (f.severity === 'blocker') {
      logger.error(`❌ ${line}`);
    } else {
      logger.warn(`⚠️  ${line}`);
    }
  }
  if (result.blocked) {
    logger.error(
      '[mandrel-update-preflight] Hard stop: do not run `npx mandrel update` until the blocker above is resolved (exit 2).',
    );
  } else {
    logger.warn(
      '[mandrel-update-preflight] Warnings only — review them, then proceed if intentional.',
    );
  }
}

async function main() {
  const projectRoot = process.cwd();
  const probes = makeProbes(projectRoot);
  const result = runMandrelUpdatePreflight({ probes });
  reportPreflight(result, Logger);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.blocked ? 2 : 0;
}

runAsCli(import.meta.url, main, {
  source: 'mandrel-update-preflight',
  propagateExitCode: true,
  usage: {
    invocation: 'node .agents/scripts/mandrel-update-preflight.js',
    summary:
      'First-run guard for /mandrel-update: hard-stops on a non-consumer repo, warns on a dirty git index and on being offline.',
    flags: [],
    notes: [
      'Exit codes:\n  0  safe to update (warnings may be present)\n  1  blocker — do not update',
    ],
  },
});
