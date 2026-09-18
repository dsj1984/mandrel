#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * Local full verification — a true CI mirror for the gates that CAN be proven
 * locally, without epic-scoped MI projection or push semantics.
 *
 * Order: audit (SCA) → lint (includes docs:check + the arch-cycles ratchet) →
 * full test suite → unified baselines → the standalone ratchets
 * (dead-exports ×2, context-budget, workflow-citations, cyclomatic,
 * schema-references).
 *
 * The `audit` step runs `npm audit --audit-level=high`, matching CI's
 * "Dependency Vulnerability Audit (SCA)" gate so a local green no longer hides
 * a high-severity advisory that CI would fail on. It is independent of the
 * pre-push `PREPUSH_AUDIT` opt-in, which stays unchanged.
 *
 * The trailing ratchets complete the mirror of CI's "Architecture Cycle Check"
 * step in the `baselines` job (Story #4549). That step runs three checks;
 * `check-arch-cycles.js` is deliberately absent from STEPS because the `lint`
 * step above already runs it (see run-lint.js) — re-running it here would
 * double-pay a gate verify already covers. `check-dead-exports.js` and
 * `check-context-budget.js` had no such cover: they were reachable locally only
 * via the diff-scoped `npm run quality:preview` or a direct invocation, so a
 * clean `verify` could still hide a CI-red — the failure Story #4531 / PR #4548
 * paid for with a full push → CI → fix → push round-trip. Both are pure-Node
 * and baseline-aware, adding ~15s on a cold cache (dominated by knip's
 * full-tree scan in check-dead-exports.js) to a command that already carries
 * the full test suite.
 *
 * Story #5004 closed the last two mirror gaps that were pure omission.
 * `check-cyclomatic.js` (#4923) and `check-schema-references.js` (#4938) were
 * each added to the `baselines` job's standalone-ratchet slot without ever
 * being added here, so a green `verify` still hid both. Like their neighbours
 * they are pure-Node and cost milliseconds.
 *
 * Story #5340 closed the `check-workflow-citations.js` gap the same way, once
 * demoting it to a report made it free: it had been exempted here because
 * `tests/check-workflow-citations.test.js` re-ran the same ratchet, so a
 * `verify` step would have double-paid it. That test now asserts the report,
 * not a ceiling, so the step is the only local surface that prints the count.
 *
 * Still NOT mirrored: `check-baseline-scope.js` runs in CI's `baselines` job
 * only — `docs/contributing/known-tooling-behavior.md` entry 2 carries the current
 * coverage table. (`prune-baseline-orphans.js --check` used to sit in that
 * list; it no longer runs in CI at all — the un-attributed duplicate of the
 * scope gate's `extra` direction reds every open PR on inherited rows.) Nor are the CI gates this command structurally cannot
 * reproduce (action pinning, TruffleHog secret scan) — those are catalogued
 * in docs/ci-contract.md. The nightly full-scope re-score
 * (.github/workflows/baseline-drift.yml) is deliberately outside this
 * mirror too: it re-scores the whole tree, which is the cost `verify` exists
 * to avoid paying on every run.
 */

import { spawnSync } from 'node:child_process';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';

/**
 * A gate step: `node .agents/scripts/<script>` plus any extra args. Eight of
 * the eleven steps share exactly that shape, so spelling it once leaves the list
 * below readable as what it actually is — a gate *order* — instead of a wall
 * of spawn tuples.
 *
 * @param {string} label reported as `failedStep` when the gate exits non-zero
 * @param {string} script path relative to the repository root
 * @param {...string} args extra CLI args
 * @returns {{ label: string, cmd: string, args: string[] }}
 */
const gate = (label, script, ...args) => ({
  label,
  cmd: 'node',
  args: [script, ...args],
});

const STEPS = [
  { label: 'audit', cmd: 'npm', args: ['audit', '--audit-level=high'] },
  { label: 'lint', cmd: 'npm', args: ['run', 'lint'] },
  { label: 'test', cmd: 'npm', args: ['test'] },
  gate('baselines', '.agents/scripts/check-baselines.js'),
  // Ordered ahead of the dead-exports pair deliberately. When a new CLI is
  // missing from knip.json's entry list, both gates fail — but only this one
  // names the cause. Seeing the ratchet's whole-file diff first is what made
  // "accept the diff" look like the fix during Story #5012.
  gate('knip-entries', 'scripts/check-knip-entries.js'),
  gate('dead-exports', '.agents/scripts/check-dead-exports.js'),
  gate(
    'dead-exports-production',
    '.agents/scripts/check-dead-exports.js',
    '--production',
  ),
  gate('context-budget', '.agents/scripts/check-context-budget.js'),
  gate('workflow-citations', 'scripts/check-workflow-citations.js'),
  gate('cyclomatic', '.agents/scripts/check-cyclomatic.js'),
  gate('schema-references', 'scripts/check-schema-references.js'),
  gate('comment-policy', 'scripts/check-comment-policy.js'),
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
