/**
 * lib/audit-suite/runner.js — `runAuditSuite` aggregation core.
 *
 * Extracted from the former `run-audit-suite.js` CLI (Story #963, Epic #946;
 * the CLI wrapper itself was retired in #4482 — `runAuditSuite` via the
 * barrel is the only supported entry point).
 *
 * The runner composes the focused helpers from this directory:
 *   - frontmatter.js     → `summarizeWorkflow`
 *   - substitutions.js   → `applySubstitutions`, `computeAllowedKeys`
 *   - findings.js        → `aggregateSummary`
 *   - workflow-loader.js → `loadWorkflow`, `defaultWriteArtifact`
 *
 * It owns the audit envelope shape (`metadata`, `findings`, `workflows`) and
 * the per-audit fan-out + result reduction. The former CLI entry-point
 * (`run-audit-suite.js`) was retired in #4482; callers invoke
 * `runAuditSuite` via the `lib/audit-suite/index.js` barrel.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getPaths, PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { ValidationError } from '../errors/index.js';
import { aggregateSummary } from './findings.js';
import { summarizeWorkflow } from './frontmatter.js';
import { applySubstitutions, computeAllowedKeys } from './substitutions.js';
import { defaultWriteArtifact, loadWorkflow } from './workflow-loader.js';

async function loadRules(paths) {
  const rulesPath = path.join(
    PROJECT_ROOT,
    paths.schemasRoot,
    'audit-rules.json',
  );
  const rulesContent = await fs.readFile(rulesPath, 'utf8');
  return JSON.parse(rulesContent);
}

function rejectUnknownKeys(allowedKeys, callerSubstitutions) {
  const unknownKeys = Object.keys(callerSubstitutions).filter(
    (k) => !allowedKeys.has(k),
  );
  if (unknownKeys.length === 0) return;
  const allowedList = [...allowedKeys].sort().join(', ');
  throw new ValidationError(
    `Unknown substitution key(s): ${unknownKeys.join(', ')}. Allowed for this call: ${allowedList}.`,
    { unknownKeys, allowedKeys: [...allowedKeys] },
  );
}

function emptyEnvelope(auditWorkflows) {
  return {
    metadata: {
      timestamp: new Date().toISOString(),
      auditsRequested: auditWorkflows,
      auditsRun: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
    },
    findings: [],
    workflows: [],
  };
}

function notDefinedFinding(auditName) {
  return {
    error: true,
    finding: {
      audit: auditName,
      severity: 'low',
      message: `Requested audit workflow '${auditName}' is not defined in audit-rules.json.`,
    },
  };
}

function notFoundFinding(auditName) {
  return {
    error: true,
    finding: {
      audit: auditName,
      severity: 'low',
      message: `Audit workflow '${auditName}.md' not found in workflows directory.`,
    },
  };
}

async function processAudit({
  auditName,
  validAudits,
  loader,
  workflowsDir,
  effectiveSubstitutions,
}) {
  if (!validAudits.includes(auditName)) {
    return notDefinedFinding(auditName);
  }

  const workflow = await loader(auditName, workflowsDir);
  if (!workflow) {
    return notFoundFinding(auditName);
  }

  const substituted = applySubstitutions(
    workflow.content,
    effectiveSubstitutions,
  );

  return {
    success: true,
    auditName,
    workflowPath: workflow.path ?? null,
    workflowContent: substituted,
    summary: summarizeWorkflow(workflow.content),
    byteSize: Buffer.byteLength(substituted, 'utf8'),
  };
}

async function reduceResults({
  results,
  envelope,
  artifactPrefix,
  effectiveArtifactsDir,
  writeArtifact,
}) {
  for (const result of results) {
    if (result.error) {
      envelope.findings.push(result.finding);
      continue;
    }
    if (!result.success) continue;

    envelope.metadata.auditsRun.push(result.auditName);
    let artifactPath = null;
    if (artifactPrefix) {
      const fileName = `audit-${artifactPrefix}-${result.auditName}.md`;
      artifactPath = await writeArtifact(
        effectiveArtifactsDir,
        fileName,
        result.workflowContent,
      );
    }
    envelope.workflows.push({
      audit: result.auditName,
      path: result.workflowPath,
      summary: result.summary,
      byteSize: result.byteSize,
      artifactPath,
    });
  }
}

/**
 * Run a suite of named audit workflows.
 *
 * For each audit name the suite will:
 *   1. Validate it is registered in audit-rules.json.
 *   2. Locate the corresponding `.agents/workflows/<auditName>.md` file.
 *   3. Return a slim `workflow` descriptor (audit name, source path, summary,
 *      byte size) for the calling AI agent. Full prompt bodies are written to
 *      `<auditOutputDir>/audit-<runId>-<audit>.md` (resolved from
 *      `project.paths.tempRoot`, default `temp/audits/`) when `artifactPrefix`
 *      (or `runId`) is provided, so downstream agents can read them locally
 *      without bloating the GitHub comment surface.
 *
 * Substitutions: callers may pass a `substitutions` map of `{{key}}` → value
 * pairs. Allowed keys are the built-ins (auditOutputDir, ticketId, baseBranch,
 * changedFiles) plus any `substitutionKeys` declared on the requested audits in
 * audit-rules.json, aggregated across auditWorkflows. Unknown keys
 * raise a ValidationError.
 *
 * @param {object} opts
 * @param {string[]} opts.auditWorkflows - List of audit names to run.
 * @param {Record<string,string>} [opts.substitutions] - Optional template substitutions.
 * @param {string} [opts.artifactPrefix] - When set, write full bodies to
 *   `<artifactsDir>/audit-<artifactPrefix>-<audit>.md`.
 * @param {string} [opts.artifactsDir] - Override the artifacts directory
 *   (default: `<PROJECT_ROOT>/<auditOutputDir>`, which resolves to
 *   `<tempRoot>/audits` — `temp/audits` with default config).
 * @param {Function} [opts.injectedLoadWorkflow] - Optional override for testing.
 * @param {object} [opts.injectedRules] - Optional override for the audit-rules content (testing).
 * @param {Function} [opts.injectedWriteArtifact] - Optional override for filesystem-free testing.
 * @returns {Promise<object>} Aggregated audit results.
 */
export async function runAuditSuite({
  auditWorkflows,
  substitutions,
  artifactPrefix,
  artifactsDir,
  injectedLoadWorkflow,
  injectedRules,
  injectedWriteArtifact,
}) {
  const config = resolveConfig();
  const paths = getPaths(config);
  const callerSubstitutions = substitutions ?? {};
  const rules = injectedRules ?? (await loadRules(paths));

  const allowedKeys = computeAllowedKeys(rules, auditWorkflows);
  rejectUnknownKeys(allowedKeys, callerSubstitutions);

  const effectiveSubstitutions = {
    auditOutputDir: paths.auditOutputDir,
    ...callerSubstitutions,
  };

  const validAudits = Object.keys(rules.audits || {});
  const envelope = emptyEnvelope(auditWorkflows);
  const workflowsDir = path.join(PROJECT_ROOT, paths.workflowsRoot);
  const effectiveArtifactsDir =
    artifactsDir ?? path.join(PROJECT_ROOT, paths.auditOutputDir);
  const writeArtifact = injectedWriteArtifact ?? defaultWriteArtifact;
  const loader = injectedLoadWorkflow ?? loadWorkflow;

  const results = await Promise.all(
    auditWorkflows.map((auditName) =>
      processAudit({
        auditName,
        validAudits,
        loader,
        workflowsDir,
        effectiveSubstitutions,
      }),
    ),
  );

  await reduceResults({
    results,
    envelope,
    artifactPrefix,
    effectiveArtifactsDir,
    writeArtifact,
  });

  envelope.metadata.summary = aggregateSummary(envelope.findings);
  return envelope;
}
