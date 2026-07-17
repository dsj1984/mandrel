/**
 * Dynamic-workflow orchestrator for the `audit-security` lens
 * (Epic #3597, Story #3613).
 *
 * This is a Claude Code **dynamic workflow** script
 * (https://code.claude.com/docs/en/workflows). The runtime executes it in the
 * background, holding the loop and intermediate findings in script variables
 * so only the final report lands in the host LLM's context. It is the
 * *orchestrated* execution path for `audit-security`; the *sequential*
 * single-pass path remains `.agents/workflows/audit-security.md`, followed
 * turn-by-turn whenever dynamic workflows are unavailable.
 *
 * ## Why a saved project workflow
 *
 * Saved at `.claude/workflows/` so it is shared with everyone who clones the
 * repo (per the dynamic-workflows doc: a project-saved script is the right
 * home for a shared workflow). It runs as `/audit-security` when dynamic
 * workflows are enabled.
 *
 * ## Lens markdown stays authoritative
 *
 * This script does NOT fork a second copy of the analysis spec. The
 * per-dimension prompts are *derived from* the lens markdown
 * (`.agents/workflows/audit-security.md`) at run time via `loadLensSpec()` —
 * the lens remains the single source of truth for *what* to analyse and *the
 * output report shape*. If the lens changes, this orchestrator picks up the
 * change without edits.
 *
 * ## Report contract parity
 *
 * Both paths emit the identical report to
 * `{{auditOutputDir}}/audit-security-results.md` with the headings defined in
 * `lib/dynamic-workflow/security-report-contract.js`. The orchestrated path
 * assembles its cross-checked findings into exactly that skeleton and
 * self-verifies with `assertReportContract` before writing, so downstream
 * consumers (`audit-to-stories`) cannot
 * tell which path produced the report.
 *
 * ## Shared orchestration engine
 *
 * The three-phase fan-out (parallel per-dimension analysis → adversarial
 * cross-check → synthesis + report-contract self-check) is **not** inlined
 * here. It lives once in
 * `lib/dynamic-workflow/audit-orchestrator.js` (`runAuditOrchestration`) and
 * is shared by every audit lens. This workflow declares only what is
 * lens-specific — the security dimension list, the per-dimension /
 * cross-check / synthesis prompt builders, the read-only tool allowlist, and
 * the security report-contract self-check — and delegates the fan-out
 * plumbing to the engine.
 *
 * ## Read-only guarantee
 *
 * The lens is read-only. Dynamic-workflow subagents run in `acceptEdits` and
 * inherit the session tool allowlist, but the engine grants the analysis
 * agents NO write/edit/shell-mutation tools — they receive only read/search
 * tools (`Read`, `Grep`, `Glob`). The single write in the run is the final
 * report artifact, performed by the synthesis stage.
 *
 * ## Scope parity
 *
 * Honours the lens's `## Scope (Story / plan-run mode)` `{{changedFiles}}`
 * contract: when `inputs.changedFiles` is a non-empty newline-delimited
 * list (a scoped run) the scan is restricted to those files; otherwise
 * it is a full codebase-wide scan, identical to a manual
 * `/audit-security`.
 *
 * The live dynamic-workflow runtime context (`agent` + `phase`) is the
 * canonical `WorkflowContext` typedef re-exported from the shared engine, so
 * this lens and every future lens reference one shape rather than each
 * re-declaring (and drifting from) the runtime contract. The lens-specific
 * `inputs` keys this entry point reads are documented by {@link SecurityInputs}.
 *
 * @typedef {import('../../.agents/scripts/lib/dynamic-workflow/audit-orchestrator.js').WorkflowContext} WorkflowContext
 *
 * @typedef {object} SecurityInputs
 * @property {string} [changedFiles]  Scoped-run change-set list (newline-delimited).
 * @property {string} [auditOutputDir] Resolved audit output dir.
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
} from '../../.agents/scripts/lib/dynamic-workflow/security-report-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const LENS_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'audit-security.md',
);

/**
 * The independent analysis dimensions the lens decomposes into. These names
 * map 1:1 onto the lens's Step 1 "Vulnerability Surface Analysis" bullets and
 * Step 2 "Evaluation Dimensions"; each fans out to its own subagent so they
 * run in parallel and can be cross-checked independently.
 */
const DIMENSIONS = Object.freeze([
  'Injection',
  'Broken Access Control',
  'Cryptographic Failures',
  'Security Misconfiguration',
  'Vulnerable Components',
  'Secret Management',
  'Authentication & Session Handling',
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
    return 'SCOPE: No scope filter — analyse the full codebase, exactly as a manual /audit-security run.';
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
    `You are auditing the codebase for the "${dimension}" security dimension only.`,
    'You are READ-ONLY: do not edit, create, or run mutating commands, and',
    'do not attempt to exploit the system.',
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
    'Step 3 template (Dimension, Severity, CWE ID, Current State,',
    'Recommendation & Rationale, Agent Prompt). Assign each finding a',
    'severity of Critical, High, Medium, or Low and cite the matching CWE ID',
    'where one applies.',
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
    `You are an adversarial reviewer for the "${dimension}" security`,
    'findings below. You are READ-ONLY. For each finding, independently',
    'verify it against the actual code: confirm true positives, DROP false',
    'positives or unsubstantiated claims, and right-size the severity and',
    'recommendation. Preserve the exact `### <title>` field structure for',
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
    'Assemble the cross-checked findings below into a single Security Audit',
    'Report and WRITE it (this is the one permitted write in the run) to:',
    `  ${artifactPath}`,
    '',
    `The report MUST open with "# ${REPORT_TITLE}" and contain these "##"`,
    `sections in order: ${REQUIRED_SECTIONS.join(', ')}.`,
    'Place each cross-checked `### <title>` finding under "## Detailed',
    'Findings"; summarise the overall risk profile (Critical/High/Medium/Low)',
    'and security posture in "## Executive Summary"; list 3-5 hardening',
    'measures (security headers, configurations, libraries) in "## Defensive',
    'Recommendations". Sum the per-dimension `CROSS-CHECK: kept/dropped` lines',
    'and note the total dropped count in the Executive Summary so the',
    'benchmark can record cross-check filtering.',
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
 * The three-phase fan-out itself lives in the shared
 * {@link runAuditOrchestration} engine; this function binds the security
 * lens-specific arguments (lens spec, scope clause, output dir) into the
 * engine's prompt-builder contract and supplies the security report
 * self-check.
 *
 * @param {WorkflowContext & { inputs?: SecurityInputs }} ctx
 * @returns {Promise<{ artifact: string, dimensions: number, droppedNote: string }>}
 */
export default async function auditSecurityWorkflow(ctx) {
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
      buildSynthesisPrompt(crossCheckedBlocks, auditOutputDir),
    assertReportContract,
    formatContractError: (check) =>
      `[audit-security.workflow] report failed contract check: missing ${
        check.hasTitle ? '' : 'title; '
      }sections=[${check.missingSections.join(', ')}]`,
  });

  return {
    artifact,
    dimensions: DIMENSIONS.length,
    droppedNote:
      'See Executive Summary for total findings dropped by cross-check.',
  };
}
