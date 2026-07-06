#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * Local full verification — a true CI mirror for the gates that CAN be proven
 * locally, without epic-scoped MI projection or push semantics.
 *
 * Order: audit (SCA) → lint (includes docs:check) → full test suite →
 * unified baselines.
 *
 * The `audit` step runs `npm audit --audit-level=high`, matching CI's
 * "Dependency Vulnerability Audit (SCA)" gate so a local green no longer hides
 * a high-severity advisory that CI would fail on. It is independent of the
 * pre-push `PREPUSH_AUDIT` opt-in, which stays unchanged.
 *
 * A handful of CI gates cannot be reproduced by this command (action pinning,
 * TruffleHog secret scan, the BASELINE_SCOPE=full push-scoped maintainability
 * run) — those are catalogued in docs/ci-contract.md.
 */

import { spawnSync } from 'node:child_process';
import { runAsCli } from './lib/cli-utils.js';

const STEPS = [
  {
    label: 'audit',
    cmd: 'npm',
    args: ['audit', '--audit-level=high'],
  },
  { label: 'lint', cmd: 'npm', args: ['run', 'lint'] },
  { label: 'test', cmd: 'npm', args: ['test'] },
  {
    label: 'baselines',
    cmd: 'node',
    args: ['.agents/scripts/check-baselines.js'],
  },
];

export function runVerifySteps({
  spawn = spawnSync,
  shell = process.platform === 'win32',
} = {}) {
  for (const step of STEPS) {
    const result = spawn(step.cmd, step.args, {
      stdio: 'inherit',
      shell,
    });
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      return {
        ok: false,
        failedStep: step.label,
        exitCode: result.status ?? 1,
      };
    }
  }
  return { ok: true };
}

runAsCli(
  import.meta.url,
  async () => {
    const outcome = runVerifySteps();
    if (!outcome.ok) {
      process.exit(outcome.exitCode);
    }
  },
  { source: 'run-verify' },
);
