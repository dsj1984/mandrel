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

/**
 * A Node gate spelled `node .agents/scripts/<script>` — the shape six of the
 * eight tasks share. Spelling it once keeps this list readable as what it
 * actually is (a fan-out roster) instead of a wall of spawn tuples, and keeps
 * adding a gate from costing the module a maintainability regression for the
 * boilerplate rather than the behaviour. Mirrors `run-verify.js`'s `gate()`.
 *
 * Use bare `node` (PATH-resolved) rather than `process.execPath`:
 * `process.execPath` on Windows often expands to `C:\Program
 * Files\nodejs\node.exe`, and spawn(..., { shell: true }) does not quote the
 * executable, so the space breaks invocation.
 *
 * The path is passed WHOLE rather than assembled from a basename. Composing
 * it (`` `.agents/scripts/${script}` ``) reads better and is wrong:
 * `check-knip-entries.js` derives which CLIs something actually invokes by
 * scanning this file's source text for literal script paths, and four of the
 * gates below are invoked from nowhere else. Interpolating the path made them
 * invisible to that derivation, so knip called them dead and the ratchet
 * offered to record live gates as expected-dead — the Story #5012 trap.
 *
 * @param {string} name reported in this driver's own error prefix
 * @param {string} script repo-relative path, spelled as one literal
 * @returns {{ name: string, cmd: string, args: string[] }}
 */
const nodeGate = (name, script) => ({ name, cmd: 'node', args: [script] });

const tasks = [
  {
    name: 'biome',
    cmd: 'npx',
    args: ['biome', 'ci', '.'],
  },
  {
    // `docs/**/*.md` sat outside these globs until PR #4970's follow-up,
    // so `npm run lint` reported "0 error(s)" while the close-time
    // code-review lens — which lints the whole changed surface, not just
    // what this driver globs — raised pre-existing `docs/` violations
    // against whichever Story happened to touch the file. Keep `docs/`
    // here so the two surfaces agree. `docs/CHANGELOG.md` is linted too;
    // the generator-owned rules it can never satisfy are exempted by a
    // `markdownlint-disable-file` directive in its own header.
    name: 'markdownlint',
    cmd: 'npx',
    args: [
      'markdownlint-cli2',
      '.agents/**/*.md',
      'docs/**/*.md',
      '*.md',
      '!node_modules/**',
      '!.worktrees/**',
    ],
  },
  // Lifecycle surface (Story #2227). Enforces (1) no `Promise.all` under
  // `.agents/scripts/lib/orchestration/lifecycle/**` — the ledger is
  // append-only and a parallel write interleaves records; and (2) the
  // auto-merge lockout: the `gh pr merge` literal appears only in
  // `single-story-close/phases/auto-merge.js`. Neither has a biome
  // equivalent. Story #5024 dropped the third rule (the wildcard-observer
  // firewall) with the bus and the `listeners/` directory its predicate
  // required.
  nodeGate('lifecycle-lint', 'scripts/check-lifecycle-lint.js'),
  // Workflow prose surface (Epic #4474 PR5). No workflow may instruct calling
  // an exported library function that has no CLI entrypoint — the measured
  // shim-writing failure mode the /mandrel-plan collapse killed. See
  // check-workflow-cli-lint.js for the paragraph-level heuristic.
  nodeGate('workflow-cli-lint', 'scripts/check-workflow-cli-lint.js'),
  // Label-vocabulary citations in `.agents/docs/SDLC.md` and
  // `.agents/workflows/**/*.md` (Story #2892). Greps inline backtick code
  // spans for axis-shaped tokens (`type/epic`, etc.) and asserts only the
  // canonical `<axis>::<value>` separator from `lib/label-constants.js`
  // appears. Closes the drift gap that let the original `type/epic` typo land.
  nodeGate('label-vocabulary', 'scripts/lint-label-vocabulary.js'),
  // GitHub Actions job-timeout gate (Story #4936). Fails a `jobs.<id>` that
  // sets no `timeout-minutes` (inheriting GitHub's 360-minute default) or sets
  // one above the ceiling. A deadlocked Windows job burned 44 minutes of a
  // runner and withheld the failing required check's logs for the whole time.
  nodeGate('workflow-timeouts', 'scripts/check-workflow-timeouts.js'),
  // Architecture cycle ratchet (Story #3991). Detects directed import cycles
  // under `.agents/scripts/` and fails on any cycle not in the committed
  // allowlist (`baselines/arch-cycles.json`).
  nodeGate('arch-cycles', '.agents/scripts/check-arch-cycles.js'),
  // Payload boundary (Story #5381). Every top-level `.agents/scripts` CLI must
  // be named by a consumer surface, and nothing under `.agents/` may import
  // from outside it — the ratchet that keeps contributor tooling in `scripts/`.
  nodeGate('payload-boundary', 'scripts/check-payload-boundary.js'),
  // Static Gherkin corpus gate (Story #5013): must-compile with the real
  // parser, then must-bind scoped per step root. Opt-in behind
  // `qa.gherkinLint`, so it exits 0 as "not configured" in this repo. Here
  // rather than in run-verify.js so it reaches CI through the same `lint`
  // required check as arch-cycles; listing it in both would double-pay it.
  nodeGate('gherkin-corpus', '.agents/scripts/check-gherkin-corpus.js'),
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
