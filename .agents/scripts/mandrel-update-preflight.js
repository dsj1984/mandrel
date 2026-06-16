#!/usr/bin/env node

/**
 * mandrel-update-preflight.js — Story #4170
 * (feat(mandrel-update): add a first-run preflight before the updater)
 *
 * A first-run preflight for the `/mandrel-update` workflow. The workflow
 * otherwise jumps straight to `npx mandrel update` with no guard rails;
 * this preflight catches three day-0 failure modes *before* the version
 * bump:
 *
 *   1. **Wrong project (hard stop).** Running the updater in the framework
 *      repo itself or in a non-consumer (no `mandrel` dependency in
 *      `package.json`, or no materialized `.agents/` directory) silently
 *      does the wrong thing. The consumer-shape check is a BLOCKER: it
 *      exits non-zero so the workflow halts before bumping anything.
 *   2. **Dirty git index (warn).** `mandrel update` deliberately leaves the
 *      lockfile *staged* (see `lib/cli/update.js`); the workflow's commit
 *      step then `git add`s and commits. If the index already holds
 *      unrelated staged changes, that step would sweep them into the
 *      `chore: update mandrel` commit. Warn so the operator can unstage
 *      first.
 *   3. **Offline (warn).** The CLI throws a usable error on a failed
 *      `npm view`, but a one-line up-front reachability check gives a
 *      friendlier "you're offline" signal before any version probe.
 *
 * Severity is consistent with framework preflight conventions
 * (cf. `story-close.js` runStoryClosePreflight, `epic-deliver-preflight.js`):
 * the consumer-shape check is a hard stop (blocker), dirty-index and offline
 * are warn-only and never block the run.
 *
 * Out of scope (per the Story): folding these checks into
 * `lib/cli/update.js` itself — the CLI stays git-free and
 * side-effect-scoped; this is a workflow-layer concern.
 *
 * The detection logic is a pure function (`runMandrelUpdatePreflight`) that
 * takes injectable probes so it is unit-testable without touching the real
 * filesystem, git index, or network. The CLI wrapper wires the real probes
 * and maps a blocker finding to a non-zero exit code.
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
 * Real-world probes. Each is overridable in tests via the `probes` option.
 *
 * @param {string} projectRoot Absolute consumer repo root.
 */
export function makeProbes(projectRoot) {
  return {
    /**
     * Read + parse `package.json`. Returns the parsed object, or `null`
     * when the file is missing or unparseable.
     */
    readPackageJson() {
      const pkgPath = path.join(projectRoot, 'package.json');
      if (!existsSync(pkgPath)) return null;
      try {
        return JSON.parse(readFileSync(pkgPath, 'utf8'));
      } catch {
        return null;
      }
    },
    /** Does the materialized `.agents/` directory exist? */
    agentsDirExists() {
      return existsSync(path.join(projectRoot, '.agents'));
    },
    /**
     * Are there staged (index) changes? Returns true when
     * `git diff --cached --name-only` is non-empty. Returns false on any
     * git error (not a repo, git missing) — a missing index is not a
     * dirty index.
     */
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
    /**
     * Is the npm registry reachable? Probes `npm ping` (a PM-agnostic
     * reachability query that does not mutate anything). Returns true when
     * the ping succeeds, false on any failure (offline / registry down).
     */
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
 * Pure preflight evaluator. Runs the three checks against the supplied
 * probes and returns a structured result. Never throws; never performs
 * I/O directly (all I/O is behind `probes`).
 *
 * @param {object} options
 * @param {ReturnType<typeof makeProbes>} options.probes
 * @returns {{ ok: boolean, blocked: boolean, findings: PreflightFinding[] }}
 *   `blocked` is true when any blocker-severity finding fired (the
 *   consumer-shape hard stop). `ok` is true when there are no findings of
 *   any severity.
 */
export function runMandrelUpdatePreflight({ probes }) {
  /** @type {PreflightFinding[]} */
  const findings = [];

  // 1. Consumer-shape check — BLOCKER (hard stop).
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

  // 2. Dirty-index check — WARN only.
  if (probes.hasStagedChanges()) {
    findings.push({
      id: 'dirty-index',
      severity: 'warning',
      summary:
        "The git index already has staged changes. `mandrel update` leaves the lockfile staged, and the workflow's commit step (Step 5) would sweep these unrelated staged files into the `chore: update mandrel` commit.",
      fix: 'Unstage unrelated changes first: `git restore --staged <path>` (or `git reset` to clear the whole index), then re-run the preflight.',
    });
  }

  // 3. Offline check — WARN only.
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
 * Render the findings to a logger. Blockers go to `error`, warnings to
 * `warn`. A clean result logs a single `info` line.
 *
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
  // Machine-parsable JSON envelope on stdout for tooling / the workflow to
  // read. Use process.stdout.write (not console.log) per the no-console
  // enforcement boundary: human-facing output goes through Logger above.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.blocked ? 2 : 0;
}

runAsCli(import.meta.url, main, {
  source: 'mandrel-update-preflight',
  propagateExitCode: true,
});
