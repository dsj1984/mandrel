#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * plan-context.js — build the `/mandrel-plan` authoring-context envelope from
 * exactly one entry form (`--seed`, `--seed-file`, `--tickets`, `--amends`),
 * write it with `stories.template.json` under `<tempRoot>/plan-<slug>/`
 * (where `plan-persist.js` discovers the `--tickets` source ids), and print a
 * compact JSON digest as the only stdout.
 *
 * Exit codes: 0 envelope emitted; 1 fatal.
 */

// Must be the first import: fail fast before any third-party import runs.
import './lib/runtime-deps/ensure-installed.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import {
  getPaths,
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import {
  buildPlanContext,
  renderStoriesTemplate,
  STORIES_TEMPLATE_FILENAME,
} from './lib/orchestration/plan-context.js';
import { recordPlanInvocation } from './lib/orchestration/plan-metrics.js';
import { createProvider } from './lib/provider-factory.js';

const PLAN_SLUG_MAX_LENGTH = 48;

/**
 * Deliberately lossy: a handle, not an identity — the same seed reuses (and
 * overwrites) the same directory.
 *
 * @param {string} raw
 * @returns {string} `plan` when nothing survives.
 */
export function slugifyPlanLabel(raw) {
  const slug = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PLAN_SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? 'plan' : slug;
}

/**
 * Envelope path when no `--out` is given. Always written, because persist
 * discovers source ids and the template from this directory.
 *
 * @param {object} args
 * @param {string} args.mode
 * @param {string} [args.seedText]
 * @param {string} [args.seedFilePath]
 * @param {number[]} [args.ticketIds]
 * @param {number} [args.amendsId]
 * @param {object} [args.config]
 * @param {string} [args.cwd]
 * @returns {string} Absolute path.
 */
export function resolveDefaultOutPath({
  mode,
  seedText,
  seedFilePath,
  ticketIds,
  amendsId,
  config,
  cwd = PROJECT_ROOT,
}) {
  const byMode = {
    amends: () => `amends-${amendsId}`,
    tickets: () => `tickets-${(ticketIds ?? []).join('-')}`,
    'seed-file': () => path.parse(String(seedFilePath ?? '')).name,
  };
  const label = (byMode[mode] ?? (() => String(seedText ?? '')))();
  return path.resolve(
    cwd,
    getPaths(config).tempRoot,
    `plan-${slugifyPlanLabel(label)}`,
    'plan-context.json',
  );
}

/**
 * @param {string} raw
 * @returns {number[]}
 */
export function parseTicketIds(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('--tickets requires one or more positive issue ids.');
  }
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(
      `--tickets expects positive integer ids; got ${JSON.stringify(raw)}`,
    );
  }
  return [...new Set(ids)];
}

/**
 * @param {string} raw
 * @returns {number}
 */
export function parseAmendsId(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('--amends requires a single prior Story id.');
  }
  const id = Number(raw.trim().replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `--amends expects a positive integer Story id; got ${JSON.stringify(raw)}`,
    );
  }
  return id;
}

/**
 * @param {object} args
 * @returns {Promise<object>} the emitted envelope.
 */
export async function emitPlanContext({
  mode,
  seedFilePath,
  seedFileContent,
  seedText,
  ticketIds,
  amendsId,
  provider,
  config,
  settings,
  pretty = false,
  outPath = null,
  cwd,
  stdout = process.stdout,
}) {
  const envelope = await buildPlanContext({
    mode,
    seedFilePath,
    seedFileContent,
    seedText,
    ticketIds,
    amendsId,
    provider,
    config,
    settings,
    cwd,
  });
  const json = pretty
    ? JSON.stringify(envelope, null, 2)
    : JSON.stringify(envelope);
  const resolvedOut =
    outPath ??
    resolveDefaultOutPath({
      mode,
      seedText,
      seedFilePath,
      ticketIds,
      amendsId,
      config,
      cwd: cwd ?? undefined,
    });
  {
    // The ~40KB envelope goes to disk; stdout carries only a digest so it
    // does not ride resident in the transcript.
    await writeEnvelopeFile(resolvedOut, json);
    await writeStoriesTemplateFile(resolvedOut, envelope);
    const resolved = path.resolve(resolvedOut);
    const digest = {
      digest: 'plan-context',
      mode: envelope.mode,
      out: resolved,
      storiesTemplate: path.join(
        path.dirname(resolved),
        'stories.template.json',
      ),
      bytes: Buffer.byteLength(json, 'utf8'),
      sourceTickets: (envelope.sourceTickets ?? []).map((t) => t.id),
      duplicates: (envelope.duplicates ?? []).length,
      // Advisory signals only, never a reroute.
      complexitySignals: envelope.complexitySignals
        ? {
            artifactCount: envelope.complexitySignals.artifactCount,
            sensitivePathClasses:
              envelope.complexitySignals.sensitivePathClasses,
            uiSurface: envelope.complexitySignals.uiSurface ?? null,
          }
        : null,
      // Names what was cut when the envelope exceeded the context ceiling.
      truncated: envelope.truncated ?? null,
      amends: envelope.amends ? { id: envelope.amends.id } : null,
    };
    stdout.write(`${JSON.stringify(digest)}\n`);
  }
  return envelope;
}

/**
 * Throws on failure: a missing envelope makes persist silently see no source
 * tickets.
 *
 * @param {string} outPath
 * @param {string} json
 */
async function writeEnvelopeFile(outPath, json) {
  const resolved = path.resolve(outPath);
  try {
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${json}\n`, 'utf8');
  } catch (err) {
    throw new Error(
      `[plan-context] cannot write envelope to ${resolved}: ${err.message}`,
    );
  }
  Logger.info(`[plan-context] wrote envelope to ${resolved}`);
}

/**
 * Write the ready-to-fill authoring template beside the envelope, with
 * `changes[]` pre-resolved from `complexitySignals`. Throws on failure.
 *
 * @param {string} outPath
 * @param {object} [envelope]
 */
async function writeStoriesTemplateFile(outPath, envelope = {}) {
  const resolved = path.resolve(
    path.dirname(path.resolve(outPath)),
    STORIES_TEMPLATE_FILENAME,
  );
  try {
    await writeFile(
      resolved,
      renderStoriesTemplate({
        complexitySignals: envelope?.complexitySignals ?? null,
      }),
      'utf8',
    );
  } catch (err) {
    throw new Error(
      `[plan-context] cannot write stories template to ${resolved}: ${err.message}`,
    );
  }
  Logger.info(`[plan-context] wrote ready-to-fill template to ${resolved}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string' },
      'seed-file': { type: 'string' },
      tickets: { type: 'string' },
      amends: { type: 'string' },
      out: { type: 'string' },
      pretty: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const seedText = values.seed || null;
  const seedFilePath = values['seed-file'] || null;
  const hasSeed = typeof seedText === 'string' && seedText.length > 0;
  const hasSeedFile =
    typeof seedFilePath === 'string' && seedFilePath.length > 0;
  const hasTickets =
    typeof values.tickets === 'string' && values.tickets.trim().length > 0;
  const hasAmends =
    typeof values.amends === 'string' && values.amends.trim().length > 0;
  const entryForms = [hasSeed, hasSeedFile, hasTickets, hasAmends].filter(
    Boolean,
  ).length;
  if (entryForms !== 1) {
    throw new Error(
      'Pass exactly one of --seed "<text>", --seed-file <path>, --tickets <ids>, or --amends <id>.',
    );
  }

  let mode;
  let ticketIds;
  let amendsId;
  if (hasAmends) {
    mode = 'amends';
    amendsId = parseAmendsId(values.amends);
  } else if (hasTickets) {
    mode = 'tickets';
    ticketIds = parseTicketIds(values.tickets);
  } else if (hasSeedFile) {
    mode = 'seed-file';
  } else {
    mode = 'seed';
  }

  // stdout is reserved for the JSON digest.
  routeAllOutputToStderr();

  let config;
  let settings;
  try {
    config = resolveConfig();
    // The bag shape `buildAuthoringContext` consumes.
    settings = {
      baseBranch: config.project?.baseBranch,
      paths: config.project?.paths,
      planning: config.planning,
      docsContextFiles: config.project?.docsContextFiles,
    };
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }
  const provider = createProvider(config);

  await recordPlanInvocation(
    {
      cli: 'plan-context',
      mode,
      config,
    },
    () =>
      emitPlanContext({
        mode,
        seedFilePath: hasSeedFile ? seedFilePath : undefined,
        seedText: hasSeed ? seedText : undefined,
        ticketIds,
        amendsId,
        provider,
        config,
        settings,
        pretty: values.pretty,
        outPath: values.out || null,
      }),
  );
}

runAsCli(import.meta.url, main, {
  source: 'plan-context',
  usage: {
    invocation:
      'node .agents/scripts/plan-context.js (--seed "<text>" | --seed-file <path> | --tickets <ids> | --amends <id>) [--out <path>] [--pretty]',
    summary:
      'Build the /mandrel-plan authoring-context envelope. Writes it (and stories.template.json) under <tempRoot>/plan-<slug>/ and prints the digest on stdout. Exactly one entry form must be supplied.',
    flags: [
      ['--seed "<text>"', 'Inline seed prose.'],
      ['--seed-file <path>', 'Seed document to read.'],
      ['--tickets <ids>', 'Comma-separated existing ticket ids to re-plan.'],
      ['--amends <id>', 'Amend the Spec of an existing Story.'],
      [
        '--out <path>',
        'Override the derived <tempRoot>/plan-<slug>/plan-context.json path.',
      ],
      ['--pretty', 'Pretty-print the written JSON envelope.'],
    ],
  },
});
