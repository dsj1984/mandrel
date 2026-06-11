#!/usr/bin/env node

/**
 * epic-plan-spec-validate.js — Phase 7.5 Tech Spec post-authoring gate CLI.
 *
 * `/plan` Phase 7 authors the Tech Spec; Phase 8.3 (Holistic
 * Consolidation) reconciles the draft ticket array against the Tech Spec's
 * `## Delivery Slicing` section, which the decompose-author skill uses as the
 * capability-boundary anchor. When that section is absent the consolidation
 * pass runs against a void and produces groupings that reflect technical
 * shape rather than capability boundaries.
 *
 * This CLI is the hard gate between Phase 7 and Phase 8: it reads the authored
 * `techspec.md`, runs {@link ./lib/orchestration/spec-section-validator.js#validateSpecSections},
 * and exits non-zero when the required section is missing so decomposition
 * cannot proceed against an un-anchored spec. It is the Phase 8-side
 * counterpart to the Phase 6 Epic Clarity Gate (`epic-plan-clarity.js`) —
 * same detect-then-prompt pattern, one phase later.
 *
 * Usage:
 *   epic-plan-spec-validate.js --techspec <path> [--json]
 *
 * Exit codes:
 *   0 — every required section present.
 *   1 — at least one required section missing, or a fatal error (bad path,
 *       unreadable file). The failure message names the missing section(s)
 *       and tells the operator how to recover.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { validateSpecSections } from './lib/orchestration/spec-section-validator.js';

/**
 * Build the operator-facing failure message for a missing-section result.
 * Names each missing section and tells the operator whether to re-author the
 * spec or add the section by hand before continuing to Phase 8.
 *
 * @param {{ techspecPath: string, missing: string[] }} args
 * @returns {string}
 */
export function formatMissingSectionMessage({ techspecPath, missing }) {
  const list = missing.map((name) => `## ${name}`).join(', ');
  return [
    `[epic-plan-spec-validate] Tech Spec is missing required section(s): ${list}`,
    `  Spec file: ${techspecPath}`,
    '',
    `  Phase 8 (decomposition) reconciles the draft ticket array against the`,
    `  Tech Spec's "## Delivery Slicing" section — without it, the Phase 8.3`,
    `  consolidation pass has no capability-boundary anchor and groups by`,
    `  technical shape instead.`,
    '',
    '  To continue, do ONE of the following before re-running Phase 8:',
    `    1. Re-author the Tech Spec (re-run the Phase 7 spec-author step) so it`,
    `       emits a "## Delivery Slicing" section, OR`,
    `    2. Add a "## Delivery Slicing" section to the Tech Spec by hand,`,
    `       describing the capability boundaries the work should be sliced along.`,
  ].join('\n');
}

/**
 * Validate an authored Tech Spec file for the required post-authoring
 * sections. Pure-ish wrapper around `validateSpecSections` that owns the file
 * read so the CLI `main` stays a thin arg-parse shell.
 *
 * @param {{ techspecPath: string }} args
 * @returns {Promise<{ ok: boolean, missing: string[], present: string[] }>}
 */
export async function validateSpecFile({ techspecPath }) {
  const body = await readFile(techspecPath, 'utf8');
  return validateSpecSections({ body });
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      techspec: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  if (!values.techspec) {
    throw new Error(
      'Usage: epic-plan-spec-validate.js --techspec <path> [--json]',
    );
  }

  const techspecPath = values.techspec;
  const result = await validateSpecFile({ techspecPath });

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ techspecPath, ...result })}\n`);
  }

  if (!result.ok) {
    throw new Error(
      formatMissingSectionMessage({ techspecPath, missing: result.missing }),
    );
  }

  Logger.info(
    `[epic-plan-spec-validate] Tech Spec section gate passed: ${result.present
      .map((name) => `## ${name}`)
      .join(', ')} present.`,
  );
}

runAsCli(import.meta.url, main, { source: 'epic-plan-spec-validate' });
