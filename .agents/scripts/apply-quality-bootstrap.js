#!/usr/bin/env node

/**
 * apply-quality-bootstrap.js — run the idempotent quality-gate install
 * (`applyQualityBootstrap`) against the consumer repo root and print
 * `{ quality }` JSON. A script, not a shell heredoc, so it is testable and
 * shell-agnostic.
 */

import { applyQualityBootstrap } from './lib/bootstrap/quality-bootstrap.js';
import { runAsCli } from './lib/cli-utils.js';

/**
 * @param {object} options
 * @param {string} options.projectRoot Absolute consumer repo root.
 * @param {typeof applyQualityBootstrap} [options.applyQualityBootstrap]
 * @returns {{ quality: object }}
 */
export function applyBootstrapAndMigration({
  projectRoot,
  applyQualityBootstrap: applyQuality = applyQualityBootstrap,
}) {
  return { quality: applyQuality({ projectRoot }) };
}

async function main() {
  const projectRoot = process.cwd();
  const result = applyBootstrapAndMigration({ projectRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'apply-quality-bootstrap',
  propagateExitCode: true,
  usage: {
    invocation: 'node .agents/scripts/apply-quality-bootstrap.js',
    summary:
      'Install the quality-gate surface into the consumer repo (guardrails helper, pre-commit line, npm scripts, config defaults, legacy baselines/epic prune). Idempotent; prints { quality } JSON to stdout.',
    flags: [],
  },
});
