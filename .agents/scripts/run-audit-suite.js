#!/usr/bin/env node

/* node:coverage ignore file */

/**
 * run-audit-suite.js — CLI + SDK for running a list of audit workflows.
 *
 * Successor to the retired mandrel MCP tools. See ADR 20260424-702a in
 * docs/decisions.md for the migration table.
 *
 * Story #963 (Epic #946) decomposed the previous ~445 LOC monolith (MI=0.0)
 * into focused helpers under `lib/audit-suite/`:
 *   - frontmatter.js     — `extractFrontmatter` + summary derivation
 *   - substitutions.js   — `{{key}}` templating + CLI implicit defaults
 *   - workflow-loader.js — filesystem IO for workflow markdown + artifacts
 *   - findings.js        — severity histogram aggregation
 *   - cli.js             — `parseAuditList`, `parseArgv`, HELP banner
 *   - runner.js          — `runAuditSuite` aggregation core
 *
 * This file is the pipeline entry-point: it parses argv, glues the
 * helpers together, writes the JSON envelope to stdout, and re-exports the
 * symbols that downstream callers (`audit-orchestrator.js` and the test
 * suite) already import from this path.
 *
 * Usage:
 *   node .agents/scripts/run-audit-suite.js \
 *     --audits <comma-list> [--ticket <id>] [--base-branch main] \
 *     [--substitution key=value]...
 *
 * Output: a single JSON object on stdout matching the MCP envelope:
 *   { metadata: { ... }, findings: [...], workflows: [...] }
 *
 * Exit codes:
 *   0 — suite completed (findings entries are not failures)
 *   non-zero — argument or substitution validation failure (error on stderr)
 */

import { HELP, parseArgv, parseAuditList } from './lib/audit-suite/cli.js';
import { runAuditSuite } from './lib/audit-suite/runner.js';
import {
  applyImplicitSubstitutions,
  parseSubstitutionPairs,
} from './lib/audit-suite/substitutions.js';
import { runAsCli } from './lib/cli-utils.js';

export { parseArgv, parseAuditList } from './lib/audit-suite/cli.js';
export { aggregateSummary } from './lib/audit-suite/findings.js';
export {
  extractFrontmatter,
  summarizeWorkflow,
} from './lib/audit-suite/frontmatter.js';
// --- Re-exports preserved for back-compat with existing import sites ---
// `audit-orchestrator.js` and the test suite import these from
// `run-audit-suite.js`. Keep them re-exported here so the decomposition
// is internal-only.
export { runAuditSuite } from './lib/audit-suite/runner.js';
export {
  applyImplicitSubstitutions,
  applySubstitutions,
} from './lib/audit-suite/substitutions.js';

function abort(message, code = 2) {
  process.stderr.write(message);
  process.exit(code);
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (!values.audits) {
    abort(`[run-audit-suite] --audits <comma-list> is required.\n${HELP}`);
  }

  const auditWorkflows = parseAuditList(values.audits);
  if (auditWorkflows.length === 0) {
    abort(
      `[run-audit-suite] --audits must contain at least one workflow name.\n`,
    );
  }

  const substitutions = parseSubstitutionPairs(values.substitution);
  applyImplicitSubstitutions(values, substitutions);

  const result = await runAuditSuite({
    auditWorkflows,
    substitutions,
    artifactPrefix: values.runId,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

runAsCli(import.meta.url, main, { source: 'run-audit-suite' });
