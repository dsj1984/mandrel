#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan-clarity.js — Phase 6 Epic Clarity Gate CLI.
 *
 * Two modes:
 *
 *   1. --emit-context --epic <id> [--pretty]
 *      Fetches the Epic body via the resolved ticketing provider, scores
 *      it against the five canonical sections from
 *      `.agents/templates/epic-from-idea.md`, and prints a JSON envelope
 *      to stdout: `{ epicId, epicBody, verdict, sections, missingOrPlaceholder }`.
 *      Read-only — no state mutations.
 *
 *   2. --epic <id> --updated-body <path>
 *      Reads the sharpened body from disk, compares it to the current
 *      Epic body, and (when different) persists via
 *      `provider.updateTicket(epicId, { body })`. Posts a
 *      `clarity-gate-update` structured audit comment recording the
 *      change. Idempotent: identical body → no-op (`changed: false`).
 *
 * Exit codes:
 *   0 — mode completed.
 *   1 — fatal error (see stderr).
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { scoreEpicBody } from './lib/epic-plan-clarity.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

/**
 * Build the read-only emit-context envelope for an Epic.
 *
 * @param {{ epicId: number, provider: object }} args
 * @returns {Promise<{ epicId: number, epicBody: string, verdict: string, sections: Array<{name:string,status:string}>, missingOrPlaceholder: string[] }>}
 */
export async function buildClarityContext({ epicId, provider }) {
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[epic-plan-clarity] Epic #${epicId} not found.`);
  }
  const body = epic.body ?? '';
  const score = scoreEpicBody({ body });
  return {
    epicId,
    epicBody: body,
    verdict: score.verdict,
    sections: score.sections,
    missingOrPlaceholder: score.missingOrPlaceholder,
  };
}

/**
 * Persist a sharpened Epic body. Wraps `provider.updateTicket` behind the
 * `updateEpicFromOnePager`-style port and posts the `clarity-gate-update`
 * audit comment on success.
 *
 * @param {{
 *   epicId: number,
 *   updatedBody: string,
 *   provider: object,
 * }} args
 * @returns {Promise<{ epicId: number, changed: boolean, currentLength: number, updatedLength: number }>}
 */
export async function persistClarityUpdate({ epicId, updatedBody, provider }) {
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[epic-plan-clarity] Epic #${epicId} not found.`);
  }
  const currentBody = epic.body ?? '';

  if (currentBody === updatedBody) {
    Logger.info(
      `[epic-plan-clarity] Epic #${epicId} body matches submitted update — no-op.`,
    );
    return {
      epicId,
      changed: false,
      currentLength: currentBody.length,
      updatedLength: updatedBody.length,
    };
  }

  await provider.updateTicket(epicId, { body: updatedBody });
  Logger.info(`[epic-plan-clarity] Updated Epic #${epicId} body.`);

  // Audit comment. Skip silently with a stderr warn when the provider does
  // not implement comment surfacing — keeps the gate functional in stripped
  // test doubles.
  const timestamp = new Date().toISOString();
  const auditBody = [
    '```json',
    JSON.stringify(
      {
        epicId,
        timestamp,
        changed: true,
        currentLength: currentBody.length,
        updatedLength: updatedBody.length,
      },
      null,
      2,
    ),
    '```',
    '',
    'Phase 6 Epic Clarity Gate persisted a sharpened Epic body. The previous body has been replaced; the rewrite was operator-approved via the HITL diff stop.',
  ].join('\n');

  try {
    await upsertStructuredComment(
      provider,
      epicId,
      'clarity-gate-update',
      auditBody,
    );
  } catch (err) {
    Logger.warn(
      `[epic-plan-clarity] Failed to post clarity-gate-update audit comment: ${err.message}`,
    );
  }

  return {
    epicId,
    changed: true,
    currentLength: currentBody.length,
    updatedLength: updatedBody.length,
  };
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      'emit-context': { type: 'boolean', default: false },
      'updated-body': { type: 'string' },
      pretty: { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    throw new Error(
      'Usage: epic-plan-clarity.js --epic <EpicId> (--emit-context [--pretty] | --updated-body <file>)',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new Error(
      `Invalid epic ID: "${values.epic}" — must be a positive integer.`,
    );
  }

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }
  const provider = createProvider(config);

  // Story #2278 — in --emit-context mode stdout is reserved for the JSON
  // envelope. Flip Logger sinks to stderr defensively even though
  // buildClarityContext does not currently call Logger.info, so future
  // additions cannot silently corrupt the captured file.
  if (values['emit-context']) {
    routeAllOutputToStderr();
    const envelope = await buildClarityContext({ epicId, provider });
    const json = values.pretty
      ? JSON.stringify(envelope, null, 2)
      : JSON.stringify(envelope);
    process.stdout.write(`${json}\n`);
    return;
  }

  if (!values['updated-body']) {
    throw new Error(
      'Missing mode flag: pass --emit-context or --updated-body <file>.',
    );
  }

  const updatedBody = await readFile(values['updated-body'], 'utf8');
  const result = await persistClarityUpdate({
    epicId,
    updatedBody,
    provider,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-plan-clarity' });
