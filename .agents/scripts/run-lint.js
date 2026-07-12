#!/usr/bin/env node
// cli-opt-out: top-level-await driver with no main() function — runAsCli wraps an async main, which doesn't apply here.
/* node:coverage ignore file */

/**
 * Cross-platform parallel driver for `npm run lint`.
 *
 * Spawns `biome ci .` and `markdownlint-cli2` concurrently. They share
 * no state, so running them in series (the prior `&&` form) wasted
 * wall-clock time on every developer save and pre-push. Stdout/stderr
 * stream through unchanged so error context survives. Exit code is
 * non-zero if either tool fails.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

// On Windows, npm/npx shims are `.cmd` batch files. Since Node 20,
// these can only be spawned through a shell (CWE-78 mitigation closing
// CVE-2024-27980), so `shell: true` is mandatory there. POSIX hosts
// can spawn directly.
const useShell = process.platform === 'win32';

const tasks = [
  {
    name: 'biome',
    cmd: 'npx',
    args: ['biome', 'ci', '.'],
  },
  {
    name: 'markdownlint',
    cmd: 'npx',
    args: [
      'markdownlint-cli2',
      '.agents/**/*.md',
      '*.md',
      '!node_modules/**',
      '!.worktrees/**',
    ],
  },
  {
    // Custom Node-based lint for the lifecycle bus surface (Story #2227).
    // Enforces:
    //   1. No `Promise.all` over listener arrays under
    //      `.agents/scripts/lib/orchestration/lifecycle/**`.
    //   2. Wildcard-observer firewall: no state-mutating imports in
    //      listener modules that register on `'*'`.
    // Both rules are mandated by Tech Spec #2189 and have no biome
    // equivalent.
    //
    // Use bare `node` (PATH-resolved) rather than `process.execPath`:
    // `process.execPath` on Windows often expands to `C:\Program
    // Files\nodejs\node.exe`, and spawn(..., { shell: true }) does not
    // quote the executable, so the space breaks invocation.
    name: 'lifecycle-lint',
    cmd: 'node',
    args: ['.agents/scripts/check-lifecycle-lint.js'],
  },
  {
    // Custom Node-based lint for the workflow prose surface (Epic #4474
    // PR5). Enforces: no workflow may instruct calling an exported
    // library function that has no CLI entrypoint — the measured
    // shim-writing failure mode the /plan collapse killed. See
    // check-workflow-cli-lint.js for the paragraph-level heuristic.
    name: 'workflow-cli-lint',
    cmd: 'node',
    args: ['.agents/scripts/check-workflow-cli-lint.js'],
  },
  {
    // Custom Node-based lint for label-vocabulary citations in
    // `.agents/docs/SDLC.md` and `.agents/workflows/**/*.md` (Story #2892,
    // Tech Spec F9 under Epic #2880). Greps inline backtick code
    // spans for axis-shaped tokens (`type/epic`, etc.) and asserts
    // only the canonical `<axis>::<value>` separator from
    // `lib/label-constants.js` appears. Closes the drift gap that
    // let the original `type/epic` typo land at
    // `.agents/workflows/helpers/plan-epic.md:49`.
    name: 'label-vocabulary',
    cmd: 'node',
    args: ['.agents/scripts/lint-label-vocabulary.js'],
  },
  {
    // Architecture cycle ratchet (Story #3991). Detects directed import
    // cycles under `.agents/scripts/` and fails on any cycle not in the
    // committed allowlist (`baselines/arch-cycles.json`). Mirrors the
    // ratchet-down semantics of `check-dead-exports.js`.
    name: 'arch-cycles',
    cmd: 'node',
    args: ['.agents/scripts/check-arch-cycles.js'],
  },
];

function runTask({ name, cmd, args }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: useShell });
    child.on('error', (err) => {
      process.stderr.write(`[run-lint:${name}] spawn error: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        process.stderr.write(`[run-lint:${name}] killed by ${signal}\n`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const results = await Promise.all(tasks.map(runTask));
const failed = results.findIndex((code) => code !== 0);
process.exit(failed === -1 ? 0 : results[failed]);
