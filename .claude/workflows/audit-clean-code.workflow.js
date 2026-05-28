/**
 * Dynamic-workflow orchestrator for the `audit-clean-code` lens (Story #3278).
 *
 * This is a Claude Code **dynamic workflow** script
 * (https://code.claude.com/docs/en/workflows). The runtime executes it in the
 * background, holding the loop and intermediate findings in script variables
 * so only the final report lands in the host LLM's context. It is the
 * *orchestrated* execution path for `audit-clean-code`; the *sequential*
 * single-pass path remains `.agents/workflows/audit-clean-code.md`, followed
 * turn-by-turn whenever dynamic workflows are unavailable.
 *
 * ## Why a saved project workflow
 *
 * Saved at `.claude/workflows/` so it is shared with everyone who clones the
 * repo (per the dynamic-workflows doc: a project-saved script is the right
 * home for a shared workflow). It runs as `/audit-clean-code` when dynamic
 * workflows are enabled.
 *
 * ## Lens markdown stays authoritative
 *
 * This script does NOT fork a second copy of the analysis spec. The
 * per-dimension prompts are *derived from* the lens markdown
 * (`.agents/workflows/audit-clean-code.md`) at run time via
 * `loadLensSpec()` — the lens remains the single source of truth for *what*
 * to analyse and *the output report shape*. If the lens changes, this
 * orchestrator picks up the change without edits.
 *
 * ## Report contract parity
 *
 * Both paths emit the identical report to
 * `{{auditOutputDir}}/audit-clean-code-results.md` with the headings defined
 * in `lib/dynamic-workflow/clean-code-report-contract.js`. The orchestrated
 * path assembles its cross-checked findings into exactly that skeleton and
 * self-verifies with `assertReportContract` before writing, so downstream
 * consumers (`/epic-deliver` Phase 4 epic-audit, `audit-to-stories`) cannot
 * tell which path produced the report.
 *
 * ## Read-only guarantee
 *
 * The lens is read-only. Dynamic-workflow subagents run in `acceptEdits` and
 * inherit the session tool allowlist, but this script grants the analysis
 * agents NO write/edit/shell-mutation tools — they receive only read/search
 * tools (`Read`, `Grep`, `Glob`). The single write in the run is the final
 * report artifact, performed by the synthesis stage.
 *
 * ## Scope parity
 *
 * Honours the lens's `## Scope (Epic mode)` `{{changedFiles}}` contract:
 * when `inputs.changedFiles` is a non-empty newline-delimited list (Epic-mode
 * invocation from `/epic-deliver` Phase 4) the scan is restricted to those
 * files; otherwise it is a full codebase-wide scan, identical to a manual
 * `/audit-clean-code`.
 *
 * @typedef {object} WorkflowContext
 * @property {(opts: object) => Promise<{ output: string }>} agent
 *   Spawn a subagent. `{ prompt, allowedTools?, model? }`.
 * @property {(name: string, fn: () => Promise<unknown>) => Promise<unknown>} phase
 *   Group agents into a named phase (surfaced in the `/workflows` view with
 *   per-phase agent count, token total, and elapsed time).
 * @property {object} inputs   Caller-supplied inputs.
 * @property {string} [inputs.changedFiles]  Epic-mode change-set list (newline-delimited).
 * @property {string} [inputs.auditOutputDir] Resolved audit output dir.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertReportContract,
  REPORT_ARTIFACT_BASENAME,
  REPORT_TITLE,
  REQUIRED_SECTIONS,
} from '../../.agents/scripts/lib/dynamic-workflow/clean-code-report-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const LENS_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'audit-clean-code.md',
);

/**
 * The independent analysis dimensions the lens decomposes into. These names
 * map 1:1 onto the lens's Step 1 "Quality Scan" bullets and Step 2
 * "Evaluation Dimensions"; each fans out to its own subagent so they run in
 * parallel and can be cross-checked independently.
 */
const DIMENSIONS = Object.freeze([
  'Logic Complexity',
  'Duplication',
  'Component Health',
  'Naming Clarity',
  'Error Handling',
  'Dead Code',
  'SOLID Principles',
  'DRY',
  'KISS',
  'Testability',
  'Documentation',
]);

/** Read-only tool allowlist for analysis agents — no write/edit/shell. */
const READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);

/**
 * Load the authoritative lens markdown so per-dimension prompts derive from
 * it rather than a forked copy.
 *
 * @returns {string}
 */
export function loadLensSpec() {
  return readFileSync(LENS_PATH, 'utf8');
}

/**
 * Build the scope clause shared by every analysis agent, honouring the lens's
 * `{{changedFiles}}` contract.
 *
 * @param {string|undefined} changedFiles
 * @returns {string}
 */
export function buildScopeClause(changedFiles) {
  const list = typeof changedFiles === 'string' ? changedFiles.trim() : '';
  if (list.length === 0 || list === '{{changedFiles}}') {
    return 'SCOPE: No scope filter — analyse the full codebase, exactly as a manual /audit-clean-code run.';
  }
  return [
    'SCOPE: Restrict analysis to the following changed files (and their',
    'direct dependencies where the dimension requires cross-file reasoning):',
    list,
  ].join('\n');
}

/**
 * Compose the analysis prompt for one dimension. Embeds the authoritative
 * lens spec so the agent analyses against the canonical definition, and pins
 * the read-only constraint.
 *
 * @param {string} dimension
 * @param {string} lensSpec
 * @param {string} scopeClause
 * @returns {string}
 */
export function buildDimensionPrompt(dimension, lensSpec, scopeClause) {
  return [
    `You are auditing the codebase for the "${dimension}" dimension only.`,
    'You are READ-ONLY: do not edit, create, or run mutating commands.',
    '',
    scopeClause,
    '',
    'Authoritative lens specification (the single source of truth for what',
    'to look for and how to phrase findings):',
    '',
    '--- BEGIN LENS SPEC ---',
    lensSpec,
    '--- END LENS SPEC ---',
    '',
    `Return ONLY the findings for the "${dimension}" dimension, each as a`,
    '`### <Short Title>` block using the exact field structure from the lens',
    'Step 3 template (Dimension, Impact, Current State, Recommendation &',
    'Rationale, Agent Prompt). For the Dead Code dimension also return rows',
    'for the Dead Code Inventory table with an estimated LOC per entry.',
  ].join('\n');
}

/**
 * Compose the adversarial cross-check prompt: an independent agent reviews a
 * peer dimension's findings and filters false positives before inclusion.
 *
 * @param {string} dimension
 * @param {string} findings
 * @returns {string}
 */
export function buildCrossCheckPrompt(dimension, findings) {
  return [
    `You are an adversarial reviewer for the "${dimension}" clean-code`,
    'findings below. You are READ-ONLY. For each finding, independently',
    'verify it against the actual code: confirm true positives, DROP false',
    'positives or unsubstantiated claims, and tighten over-broad',
    'recommendations. Preserve the exact `### <title>` field structure for',
    'every finding you keep. At the end, append a single line:',
    '`CROSS-CHECK: kept <k> / dropped <d>` so the synthesis stage can report',
    'how many findings the cross-check filtered out.',
    '',
    '--- FINDINGS UNDER REVIEW ---',
    findings,
    '--- END FINDINGS ---',
  ].join('\n');
}

/**
 * Compose the synthesis prompt that assembles all cross-checked findings into
 * the exact report contract and writes the artifact.
 *
 * @param {string[]} crossCheckedBlocks
 * @param {string} auditOutputDir
 * @returns {string}
 */
export function buildSynthesisPrompt(crossCheckedBlocks, auditOutputDir) {
  const artifactPath = `${auditOutputDir.replace(/\/+$/, '')}/${REPORT_ARTIFACT_BASENAME}`;
  return [
    'Assemble the cross-checked findings below into a single Clean Code Audit',
    'Report and WRITE it (this is the one permitted write in the run) to:',
    `  ${artifactPath}`,
    '',
    `The report MUST open with "# ${REPORT_TITLE}" and contain these "##"`,
    `sections in order: ${REQUIRED_SECTIONS.join(', ')}.`,
    'Place each cross-checked `### <title>` finding under "## Detailed',
    'Findings"; aggregate all dead-code rows into the "## Dead Code',
    'Inventory" table; summarise the maintainability index (High/Medium/Low)',
    'and primary themes in "## Executive Summary"; list heavy-rework modules',
    'in "## Technical Debt Backlog". Sum the per-dimension',
    '`CROSS-CHECK: kept/dropped` lines and note the total dropped count in the',
    'Executive Summary so the benchmark can record cross-check filtering.',
    '',
    '--- CROSS-CHECKED FINDINGS ---',
    crossCheckedBlocks.join('\n\n'),
    '--- END ---',
  ].join('\n');
}

/**
 * The dynamic-workflow entry point. The runtime calls this with a
 * {@link WorkflowContext}. Exported as the default so the runtime can load it
 * and so tests can import the pure prompt-builders above without executing the
 * fan-out.
 *
 * @param {WorkflowContext} ctx
 * @returns {Promise<{ artifact: string, dimensions: number, droppedNote: string }>}
 */
export default async function auditCleanCodeWorkflow(ctx) {
  const { agent, phase, inputs = {} } = ctx;
  const lensSpec = loadLensSpec();
  const scopeClause = buildScopeClause(inputs.changedFiles);
  const auditOutputDir = inputs.auditOutputDir ?? 'temp/audits';

  // Phase 1 — parallel per-dimension analysis (read-only agents).
  const rawFindings = await phase('analyze-dimensions', async () => {
    const results = await Promise.all(
      DIMENSIONS.map(async (dimension) => {
        const { output } = await agent({
          prompt: buildDimensionPrompt(dimension, lensSpec, scopeClause),
          allowedTools: READ_ONLY_TOOLS,
        });
        return { dimension, findings: output };
      }),
    );
    return results;
  });

  // Phase 2 — adversarial cross-check: an independent agent reviews each
  // dimension's findings and filters false positives before inclusion.
  const crossChecked = await phase('adversarial-cross-check', async () => {
    return Promise.all(
      rawFindings.map(async ({ dimension, findings }) => {
        const { output } = await agent({
          prompt: buildCrossCheckPrompt(dimension, findings),
          allowedTools: READ_ONLY_TOOLS,
        });
        return output;
      }),
    );
  });

  // Phase 3 — synthesis: assemble the report contract and write the artifact.
  const { output: report } = await phase('synthesize-report', async () =>
    agent({
      prompt: buildSynthesisPrompt(crossChecked, auditOutputDir),
      // Synthesis is the one stage permitted to write the report artifact.
      allowedTools: [...READ_ONLY_TOOLS, 'Write'],
    }),
  );

  // Self-verify report-contract conformance before returning.
  const check = assertReportContract(report);
  if (!check.conformant) {
    throw new Error(
      `[audit-clean-code.workflow] report failed contract check: missing ${
        check.hasTitle ? '' : 'title; '
      }sections=[${check.missingSections.join(', ')}]`,
    );
  }

  return {
    artifact: `${auditOutputDir.replace(/\/+$/, '')}/${REPORT_ARTIFACT_BASENAME}`,
    dimensions: DIMENSIONS.length,
    droppedNote:
      'See Executive Summary for total findings dropped by cross-check.',
  };
}
