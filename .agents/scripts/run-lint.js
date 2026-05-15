#!/usr/bin/env node
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
