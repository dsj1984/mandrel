// scripts/lib/dynamic-workflow/audit-orchestrator.js
/**
 * Reusable audit-lens orchestration engine (Epic #3597, Story #3609).
 *
 * Every audit lens that runs as a Claude Code **dynamic workflow**
 * (https://code.claude.com/docs/en/workflows) shares the same three-phase
 * fan-out:
 *
 *   1. **analyze** — one read-only sub-agent per analysis dimension, run in
 *      parallel, each producing raw findings for its dimension only.
 *   2. **adversarial cross-check** — an independent read-only reviewer
 *      re-verifies each dimension's findings, dropping false positives.
 *   3. **synthesize** — a single agent assembles the cross-checked findings
 *      into the lens's report contract and writes the artifact.
 *
 * Before this engine existed, each lens (starting with `audit-clean-code`)
 * inlined a private copy of this loop. `runAuditOrchestration` extracts it
 * once so a lens workflow only has to declare *what* is lens-specific —
 * its dimension list, its prompt builders, its read-only tool allowlist, and
 * its report-contract self-check — and delegate the fan-out plumbing here.
 *
 * ## Read-only guarantee
 *
 * Analysis and cross-check agents receive only the caller-supplied
 * `readOnlyTools` allowlist (read/search tools — no write/edit/shell). The
 * single write in the run is the report artifact, performed by the synthesis
 * agent, which is granted the read-only allowlist plus `Write`.
 *
 * ## Partial-failure posture
 *
 * The per-dimension fan-out is settled, not all-or-nothing (Story #4783). One
 * rejected dimension used to discard every sibling's completed work; the
 * engine now partitions the settled results, flows the fulfilled dimensions on
 * to the next phase, and records the rejected ones as an explicit
 * degraded-coverage note in the report's Executive Summary. This mirrors the
 * posture `close-validation/runner.js` already takes with per-gate errors:
 * capture the failure into the result rather than rejecting the whole run.
 * Only a *total* loss — every dimension rejected — throws, because there is
 * then nothing to synthesise.
 *
 * ## Report-contract self-check
 *
 * After synthesis the engine calls the caller-supplied `assertReportContract`
 * on the synthesis output and throws when the report is non-conformant, so a
 * lens can never silently emit a malformed report. The thrown message is
 * derived from the caller's `formatContractError` (when supplied) so each lens
 * can phrase the failure in its own terms.
 *
 * This module is dependency-free and lens-agnostic: it imports nothing from
 * any specific lens. It is exercised in isolation by
 * `tests/dynamic-workflow-audit-orchestrator.test.js` with a stub `agent` /
 * `phase` so the fan-out wiring is unit-testable without a live Claude Code
 * runtime.
 *
 * @module dynamic-workflow/audit-orchestrator
 */

import { withDegradedCoverageNote } from './degraded-coverage.js';

/**
 * A dimension that did not complete, as recorded by the settled fan-out.
 *
 * @typedef {import('./degraded-coverage.js').DimensionFailure} DimensionFailure
 */

/**
 * The live dynamic-workflow runtime context the host passes to a saved
 * `.claude/workflows/*.workflow.js` entry point. Re-exported as a typedef so
 * every lens workflow references one canonical shape rather than re-declaring
 * it (and drifting from) the runtime contract.
 *
 * `agent` spawns a sub-agent and resolves to its result envelope (the textual
 * output is on `.output`). `phase` groups one or more agent calls under a
 * named phase surfaced in the `/workflows` view; it resolves to **whatever its
 * callback resolves to**, so it is generic over the callback's return type.
 *
 * @typedef {object} AgentResult
 * @property {string} output - The sub-agent's textual output.
 *
 * @typedef {object} WorkflowContext
 * @property {(opts: { prompt: string, allowedTools?: string[], model?: string }) => Promise<AgentResult>} agent
 *   Spawn a sub-agent with the given prompt and (optional) tool allowlist /
 *   model. Resolves to the agent's result envelope.
 * @property {<T>(name: string, fn: () => Promise<T>) => Promise<T>} phase
 *   Group agent calls into a named phase (per-phase agent count, token total,
 *   and elapsed time surface in `/workflows`). Resolves to the callback's
 *   own resolved value.
 * @property {object} inputs - Caller-supplied workflow inputs.
 */

/**
 * @template TReport
 * @typedef {object} AuditOrchestrationSpec
 * @property {WorkflowContext} ctx
 *   The live dynamic-workflow runtime context (`agent` + `phase`).
 * @property {readonly string[]} dimensions
 *   The independent analysis dimensions to fan out, one sub-agent each.
 * @property {readonly string[]} readOnlyTools
 *   The read-only tool allowlist granted to analysis and cross-check agents.
 *   The synthesis agent additionally receives `Write`.
 * @property {(dimension: string) => string} buildDimensionPrompt
 *   Compose the analysis prompt for one dimension (lens-specific).
 * @property {(dimension: string, findings: string) => string} buildCrossCheckPrompt
 *   Compose the adversarial cross-check prompt for one dimension's findings.
 * @property {(crossCheckedBlocks: string[], degraded: DimensionFailure[]) => string} buildSynthesisPrompt
 *   Compose the synthesis prompt that assembles the report and writes it. The
 *   second argument lists the dimensions that did not complete (empty on a
 *   full-coverage run); lenses may ignore it — the engine annotates the report
 *   with the degraded-coverage note either way.
 * @property {(report: string) => { conformant: boolean, missingSections: string[], hasTitle: boolean }} assertReportContract
 *   Self-check the synthesised report against the lens's report contract.
 * @property {(check: { conformant: boolean, missingSections: string[], hasTitle: boolean }) => string} [formatContractError]
 *   Optional: phrase the non-conformance error in the lens's own terms.
 *   Defaults to a generic message naming the missing title / sections.
 * @property {(report: string) => TReport} [buildResult]
 *   Optional: derive the engine's return value from the synthesised report.
 *   Defaults to returning `{ report }`.
 */

/**
 * The default phase names, exported so lenses and tests reference the exact
 * strings rather than hard-coding them.
 */
export const ORCHESTRATION_PHASES = Object.freeze({
  ANALYZE: 'analyze-dimensions',
  CROSS_CHECK: 'adversarial-cross-check',
  SYNTHESIZE: 'synthesize-report',
});

/** The single mutating tool the synthesis agent is granted. */
export const SYNTHESIS_WRITE_TOOL = 'Write';

/**
 * Default phrasing for a report-contract self-check failure. Lenses can
 * override via `spec.formatContractError`.
 *
 * @param {{ conformant: boolean, missingSections: string[], hasTitle: boolean }} check
 * @returns {string}
 */
export function defaultContractError(check) {
  const titlePart = check.hasTitle ? '' : 'title; ';
  const sections = Array.isArray(check.missingSections)
    ? check.missingSections.join(', ')
    : '';
  return `report failed contract check: missing ${titlePart}sections=[${sections}]`;
}

/**
 * Reduce a rejection reason to a single-line message.
 *
 * @param {unknown} reason
 * @returns {string}
 */
function describeRejection(reason) {
  if (reason instanceof Error) return reason.message;
  return String(reason ?? 'unknown error');
}

/**
 * Partition settled fan-out results into the values that completed and the
 * dimensions that did not. `dimensions[i]` names the dimension behind
 * `settled[i]`, so a rejection is always attributable.
 *
 * @template T
 * @param {readonly string[]} dimensions
 * @param {readonly PromiseSettledResult<T>[]} settled
 * @param {string} phaseName Phase recorded on each failure.
 * @returns {{ fulfilled: T[], failures: DimensionFailure[] }}
 */
function partitionSettled(dimensions, settled, phaseName) {
  const fulfilled = [];
  const failures = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value);
      return;
    }
    failures.push({
      dimension: dimensions[index],
      phase: phaseName,
      reason: describeRejection(result.reason),
    });
  });
  return { fulfilled, failures };
}

/**
 * Run the shared three-phase audit-lens orchestration: parallel per-dimension
 * analysis → adversarial cross-check → synthesis + report-contract self-check.
 *
 * The caller supplies everything lens-specific (dimensions, prompt builders,
 * tool allowlist, contract assertion); this engine owns the fan-out plumbing
 * and the read-only / single-write tool discipline.
 *
 * @template TReport
 * @param {AuditOrchestrationSpec<TReport>} spec
 * @returns {Promise<TReport>}
 */
export async function runAuditOrchestration(spec) {
  const {
    ctx,
    dimensions,
    readOnlyTools,
    buildDimensionPrompt,
    buildCrossCheckPrompt,
    buildSynthesisPrompt,
    assertReportContract,
    formatContractError = defaultContractError,
    buildResult = (report) => /** @type {TReport} */ ({ report }),
  } = spec;

  const { agent, phase } = ctx;

  // Phase 1 — parallel per-dimension analysis (read-only agents). Settled, not
  // all-or-nothing: one dimension's rejection must not discard its siblings.
  const analyzed = await phase(ORCHESTRATION_PHASES.ANALYZE, async () =>
    Promise.allSettled(
      dimensions.map(async (dimension) => {
        const { output } = await agent({
          prompt: buildDimensionPrompt(dimension),
          allowedTools: [...readOnlyTools],
        });
        return { dimension, findings: output };
      }),
    ),
  );
  const { fulfilled: rawFindings, failures: analyzeFailures } =
    partitionSettled(dimensions, analyzed, 'analyze');

  // Phase 2 — adversarial cross-check: an independent agent re-verifies each
  // surviving dimension's findings and filters false positives before
  // inclusion. Settled for the same reason as phase 1.
  const checkedDimensions = rawFindings.map((entry) => entry.dimension);
  const checked = await phase(ORCHESTRATION_PHASES.CROSS_CHECK, async () =>
    Promise.allSettled(
      rawFindings.map(async ({ dimension, findings }) => {
        const { output } = await agent({
          prompt: buildCrossCheckPrompt(dimension, findings),
          allowedTools: [...readOnlyTools],
        });
        return output;
      }),
    ),
  );
  const { fulfilled: crossChecked, failures: crossCheckFailures } =
    partitionSettled(checkedDimensions, checked, 'cross-check');

  const degraded = [...analyzeFailures, ...crossCheckFailures];
  if (dimensions.length > 0 && crossChecked.length === 0) {
    // Nothing survived — there is no partial report to salvage.
    throw new Error(
      `every audit dimension failed: ${degraded
        .map((f) => `${f.dimension} (${f.phase}: ${f.reason})`)
        .join('; ')}`,
    );
  }

  // Phase 3 — synthesis: assemble the report contract and write the artifact.
  const { output: synthesised } = await phase(
    ORCHESTRATION_PHASES.SYNTHESIZE,
    async () =>
      agent({
        prompt: buildSynthesisPrompt(crossChecked, degraded),
        // Synthesis is the one stage permitted to write the report artifact.
        allowedTools: [...readOnlyTools, SYNTHESIS_WRITE_TOOL],
      }),
  );

  // The coverage gap is annotated by the engine, never left to the synthesis
  // agent's discretion.
  const report = withDegradedCoverageNote(
    synthesised,
    degraded,
    dimensions.length,
  );

  // Self-verify report-contract conformance before returning.
  const check = assertReportContract(report);
  if (!check.conformant) {
    throw new Error(formatContractError(check));
  }

  return buildResult(report);
}
