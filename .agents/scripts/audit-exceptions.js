#!/usr/bin/env node

/**
 * CLI: the deterministic evidence half of `/audit-exceptions` — every
 * suppression, dependency pin / patch / allowlist, CI gate exemption, test skip
 * and code allowlist in a repo, each with a mechanical verdict. Read-only:
 * writes only the `--out` envelope. Degraded inputs still exit 0; only a
 * missing or unwritable `--out` fails.
 */

// Must be the first import: fail fast before any third-party import evaluates.
import './lib/runtime-deps/ensure-installed.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  DEFAULT_MAX_RECORDS,
  runEngine,
  summarize,
} from './lib/audit-exceptions/engine.js';
import { DEFAULT_BLAME_LIMIT } from './lib/audit-exceptions/history.js';
import { DEFAULT_TICKET_LIMIT } from './lib/audit-exceptions/tickets.js';
import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'audit-exceptions-envelope.schema.json',
);

const FLAG_SPEC = {
  out: { type: 'string' },
  cwd: { type: 'string' },
  probe: { type: 'boolean' },
  'changed-since': { type: 'string' },
  'ticket-limit': { type: 'integer' },
  'blame-limit': { type: 'integer' },
  'max-records': { type: 'integer' },
};

let validator;

/**
 * Throws on a schema mismatch — a malformed envelope is an engine bug.
 *
 * @param {object} envelope
 * @returns {void}
 */
export function assertEnvelope(envelope) {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validator = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));
  }
  if (validator(envelope)) return;
  const detail = (validator.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ');
  throw new Error(
    `[audit-exceptions] envelope failed schema validation: ${detail}`,
  );
}

/**
 * @param {{ argv?: string[], cwd?: string, stdout?: { write: (s: string) => void },
 *   gh?: object, spawn?: Function }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  gh,
  spawn,
} = {}) {
  const { values } = defineFlags(FLAG_SPEC, argv);
  if (!values.out) {
    throw new Error('[audit-exceptions] --out <path> is required');
  }
  const repoRoot = path.resolve(values.cwd ?? cwd);
  const outPath = path.resolve(repoRoot, values.out);

  const envelope = await runEngine({
    cwd: repoRoot,
    probe: values.probe === true,
    changedSince: values.changedSince ?? null,
    ticketLimit: values.ticketLimit ?? DEFAULT_TICKET_LIMIT,
    blameLimit: values.blameLimit ?? DEFAULT_BLAME_LIMIT,
    maxRecords: values.maxRecords ?? DEFAULT_MAX_RECORDS,
    gh,
    spawn,
  });
  assertEnvelope(envelope);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

  stdout.write(`${JSON.stringify(summarize(envelope, outPath), null, 2)}\n`);
  return 0;
}

runAsCli(import.meta.url, async () => runCli(), {
  source: 'audit-exceptions',
  propagateExitCode: true,
  errorPrefix: '[audit-exceptions] ❌ Fatal error',
  usage: {
    invocation:
      'node .agents/scripts/audit-exceptions.js --out <path> [--cwd <dir>] [--probe] [--changed-since <ref>] [--ticket-limit <n>] [--blame-limit <n>] [--max-records <n>]',
    summary:
      'Read-only exception inventory: find every suppression, dependency pin, patch and allowlist, CI gate exemption, test skip and code allowlist, and mark each dead, expired, orphaned, unjustified, live or unknown.',
    flags: [
      ['--out <path>', 'Write the JSON envelope here (required).'],
      ['--cwd <dir>', 'Repository root to analyse (default: cwd).'],
      [
        '--probe',
        "Also run each installed tool's own unused-suppression report (biome, eslint, tsc, knip).",
      ],
      [
        '--changed-since <ref>',
        'Mark records on lines added since <ref> as introduced.',
      ],
      [
        '--ticket-limit <n>',
        `Unique cited tickets resolved via gh (default: ${DEFAULT_TICKET_LIMIT}).`,
      ],
      [
        '--blame-limit <n>',
        `Records given an addedAt date via git blame (default: ${DEFAULT_BLAME_LIMIT}).`,
      ],
      [
        '--max-records <n>',
        `Records kept in the envelope; clusters always count all (default: ${DEFAULT_MAX_RECORDS}).`,
      ],
    ],
    notes: [
      "Never edits a file, never runs a tool with a write or fix flag, and never evaluates the analysed repo's code.",
      'Exit codes:\n  0  evidence assembled (including every degraded input)\n  1  the envelope could not be built or written',
    ],
  },
});
