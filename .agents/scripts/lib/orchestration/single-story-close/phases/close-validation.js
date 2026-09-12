/**
 * phases/close-validation.js — run the canonical close-validation gate
 * chain for a standalone Story.
 *
 * The standalone path uses the same `runCloseValidation` chain as
 * Epic-attached Stories so the experience matches — only the baseline
 * ref changes (`main`, not `epic/<id>`).
 *
 * Standalone evidence keyspace (Story #4250). Standalone Stories have no
 * parent Epic, so they cannot scope a `validation-evidence.json` under a
 * `temp/run-<id>/` tree. Rather than feed a null `epicId` into the
 * Epic-keyed path (which structurally disabled the evidence cache and
 * forced every re-run — base-sync conflict, review remediation, baseline
 * absorb — to re-execute ALL gates including the coverage suite), the
 * standalone close now passes `standalone: true`. `runCloseValidation`
 * then anchors the cache on the Story id alone at
 * `temp/standalone/stories/story-<id>/validation-evidence.json`, so a
 * second close at unchanged HEAD short-circuits the already-passed gates.
 *
 * Pre-gate self-heal (Stories #4250, #5224). Two best-effort steps run on the
 * Story branch before the check-only gates score it — the scoped format
 * autofix and the upward maintainability write-back — so whatever they commit
 * is part of what the gates see and part of the branch's own PR. Both live in
 * [`pre-gate-steps.js`](pre-gate-steps.js); neither can fail a close, because
 * an authoritative gate for each runs immediately below.
 *
 * Bounded gate output (Story #4736). Every gate line goes to the run's
 * `gate-log.js` sink — an artifact under the gitignored temp tree — instead
 * of straight to the agent's stdout, where a passing `npm test` alone once
 * pushed a successful close past the host's inline tool-result ceiling. A
 * clean run reports one digest line naming the artifact; a failing gate
 * replays its captured tail inline, because that is exactly when the caller
 * needs the evidence in front of them. `AGENT_LOG_LEVEL=verbose` restores
 * live streaming.
 *
 * Projection advisories (Story #4776). `baseBranch`, `storyBranch` and the
 * resolved `config` are forwarded to `runCloseValidation` so its projection
 * phase can run. They surface, after the gates pass, which committed
 * baseline rows the post-merge tree would breach and the exact
 * `*:update` + `baseline-refresh:` remedy — advisory only, so the close
 * verdict is unchanged.
 *
 * `runCloseValidation`, `buildDefaultGates` and the pre-gate steps (whole, or
 * their two individual collaborators) are accepted as injected dependencies so
 * the parent CLI's cache-busted bindings win in tests that mock the upstream
 * module URLs.
 */

import { buildDefaultGates as defaultBuildDefaultGates } from '../../../close-validation/gates.js';
import { runCloseValidation as defaultRunCloseValidation } from '../../../close-validation/runner.js';
import { createGateLogSink as defaultCreateGateLogSink } from '../gate-log.js';
import { runPreGateSteps as defaultRunPreGateSteps } from './pre-gate-steps.js';

/**
 * Run the close-validation gate chain. Throws on first gate failure.
 *
 * Order: pre-gate self-heal steps → close-validation gates. The steps scope
 * to the `baseBranch...storyBranch` diff, commit inside the Story worktree,
 * and are best-effort — a missing `storyBranch` (resume/legacy callers) skips
 * them with a log line rather than failing.
 *
 * Gates are built from the canonical resolved config (`buildDefaultGates`
 * reads `project.commands` and `delivery.quality.gates.crap.enabled`); the
 * `baseBranch` is forwarded as the gate `baseBranch` so the format gate's
 * changed-file scope anchors on it. `standalone: true` routes the evidence
 * cache to the storyId-anchored keyspace.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath: string|null,
 *   config: object,
 *   baseBranch: string,
 *   storyBranch?: string,
 *   storyId: number,
 *   progress: (tag: string, msg: string) => void,
 *   runCloseValidation?: typeof defaultRunCloseValidation,
 *   buildDefaultGates?: typeof defaultBuildDefaultGates,
 *   runPreGateSteps?: typeof defaultRunPreGateSteps,
 *   runScopedFormatAutofix?: Function,
 *   runBaselineUpwardWriteback?: Function,
 *   runContextBudgetWriteback?: Function,
 *   createGateLogSink?: typeof defaultCreateGateLogSink,
 * }} args
 * @returns {Promise<{ gates: Record<string, 'passed'|'skipped'> }>} Per-gate
 *   outcomes keyed by gate name — the terminal envelope reports the split
 *   baselines entries from this (Story #5172). A failure throws instead, with
 *   `err.closeGate` naming the gate that died.
 */
export async function runCloseValidationPhase({
  cwd,
  worktreePath,
  config,
  baseBranch,
  storyBranch,
  storyId,
  progress,
  runCloseValidation = defaultRunCloseValidation,
  buildDefaultGates = defaultBuildDefaultGates,
  runPreGateSteps = defaultRunPreGateSteps,
  runScopedFormatAutofix,
  runBaselineUpwardWriteback,
  runContextBudgetWriteback,
  createGateLogSink = defaultCreateGateLogSink,
}) {
  await runPreGateSteps({
    cwd,
    worktreePath,
    storyId,
    baseBranch,
    storyBranch,
    config,
    progress,
    runScopedFormatAutofix,
    runBaselineUpwardWriteback,
    runContextBudgetWriteback,
  });

  progress(
    'VALIDATE',
    `Running close-validation gates against baseline ${baseBranch}${worktreePath ? ` in ${worktreePath}` : ''}...`,
  );
  // Story #4736 — one sink for both `log` seams (gate construction and gate
  // execution), so nothing in the chain can route around the artifact.
  const gateLog = createGateLogSink({ storyId, config });
  const gateList = buildDefaultGates({
    config,
    baseBranch,
    cwd: worktreePath || cwd,
    log: gateLog.log,
    storyId, // Story #5313 — a credited bare `npm test` registers `test`.
    evidenceCwd: cwd,
  });
  let validation;
  try {
    validation = await runCloseValidation({
      cwd,
      worktreePath,
      gates: gateList,
      log: gateLog.log,
      storyId,
      // Story #4250 — standalone storyId-anchored evidence keyspace. No
      // epicId; the standalone flag routes the cache to
      // temp/standalone/stories/story-<id>/validation-evidence.json.
      standalone: true,
      // Story #4776 — the branch pair and resolved config the advisory
      // projections need. Without them the runner skips the projection
      // phase entirely, which is the correct behaviour for resume/legacy
      // callers that have no story branch to diff.
      baseBranch,
      storyBranch,
      config,
    });
  } finally {
    // Story #4766 — gate lines are buffered to an async stream so the drain
    // never blocks a gate child's pipe. Settle the artifact before anything
    // reads it, replays from it, or reports its path — including on the throw
    // path, where the artifact is the only surviving record.
    await gateLog.flush();
  }
  if (!validation.ok) {
    const [first] = validation.failed;
    const { gate, status, cwd: gateCwd } = first;
    // The evidence is the point on this path: replay the captured tail inline
    // rather than making the caller open a file to learn why close stopped.
    gateLog.replay();
    const err = new Error(
      `[single-story-close] Gate failed: ${gate.name} (exit ${status})${gateCwd ? ` in ${gateCwd}` : ''}.` +
        (gate.hint ? ` ${gate.hint}` : ''),
    );
    // Story #5172 — the phase tracker tags `closePhase`; this tags WHICH gate
    // inside the phase died, so the failed terminal can name the split
    // baselines entry rather than reporting a generic validation failure.
    err.closeGate = gate.name;
    throw err;
  }
  progress('VALIDATE', `✅ All gates passed. ${gateLog.digest()}`);
  return { gates: gateOutcomes(gateList, validation) };
}

/**
 * Per-gate outcomes for a validation run that passed (Story #5172).
 *
 * Every registered gate passed unless the runner reported it skipped — an
 * evidence short-circuit at unchanged HEAD, or a changed-file scope that
 * matched nothing. `skipped` is the honest verdict for both: the gate did not
 * run in THIS invocation, and the terminal schema's own contract is that a
 * skipped gate is reported as skipped rather than quietly counted as a pass.
 *
 * @param {Array<{ name: string }>} gateList The gates this run registered.
 * @param {{ skipped?: Array<{ gate: { name: string } }> }} validation
 * @returns {Record<string, 'passed'|'skipped'>}
 */
function gateOutcomes(gateList, validation) {
  const outcomes = {};
  for (const gate of gateList) outcomes[gate.name] = 'passed';
  for (const { gate } of validation.skipped ?? [])
    outcomes[gate.name] = 'skipped';
  return outcomes;
}
