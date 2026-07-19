/**
 * Dynamic-workflow orchestrator for the `audit-performance` lens
 * (Epic #3597, Story #3611).
 *
 * This is a Claude Code **dynamic workflow** script
 * (https://code.claude.com/docs/en/workflows). The runtime executes it in the
 * background, holding the loop and intermediate findings in script variables
 * so only the final report lands in the host LLM's context. It is the
 * *orchestrated* execution path for `audit-performance`; the *sequential*
 * single-pass path remains `.agents/workflows/audit-performance.md`, followed
 * turn-by-turn whenever dynamic workflows are unavailable.
 *
 * ## Why a saved project workflow
 *
 * Saved at `.claude/workflows/` so it is shared with everyone who clones the
 * repo (per the dynamic-workflows doc: a project-saved script is the right
 * home for a shared workflow). It runs as `/audit-performance` when dynamic
 * workflows are enabled.
 *
 * ## Lens markdown stays authoritative
 *
 * This script does NOT fork a second copy of the analysis spec. The
 * per-dimension prompts are *derived from* the lens markdown
 * (`.agents/workflows/audit-performance.md`) at run time via `loadLensSpec()`
 * — the lens remains the single source of truth for *what* to analyse and
 * *the output report shape*. If the lens changes, this orchestrator picks up
 * the change without edits.
 *
 * ## Report contract parity
 *
 * Both paths emit the identical report to
 * `{{auditOutputDir}}/audit-performance-results.md` with the headings defined
 * in `lib/dynamic-workflow/performance-report-contract.js`. The orchestrated
 * path assembles its cross-checked findings into exactly that skeleton and
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
 * lens-specific — the performance dimension list, the per-dimension /
 * cross-check / synthesis prompt builders, the read-only tool allowlist, and
 * the performance report-contract self-check — and delegates the fan-out
 * plumbing to the engine.
 *
 * ## Measurement allowlist (read source, run non-mutating measurements)
 *
 * The lens is read-only **with respect to source** — the engine grants the
 * analysis agents no write/edit tools and no source-mutating shell. But this
 * lens must *measure* before it judges (the lens Step 0), so instead of
 * stripping execution entirely it grants a `Bash` tool restricted to the
 * {@link MEASUREMENT_COMMAND_ALLOWLIST}: profilers, timers, and size probes
 * that read the repo's own numbers without mutating source, installing
 * packages, or touching git/labels. The analysis agents receive
 * {@link MEASUREMENT_TOOLS} (`Read`, `Grep`, `Glob`, `Bash`); the allowlist
 * itself is embedded in every dimension prompt so the agent knows exactly which
 * commands it may run. The single source *write* in the run is the final report
 * artifact, performed by the synthesis stage.
 *
 * ## Scope parity
 *
 * Honours the lens's `## Scope (Story / plan-run mode)` `{{changedFiles}}`
 * contract: when `inputs.changedFiles` is a non-empty newline-delimited
 * list (a scoped run) the scan is restricted to those files; otherwise
 * it is a full codebase-wide scan, identical to a manual
 * `/audit-performance`.
 *
 * The live dynamic-workflow runtime context (`agent` + `phase`) is the
 * canonical `WorkflowContext` typedef re-exported from the shared engine, so
 * this lens and every other lens reference one shape rather than each
 * re-declaring (and drifting from) the runtime contract. The lens-specific
 * `inputs` keys this entry point reads are documented by {@link PerformanceInputs}.
 *
 * @typedef {import('../../.agents/scripts/lib/dynamic-workflow/audit-orchestrator.js').WorkflowContext} WorkflowContext
 *
 * @typedef {object} PerformanceInputs
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
} from '../../.agents/scripts/lib/dynamic-workflow/performance-report-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const LENS_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'audit-performance.md',
);

/**
 * The orthogonal analysis dimensions the lens decomposes into. These map 1:1
 * onto the lens's Step 2 "Analysis dimensions (orthogonal set)": the four
 * resource dimensions plus the interleaving/partial-failure correctness
 * dimension. Each fans out to its own subagent so they run in parallel and can
 * be cross-checked independently. The historically overlapping ten dimensions
 * (Latency / Throughput / Efficiency / Scalability / …) collapsed into these —
 * Step 1 of the lens gates the web-only "Payload & bundle" dimension by repo
 * profile.
 */
export const DIMENSIONS = Object.freeze([
  'CPU & algorithmic hot paths',
  'I/O & syscall efficiency',
  'Memory & leaks',
  'Payload & bundle (web only)',
  'Interleaving & partial-failure correctness',
]);

/**
 * Read/search tool allowlist for analysis agents — no write/edit, no shell.
 * The measurement agents additionally receive `Bash` (see
 * {@link MEASUREMENT_TOOLS}) constrained to {@link MEASUREMENT_COMMAND_ALLOWLIST}.
 */
export const READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);

/**
 * The restricted, **non-mutating** shell command allowlist granted to the
 * measurement agents. Each entry is a command prefix the agent may run to
 * produce the Step 0 evidence every finding must cite. The set is deliberately
 * narrow: profilers, timers, and size/stat probes that read the repo's own
 * numbers. It grants nothing that writes source, installs dependencies, or
 * mutates git refs / issue labels.
 *
 * The distinction the lens turns on: this list replaces the old
 * "strip execution entirely" posture — the agent can now *measure*, but only
 * with these commands.
 */
export const MEASUREMENT_COMMAND_ALLOWLIST = Object.freeze([
  'hyperfine', // stable multi-run timing statistics
  'time', // /usr/bin/time -v fallback timing + RSS
  'node --cpu-prof', // V8 sampling profiler on an entry script
  'node --prof', // legacy V8 profiler
  'npm test', // time the repo's own suite (non-mutating to source)
  'npm run test', // suite alias
  'npx vite build --profile', // web bundle stats
  'du', // directory / artifact size
  'wc', // byte counts
  'find', // enumerate + size shipped assets
  'ls', // list build output
  'stat', // file size / mtime probe
  'cat', // read a profile / stats file
  'git log', // read-only history (churn on a hot path)
  'git diff', // read-only diff (never a mutation)
]);

/**
 * The tool allowlist granted to the measurement (analysis) and cross-check
 * agents: the read/search tools plus `Bash`. `Bash` is only useful in concert
 * with {@link MEASUREMENT_COMMAND_ALLOWLIST}, which every dimension prompt
 * embeds so the agent stays inside the non-mutating set.
 */
export const MEASUREMENT_TOOLS = Object.freeze([...READ_ONLY_TOOLS, 'Bash']);

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
    return 'SCOPE: No scope filter — analyse the full codebase, exactly as a manual /audit-performance run.';
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
    `You are auditing the codebase for the "${dimension}" performance`,
    'dimension only.',
    'You do NOT edit, create, or delete source. You MAY run measurements, but',
    'ONLY these non-mutating commands (Step 0 of the lens spec):',
    ...MEASUREMENT_COMMAND_ALLOWLIST.map((cmd) => `  - ${cmd}`),
    'Any other shell command is out of bounds — never install, write source,',
    'or mutate git refs / issue labels. Every finding you return MUST carry an',
    'Evidence field naming the repro command above whose output produced it,',
    'tagged `measured` or `estimated`.',
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
    'Step 4 template (Dimension, Impact, Location, Evidence, Current State,',
    'Recommendation & Rationale, Acceptance signal, Agent Prompt). Where the',
    'bottleneck has a cheap, immediate remediation, also note it as a',
    'candidate quick win so the synthesis stage can populate the',
    '"Low-Hanging Fruit" section.',
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
    `You are an adversarial reviewer for the "${dimension}" performance`,
    'findings below. You are READ-ONLY. For each finding, independently',
    'verify it against the actual code: confirm true positives, DROP false',
    'positives or unsubstantiated claims (e.g. a "bottleneck" on a cold',
    'path that never runs under load), and tighten over-broad',
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
    'Assemble the cross-checked findings below into a single Performance',
    'Audit Report and WRITE it (this is the one permitted write in the run)',
    'to:',
    `  ${artifactPath}`,
    '',
    `The report MUST open with "# ${REPORT_TITLE}" and contain these "##"`,
    `sections in order: ${REQUIRED_SECTIONS.join(', ')}.`,
    'Place each cross-checked `### <title>` finding under "## Detailed',
    'Findings", preserving its Evidence field (repro command + measured/',
    'estimated tag) verbatim; summarise overall performance posture vs the',
    'Step 0 measurements, the detected repo profile, and the baseline trend',
    'verdict in "## Executive Summary"; and list 3 quick',
    'changes that provide immediate performance gains under "## Low-Hanging',
    'Fruit". Sum the per-dimension `CROSS-CHECK: kept/dropped` lines and note',
    'the total dropped count in the Executive Summary so the benchmark can',
    'record cross-check filtering.',
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
 * {@link runAuditOrchestration} engine; this function binds the performance
 * lens-specific arguments (lens spec, scope clause, output dir) into the
 * engine's prompt-builder contract and supplies the performance report
 * self-check.
 *
 * @param {WorkflowContext & { inputs?: PerformanceInputs }} ctx
 * @returns {Promise<{ artifact: string, dimensions: number, droppedNote: string }>}
 */
export default async function auditPerformanceWorkflow(ctx) {
  const { inputs = {} } = ctx;
  const lensSpec = loadLensSpec();
  const scopeClause = buildScopeClause(inputs.changedFiles);
  const auditOutputDir = inputs.auditOutputDir ?? 'temp/audits';
  const artifact = `${auditOutputDir.replace(/\/+$/, '')}/${REPORT_ARTIFACT_BASENAME}`;

  await runAuditOrchestration({
    ctx,
    dimensions: DIMENSIONS,
    readOnlyTools: MEASUREMENT_TOOLS,
    buildDimensionPrompt: (dimension) =>
      buildDimensionPrompt(dimension, lensSpec, scopeClause),
    buildCrossCheckPrompt,
    buildSynthesisPrompt: (crossCheckedBlocks) =>
      buildSynthesisPrompt(crossCheckedBlocks, auditOutputDir),
    assertReportContract,
    formatContractError: (check) =>
      `[audit-performance.workflow] report failed contract check: missing ${
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
