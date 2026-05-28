#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * post-story-plan.js — Idempotent story-plan structured-comment emitter.
 *
 * Emits or upserts a `story-plan` structured comment on a Story ticket.
 * The comment captures the agent's planned file set, acceptance-criteria
 * mapping, open questions, and the plan revision counter. Re-posting the same
 * content is a no-op (idempotent upsert); posting different content increments
 * `plan_revision` and replaces the prior comment body.
 *
 * Mirrors `post-structured-comment.js` in shape and error-handling contract.
 * Throws (never Logger.fatal) on unrecoverable failure so `runAsCli` maps it
 * to a clean non-zero exit per `orchestration-error-handling.md`.
 *
 * Usage:
 *   node .agents/scripts/post-story-plan.js \
 *     --story <id> --plan <json> [--provider github]
 *
 * Exit codes:
 *   0 — upsert succeeded
 *   non-zero — validation or provider failure (error on stderr)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import {
  findStructuredComment,
  upsertStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  'schemas',
  'story-plan-comment.schema.json',
);

const COMMENT_TYPE = 'story-plan';

const HELP = `Usage: node .agents/scripts/post-story-plan.js \\
  --story <id> --plan <json> [--provider github]

Flags:
  --story      GitHub issue number of the Story to comment on (required).
  --plan       JSON string conforming to story-plan-comment.schema.json (required).
  --provider   Provider name (default: inferred from .agentrc.json github block).
  --help       Show this message.
`;

/**
 * Load and compile the story-plan JSON Schema.
 * Throws if the schema file cannot be read or compiled.
 *
 * @returns {import('ajv').ValidateFunction}
 */
function loadValidator() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/**
 * Parse and validate a raw JSON string against the story-plan schema.
 * Throws a descriptive Error if parsing or validation fails.
 *
 * @param {string} raw - Raw JSON string from --plan flag.
 * @param {import('ajv').ValidateFunction} validate - Compiled AJV validator.
 * @returns {object} The parsed and validated plan object.
 */
export function parsePlan(raw, validate) {
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch {
    throw new Error(
      `--plan must be valid JSON. Parse error: ${raw.slice(0, 120)}`,
    );
  }

  const ok = validate(plan);
  if (!ok) {
    const errs = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || '(root)'} ${e.message}`)
      .join('\n');
    throw new Error(
      `--plan JSON does not conform to story-plan-comment.schema.json:\n${errs}`,
    );
  }
  return plan;
}

/**
 * Derive the next `plan_revision` by inspecting the existing story-plan
 * comment (if any). If no prior comment exists, returns 1. If the prior
 * comment body parses and carries a `plan_revision`, returns that value + 1.
 * Falls back to 1 on any parse error to avoid blocking on a corrupt prior
 * comment.
 *
 * @param {object} provider - ITicketingProvider instance.
 * @param {number} storyId - The Story issue number.
 * @returns {Promise<number>}
 */
export async function deriveNextRevision(provider, storyId) {
  const prior = await findStructuredComment(provider, storyId, COMMENT_TYPE);
  if (!prior) return 1;

  // The comment body is wrapped in the structured-comment HTML marker.
  // Extract the JSON content (everything after the marker line).
  const body = prior.body ?? '';
  const jsonMatch = body.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return 1;

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    const rev = parsed?.plan_revision;
    if (typeof rev === 'number' && Number.isFinite(rev) && rev >= 1) {
      return rev + 1;
    }
  } catch {
    // Corrupt prior body — start fresh at 1.
  }
  return 1;
}

/**
 * Format the plan object as a markdown comment body with a JSON code block.
 *
 * @param {object} plan - Validated plan object.
 * @returns {string}
 */
export function formatPlanBody(plan) {
  return `### Story Plan (revision ${plan.plan_revision})\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
}

/**
 * Core: validate, stamp the revision, and idempotently upsert the story-plan
 * comment. Exported so tests can call it directly without spawning a subprocess.
 *
 * @param {{
 *   storyId: number,
 *   rawPlan: string,
 *   provider: object,
 *   validate: import('ajv').ValidateFunction,
 * }} opts
 * @returns {Promise<{ success: boolean, storyId: number, planRevision: number }>}
 */
export async function runPostStoryPlan({
  storyId,
  rawPlan,
  provider,
  validate,
}) {
  const plan = parsePlan(rawPlan, validate);

  // Derive the revision from any existing comment rather than trusting the
  // caller's supplied value — this is what makes the emitter idempotent: the
  // caller passes plan_revision: 1, and the function corrects it to the actual
  // next revision if a prior comment already exists.
  const nextRevision = await deriveNextRevision(provider, storyId);
  plan.plan_revision = nextRevision;

  const body = formatPlanBody(plan);
  await upsertStructuredComment(provider, storyId, COMMENT_TYPE, body);

  return { success: true, storyId, planRevision: nextRevision };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      plan: { type: 'string' },
      provider: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

/**
 * Pure: validate the required CLI inputs for `post-story-plan`.
 *
 * @param {Record<string, unknown>} values - Parsed CLI values.
 * @returns {{ storyId: number, errors: string[] }}
 */
export function validateRequiredArgs(values) {
  const storyId = Number.parseInt(values.story ?? '', 10);
  const errors = [];
  if (!Number.isFinite(storyId) || storyId <= 0) {
    errors.push('--story <id> is required.');
  }
  if (!values.plan) errors.push('--plan <json> is required.');
  return { storyId, errors };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const { storyId, errors } = validateRequiredArgs(values);
  if (errors.length) {
    for (const e of errors) {
      process.stderr.write(`[post-story-plan] ${e}\n`);
    }
    process.stderr.write(HELP);
    process.exit(2);
  }

  const validate = loadValidator();

  const config = resolveConfig();
  const effectiveConfig = values.provider
    ? { ...config, provider: values.provider }
    : config;
  const provider = createProvider(effectiveConfig);

  const envelope = await runPostStoryPlan({
    storyId,
    rawPlan: values.plan,
    provider,
    validate,
  });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

runAsCli(import.meta.url, main, { source: 'post-story-plan' });
