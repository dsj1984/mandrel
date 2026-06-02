#!/usr/bin/env node
/**
 * create-mandrel — cold-start launcher for Mandrel (Story #3373, #3465).
 *
 * Zero-to-installed entry point for cold-start onboarding. The launcher's
 * single job is to install the distributed `@mandrel/agents` npm package
 * (when `.agents` is absent), materialize it into `./.agents/` via
 * `mandrel sync`, and then hand off to the in-tree bootstrap:
 *
 *   1. If `.agents` is absent →
 *        a. `npm install @mandrel/agents` against a HARDCODED canonical
 *           package name, then
 *        b. `npx mandrel sync` to copy `node_modules/@mandrel/agents/` →
 *           `./.agents/`.
 *   2. If `.agents` already exists → skip the install/sync and go straight
 *      to bootstrap.
 *   3. Always exec `node .agents/scripts/bootstrap.js`, forwarding every
 *      passthrough flag (e.g. `--assume-yes`, `--skip-github`, `--owner`,
 *      `--repo`) unchanged.
 *
 * SECURITY: the package name is a build-time constant. It is NEVER sourced
 * from operator input, an environment variable, or argv. Allowing an
 * operator-supplied package would let a cold-start command install arbitrary
 * code into `.agents/` and run it — the launcher exists precisely to make the
 * provenance of `.agents` non-negotiable.
 *
 * Usage:
 *   npx create-mandrel [bootstrap flags...]
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Canonical Mandrel npm package. HARDCODED on purpose — see the security
 * note in the module header. The package ships the `mandrel` CLI bin and the
 * `.agents/` payload as files (per AGENTS.md § Project Overview / Epic #3436).
 */
export const CANONICAL_PACKAGE = '@mandrel/agents';

/** Path `.agents/` is materialized to, relative to the project root. */
export const AGENTS_PATH = '.agents';

/**
 * Compute the ordered list of commands the launcher must run, given whether
 * `.agents` is already present. Pure function — no I/O — so the decision
 * logic is unit-testable in isolation.
 *
 * When `.agents` is absent the plan is:
 *   npm install @mandrel/agents
 *   npx mandrel sync
 *   node .agents/scripts/bootstrap.js [...passthrough]
 *
 * When `.agents` is present the install/sync steps are skipped and the plan
 * is just the bootstrap invocation.
 *
 * @param {object} opts
 * @param {boolean} opts.agentsPresent — whether `.agents` already exists.
 * @param {string[]} [opts.passthroughArgs] — flags to forward to bootstrap.
 * @returns {Array<{ cmd: string, args: string[] }>}
 */
export function planLaunch({ agentsPresent, passthroughArgs = [] }) {
  const steps = [];
  if (!agentsPresent) {
    steps.push({
      cmd: 'npm',
      args: ['install', CANONICAL_PACKAGE],
    });
    steps.push({
      cmd: 'npx',
      args: ['mandrel', 'sync'],
    });
  }
  steps.push({
    cmd: process.execPath,
    args: [
      path.join(AGENTS_PATH, 'scripts', 'bootstrap.js'),
      ...passthroughArgs,
    ],
  });
  return steps;
}

/**
 * Default synchronous command runner. Inherits stdio so the operator sees
 * npm / sync / bootstrap output live, and surfaces a non-zero exit by
 * throwing so the launcher halts the plan at the first failing step.
 *
 * `npm` and `npx` resolve to `.cmd` shims on Windows, which `spawnSync`
 * cannot exec without a shell. The command and args are build-time constants
 * (never operator-supplied), so enabling `shell` introduces no injection
 * surface.
 *
 * @param {{ cmd: string, args: string[] }} step
 * @param {string} cwd
 */
function defaultRunStep(step, cwd) {
  const result = spawnSync(step.cmd, step.args, {
    cwd,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) {
    throw new Error(
      `create-mandrel: failed to spawn \`${step.cmd}\`: ${result.error.message}`,
    );
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      `create-mandrel: command \`${step.cmd} ${step.args.join(' ')}\` exited with code ${result.status}`,
    );
  }
  if (result.signal) {
    throw new Error(
      `create-mandrel: command \`${step.cmd}\` terminated by signal ${result.signal}`,
    );
  }
}

/**
 * Run the launcher end to end. Dependencies are injected so the orchestration
 * (existence check → ordered step execution) is unit-testable without
 * touching npm, the network, or the real filesystem.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] — passthrough flags for bootstrap (default:
 *   process.argv.slice(2)).
 * @param {string} [opts.cwd] — project root (default: process.cwd()).
 * @param {(p: string) => boolean} [opts.exists] — `.agents` existence probe.
 * @param {(step: object, cwd: string) => void} [opts.runStep] — step runner.
 * @returns {{ agentsPresent: boolean, steps: Array<{ cmd: string, args: string[] }> }}
 */
export function runLauncher(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);
  const cwd = opts.cwd ?? process.cwd();
  const exists = opts.exists ?? existsSync;
  const runStep = opts.runStep ?? defaultRunStep;

  const agentsPresent = exists(path.join(cwd, AGENTS_PATH));
  const steps = planLaunch({ agentsPresent, passthroughArgs: argv });
  for (const step of steps) {
    runStep(step, cwd);
  }
  return { agentsPresent, steps };
}

// Only run when invoked directly (not when imported by the test suite).
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(import.meta.dirname, 'index.js');

if (invokedDirectly) {
  try {
    runLauncher();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
