#!/usr/bin/env node

/**
 * resolve-plan-run.js — resolve Stories labeled `plan-run::<id>` for
 * `/deliver --run <planRunId>` (v2 Stage 4).
 *
 * Thin CLI over `lib/orchestration/resolve-plan-run.js`.
 *
 * Usage:
 *   node .agents/scripts/resolve-plan-run.js --run <planRunId>
 *   node .agents/scripts/resolve-plan-run.js --run <planRunId> --state all
 *   node .agents/scripts/resolve-plan-run.js --run <planRunId> --pretty
 *
 * Exit codes: 0 ok, 1 usage/error, 2 no Stories found for the run.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import {
  assertIssueState,
  buildPlanRunEnvelope,
  fetchPlanRunIssues,
  normalizePlanRunLabel,
  planRunIdFromLabel,
  resolvePlanRunFromIssues,
} from './lib/orchestration/resolve-plan-run.js';
import { createProvider } from './lib/provider-factory.js';

export {
  buildPlanRunEnvelope,
  fetchPlanRunIssues,
  normalizePlanRunLabel,
  planRunIdFromLabel,
  resolvePlanRunFromIssues,
};

const HELP = `\
Usage:
  resolve-plan-run.js --run <planRunId> [--state open|all|closed] [--pretty]

Resolve Stories labeled plan-run::<planRunId> for /deliver --run.

Options:
  --run <id>     Plan-run token (with or without the plan-run:: prefix).
  --state <s>    Issue state filter (default: open).
  --pretty       Pretty-print the JSON envelope.
  --help         Show this help.
`;

function writeEnvelope(envelope, pretty) {
  const text = pretty
    ? `${JSON.stringify(envelope, null, 2)}\n`
    : `${JSON.stringify(envelope)}\n`;
  process.stdout.write(text);
}

/**
 * Resolve config once and pass it to the provider factory. Kept as an
 * injectable seam so the CLI contract is covered without network access.
 *
 * @param {object} [deps]
 * @param {Function} [deps.resolveConfigFn]
 * @param {Function} [deps.createProviderFn]
 * @returns {object}
 */
export function resolvePlanRunProvider({
  resolveConfigFn = resolveConfig,
  createProviderFn = createProvider,
} = {}) {
  const config = resolveConfigFn();
  return createProviderFn(config);
}

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      state: { type: 'string', default: 'open' },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.run) {
    process.stderr.write(HELP);
    throw new Error('resolve-plan-run: --run <planRunId> is required');
  }

  const state = assertIssueState(values.state);
  const planRunLabel = normalizePlanRunLabel(values.run);
  const planRunId = planRunIdFromLabel(planRunLabel);

  const provider = resolvePlanRunProvider();
  const issues = await fetchPlanRunIssues(provider, { planRunLabel, state });
  const envelope = buildPlanRunEnvelope(issues, { planRunId, planRunLabel });
  writeEnvelope(envelope, values.pretty);

  if (envelope.stories.length === 0) {
    process.stderr.write(
      `resolve-plan-run: no type::story issues with label ${planRunLabel} (state=${state})\n`,
    );
    return 2;
  }
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'resolve-plan-run',
  propagateExitCode: true,
});
