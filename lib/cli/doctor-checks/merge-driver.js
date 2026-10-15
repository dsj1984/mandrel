// lib/cli/doctor-checks/merge-driver.js — Doctor check: merge-driver.

import fs from 'node:fs';
import {
  BASELINE_MERGE_DRIVER_CONFIG_KEY,
  BASELINE_MERGE_DRIVER_REMEDY,
  parseBaselineMergeDriverCommand,
  probeBaselineMergeDriver,
} from '../../../.agents/scripts/lib/bootstrap/baseline-merge-driver.js';
import { spawn } from './spawn.js';

// check: merge-driver

/**
 * Is this clone's `baselines/*.json` merge driver registered? `.gitattributes`
 * ships with the repo but the driver command is per-clone `git config`, and a
 * missing one silently falls back to a text merge. Skipped when
 * `.gitattributes` does not declare the driver.
 *
 * @param {{cwd?: () => string, fsImpl?: typeof fs, runner?: typeof spawn}} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runMergeDriver({ cwd, fsImpl = fs, runner = spawn } = {}) {
  const projectRoot = (cwd ?? (() => process.cwd()))();
  // Git runs from projectRoot: the config key is per-clone.
  const { declared, command } = probeBaselineMergeDriver({
    projectRoot,
    fsImpl,
    runGit: (args) => runner('git', args, { cwd: projectRoot }),
  });
  if (!declared) {
    return {
      ok: true,
      detail:
        'skipped — .gitattributes does not route baselines/*.json through the mandrel merge driver',
    };
  }
  if (command === '') {
    return {
      ok: false,
      detail: `${BASELINE_MERGE_DRIVER_CONFIG_KEY} is unset — baselines/*.json will fall back to git's text merge, which conflicts on adjacent rows and can splice rows neither branch scored`,
      remedy: BASELINE_MERGE_DRIVER_REMEDY,
    };
  }
  return probeConfiguredDriver(command, runner, projectRoot);
}

/**
 * Execute the configured driver with `--help` (the real invocation mutates
 * `%A`): a set-but-broken command — typically an absolute node path moved by
 * an nvm/volta bump — fails as silently as an unset key. The command is
 * tokenised, never shell-run, since a config value must not become arbitrary
 * command execution. Runs from projectRoot, where git invokes drivers.
 *
 * @param {string} command
 * @param {typeof spawn} runner
 * @param {string} projectRoot
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function probeConfiguredDriver(command, runner, projectRoot) {
  const parsed = parseBaselineMergeDriverCommand(command);
  if (!parsed) {
    return {
      ok: false,
      detail: `${BASELINE_MERGE_DRIVER_CONFIG_KEY} is set to ${JSON.stringify(command)}, which has no runnable command in it`,
      remedy: BASELINE_MERGE_DRIVER_REMEDY,
    };
  }
  const probe = runner(parsed.file, [...parsed.args, '--help'], {
    cwd: projectRoot,
  });
  if (probe.status === 0) return { ok: true, detail: command };
  const why = probe.error?.message ?? `exit ${probe.status}`;
  return {
    ok: false,
    detail: `${BASELINE_MERGE_DRIVER_CONFIG_KEY} is set to ${JSON.stringify(command)} but running it failed (${why}) — git would fall back to text-merging baselines/*.json exactly as if the key were unset`,
    remedy: BASELINE_MERGE_DRIVER_REMEDY,
  };
}
