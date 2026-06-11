/**
 * Dynamic-workflow orchestrator for the `audit-documentation` lens
 * (Story #4024).
 *
 * This is a Claude Code **dynamic workflow** script
 * (https://code.claude.com/docs/en/workflows). The runtime executes it in the
 * background, holding the loop and intermediate findings in script variables
 * so only the final report lands in the host LLM's context. It is the
 * *orchestrated* execution path for `audit-documentation`; the *sequential*
 * single-pass path remains `.agents/workflows/audit-documentation.md`,
 * followed turn-by-turn whenever dynamic workflows are unavailable.
 *
 * ## Lens markdown stays authoritative
 *
 * This script does NOT fork a second copy of the analysis spec. The
 * per-dimension prompts are *derived from* the lens markdown
 * (`.agents/workflows/audit-documentation.md`) at run time via
 * `loadLensSpec()` — the lens remains the single source of truth for the
 * target-set union, the claim taxonomy, and the output report shape. If the
 * lens changes, this orchestrator picks up the change without edits.
 *
 * ## Deterministic gates run in the calling session
 *
 * The lens's Step 1 deterministic checkers (`check-doc-links.js`,
 * `check-lifecycle-doc-drift.js`, the generators' `--check` mode) require
 * shell execution, which the read-only analysis subagents do not have. The
 * calling session runs them and passes the resulting finding blocks as the
 * `deterministicFindings` input; the synthesis stage folds them into the
 * report alongside the verified semantic findings.
 *
 * ## Adversarial verify stage
 *
 * Documentation-staleness findings are notoriously false-positive-prone, so
 * the cross-check stage here is an *adversarial verifier*: an independent
 * agent re-checks every stale-claim finding against the current code and
 * DROPS any claim it cannot reproduce.
 *
 * ## Report contract parity
 *
 * Both paths emit the identical report to
 * `{{auditOutputDir}}/audit-documentation-results.md` with the headings
 * defined in `lib/dynamic-workflow/documentation-report-contract.js`. The
 * orchestrated path assembles its verified findings into exactly that
 * skeleton and self-verifies with `assertReportContract` before writing, so
 * downstream consumers (`/deliver` Phase 4 epic-audit,
 * `audit-to-stories`) cannot tell which path produced the report.
 *
 * ## Shared orchestration engine
 *
 * The three-phase fan-out (parallel per-dimension analysis → adversarial
 * verify → synthesis + report-contract self-check) lives once in
 * `lib/dynamic-workflow/audit-orchestrator.js` (`runAuditOrchestration`).
 * This workflow declares only what is lens-specific.
 *
 * ## Read-only guarantee
 *
 * The lens is read-only. The engine grants the analysis agents only
 * read/search tools (`Read`, `Grep`, `Glob`); the single write in the run is
 * the final report artifact, performed by the synthesis stage.
 *
 * The live dynamic-workflow runtime context (`agent` + `phase`) is the
 * canonical `WorkflowContext` typedef re-exported from the shared engine.
 * The lens-specific `inputs` keys this entry point reads are documented by
 * {@link DocumentationInputs}.
 *
 * @typedef {import('../../.agents/scripts/lib/dynamic-workflow/audit-orchestrator.js').WorkflowContext} WorkflowContext
 *
 * @typedef {object} DocumentationInputs
 * @property {string} [changedFiles]  Epic-mode change-set list (newline-delimited).
 * @property {string} [auditOutputDir] Resolved audit output dir.
 * @property {string} [deterministicFindings] Pre-rendered Step 1 finding
 *   blocks from the calling session's deterministic-checker run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAuditOrchestration } from '../../.agents/scripts/lib/dynamic-workflow/audit-orchestrator.js';
import {
  assertReportContract,
  REPORT_ARTIFACT_BASENAME,
  REPORT_TITLE,
  REQUIRED_SECTIONS,
} from '../../.agents/scripts/lib/dynamic-workflow/documentation-report-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const LENS_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'audit-documentation.md',
);

/**
 * The independent analysis dimensions the lens decomposes into. These names
 * map 1:1 onto the lens's Step 2 "Semantic Claim Verification &
 * Completeness" items; each fans out to its own subagent — which walks the
 * full target set per doc for its dimension — so they run in parallel and
 * can be adversarially verified independently.
 */
const DIMENSIONS = Object.freeze([
  'Command & Script References',
  'Path & Module References',
  'Workflow & Contract Descriptions',
  'Version & Topology Claims',
  'Completeness',
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
    return 'SCOPE: No scope filter — audit the full config-driven target set, exactly as a manual /audit-documentation run.';
  }
  return [
    'SCOPE: Restrict analysis to the intersection of the target set and the',
    'following changed files (plus any target-set doc whose claims describe',
    'code in this change set):',
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
    `You are auditing the repository's documentation for the "${dimension}" dimension only.`,
    'You are READ-ONLY: do not edit, create, or run mutating commands, and',
    'do not run the deterministic checker scripts (the calling session owns',
    'those).',
    '',
    scopeClause,
    '',
    'Authoritative lens specification (the single source of truth for the',
    'target-set union, the generated-doc exclusions, and how to phrase',
    'findings):',
    '',
    '--- BEGIN LENS SPEC ---',
    lensSpec,
    '--- END LENS SPEC ---',
    '',
    `Return ONLY the findings for the "${dimension}" dimension, each as a`,
    '`### <Short Title>` block using the exact field structure from the lens',
    'Step 3 template (Category, Impact, Current State, Recommendation &',
    'Rationale, Agent Prompt). Set Category to one of Broken Instruction,',
    'Stale Description, or Missing Coverage, and Impact to High, Medium, or',
    'Low. Cite the doc claim AND the code reality (file paths) in Current',
    'State so the verifier can reproduce the check.',
  ].join('\n');
}

/**
 * Compose the adversarial verify prompt: an independent agent re-checks each
 * stale-claim finding against the current code and drops claims it cannot
 * reproduce.
 *
 * @param {string} dimension
 * @param {string} findings
 * @returns {string}
 */
export function buildCrossCheckPrompt(dimension, findings) {
  return [
    `You are an adversarial verifier for the "${dimension}" documentation`,
    'findings below. You are READ-ONLY. Doc-staleness findings are',
    'false-positive-prone: for each finding, independently re-check the',
    "claimed drift against the actual current code. DROP any 'stale' claim",
    'you cannot reproduce, confirm true positives, and right-size the impact',
    'and recommendation. Preserve the exact `### <title>` field structure',
    'for every finding you keep. At the end, append a single line:',
    '`CROSS-CHECK: kept <k> / dropped <d>` so the synthesis stage can report',
    'how many findings the verify stage filtered out.',
    '',
    '--- FINDINGS UNDER REVIEW ---',
    findings,
    '--- END FINDINGS ---',
  ].join('\n');
}

/**
 * Compose the synthesis prompt that assembles the deterministic findings and
 * all verified semantic findings into the exact report contract and writes
 * the artifact.
 *
 * @param {string[]} crossCheckedBlocks
 * @param {string} auditOutputDir
 * @param {string} [deterministicFindings]
 * @returns {string}
 */
export function buildSynthesisPrompt(
  crossCheckedBlocks,
  auditOutputDir,
  deterministicFindings = '',
) {
  const artifactPath = `${auditOutputDir.replace(/\/+$/, '')}/${REPORT_ARTIFACT_BASENAME}`;
  return [
    'Assemble the deterministic-gate findings and the verified semantic',
    'findings below into a single Documentation Audit Report and WRITE it',
    '(this is the one permitted write in the run) to:',
    `  ${artifactPath}`,
    '',
    `The report MUST open with "# ${REPORT_TITLE}" and contain these "##"`,
    `sections in order: ${REQUIRED_SECTIONS.join(', ')}.`,
    'Place each `### <title>` finding under "## Detailed Findings"; render',
    'the per-doc table (Doc / Source / Verdict) under "## Target Set',
    'Coverage"; summarise documentation health, the deterministic-gate',
    'verdicts, and primary drift themes in "## Executive Summary". Sum the',
    'per-dimension `CROSS-CHECK: kept/dropped` lines and note the total',
    'dropped count in the Executive Summary so the benchmark can record',
    'verify-stage filtering.',
    '',
    '--- DETERMINISTIC-GATE FINDINGS (Step 1, pre-verified) ---',
    deterministicFindings.trim().length > 0
      ? deterministicFindings
      : '(none reported by the calling session)',
    '--- END DETERMINISTIC-GATE FINDINGS ---',
    '',
    '--- VERIFIED SEMANTIC FINDINGS ---',
    crossCheckedBlocks.join('\n\n'),
    '--- END ---',
  ].join('\n');
}

/**
 * The dynamic-workflow entry point. The runtime calls this with a
 * {@link WorkflowContext}. Exported as the default so the runtime can load it
 * and so tests can import the pure prompt-builders above without executing
 * the fan-out.
 *
 * @param {WorkflowContext & { inputs?: DocumentationInputs }} ctx
 * @returns {Promise<{ artifact: string, dimensions: number, droppedNote: string }>}
 */
export default async function auditDocumentationWorkflow(ctx) {
  const { inputs = {} } = ctx;
  const lensSpec = loadLensSpec();
  const scopeClause = buildScopeClause(inputs.changedFiles);
  const auditOutputDir = inputs.auditOutputDir ?? 'temp/audits';
  const artifact = `${auditOutputDir.replace(/\/+$/, '')}/${REPORT_ARTIFACT_BASENAME}`;

  await runAuditOrchestration({
    ctx,
    dimensions: DIMENSIONS,
    readOnlyTools: READ_ONLY_TOOLS,
    buildDimensionPrompt: (dimension) =>
      buildDimensionPrompt(dimension, lensSpec, scopeClause),
    buildCrossCheckPrompt,
    buildSynthesisPrompt: (crossCheckedBlocks) =>
      buildSynthesisPrompt(
        crossCheckedBlocks,
        auditOutputDir,
        inputs.deterministicFindings,
      ),
    assertReportContract,
    formatContractError: (check) =>
      `[audit-documentation.workflow] report failed contract check: missing ${
        check.hasTitle ? '' : 'title; '
      }sections=[${check.missingSections.join(', ')}]`,
  });

  return {
    artifact,
    dimensions: DIMENSIONS.length,
    droppedNote:
      'See Executive Summary for total findings dropped by the verify stage.',
  };
}
