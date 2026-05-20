#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * Local full verification — mirrors the intent of close-validation without
 * epic-scoped MI projection or push semantics.
 *
 * Order: lint (includes docs:check) → full test suite → unified baselines.
 */

import { spawnSync } from 'node:child_process';
import { runAsCli } from './lib/cli-utils.js';

const STEPS = [
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
