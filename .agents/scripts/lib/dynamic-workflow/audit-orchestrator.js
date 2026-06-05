// .agents/scripts/lib/dynamic-workflow/audit-orchestrator.js
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
 * @property {(crossCheckedBlocks: string[]) => string} buildSynthesisPrompt
 *   Compose the synthesis prompt that assembles the report and writes it.
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

  // Phase 1 — parallel per-dimension analysis (read-only agents).
  const rawFindings = await phase(ORCHESTRATION_PHASES.ANALYZE, async () =>
    Promise.all(
      dimensions.map(async (dimension) => {
        const { output } = await agent({
          prompt: buildDimensionPrompt(dimension),
          allowedTools: [...readOnlyTools],
        });
        return { dimension, findings: output };
      }),
    ),
  );

  // Phase 2 — adversarial cross-check: an independent agent re-verifies each
  // dimension's findings and filters false positives before inclusion.
  const crossChecked = await phase(ORCHESTRATION_PHASES.CROSS_CHECK, async () =>
    Promise.all(
      rawFindings.map(async ({ dimension, findings }) => {
        const { output } = await agent({
          prompt: buildCrossCheckPrompt(dimension, findings),
          allowedTools: [...readOnlyTools],
        });
        return output;
      }),
    ),
  );

  // Phase 3 — synthesis: assemble the report contract and write the artifact.
  const { output: report } = await phase(
    ORCHESTRATION_PHASES.SYNTHESIZE,
    async () =>
      agent({
        prompt: buildSynthesisPrompt(crossChecked),
        // Synthesis is the one stage permitted to write the report artifact.
        allowedTools: [...readOnlyTools, SYNTHESIS_WRITE_TOOL],
      }),
  );

  // Self-verify report-contract conformance before returning.
  const check = assertReportContract(report);
  if (!check.conformant) {
    throw new Error(formatContractError(check));
  }

  return buildResult(report);
}
