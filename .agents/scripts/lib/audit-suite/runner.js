/**
 * `runAuditSuite`: owns the audit envelope shape (`metadata`, `findings`,
 * `workflows`) and the per-audit fan-out; invoked via the barrel.
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
 * Resolve registered audit workflows into slim descriptors; with
 * `artifactPrefix`, full bodies are written to disk instead of travelling in
 * the envelope. Substitution keys beyond the built-ins must be declared as
 * `substitutionKeys` in audit-rules.json, else ValidationError.
 *
 * @param {object} opts
 * @param {string[]} opts.auditWorkflows
 * @param {Record<string,string>} [opts.substitutions]
 * @param {string} [opts.artifactPrefix] - writes `audit-<prefix>-<audit>.md`.
 * @param {string} [opts.artifactsDir] - defaults to `<auditOutputDir>`.
 * @param {Function} [opts.injectedLoadWorkflow]
 * @param {object} [opts.injectedRules]
 * @param {Function} [opts.injectedWriteArtifact]
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
