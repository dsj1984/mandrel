#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * plan-context.js — step 1 of the collapsed `/plan` pipeline.
 *
 * Emits one stdout-pure JSON envelope for the `/plan` authoring middle.
 *
 * Two operator modes (exactly one is required):
 *
 *   --seed "<text>"           Chat/text ideation. Dup search runs off the
 *                             raw seed; envelope carries `seed`.
 *
 *   --seed-file <path>        Same as --seed, but the corpus is read from
 *                             disk (audit-to-stories handoff, notes).
 *
 *   --tickets 123[,456…]      Analyze existing issue(s) into proper
 *                             Stories. Envelope carries `sourceTickets[]`.
 *
 *   --amends 123 | #123       Amendment (delta) planning. Composes a DELTA
 *                             envelope from the prior Story's body, its
 *                             acceptance criteria, and its delivered file map
 *                             instead of re-interrogating the repo from
 *                             scratch (Story #4741). Envelope carries `amends`.
 *
 * Flags:
 *   --out <path>     Write the envelope to <path> (parent dirs created).
 *                    `/plan` points this at `<plan-dir>/plan-context.json`,
 *                    which is where `plan-persist.js` auto-discovers the
 *                    `--tickets` source ids from (Story #4554). Without a
 *                    captured envelope persist cannot know a `--tickets` run
 *                    happened, and superseding degrades to the
 *                    `--source-tickets` flag. With --out, stdout carries a
 *                    compact digest naming the artifact instead of the full
 *                    envelope (Story #4708 script-output contract).
 *   --pretty         Pretty-print the JSON envelope (no-op with --out).
 *
 * stdout is reserved for a single JSON payload (Story #2278 discipline) —
 * the envelope, or the digest when --out captures it:
 * `routeAllOutputToStderr()` runs before any pipeline code so the stream
 * is unconditionally parseable by `JSON.parse`.
 *
 * Exit codes:
 *   0 — envelope emitted.
 *   1 — fatal error (see stderr).
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import {
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

/**
 * Parse a comma-/space-separated ticket id list into positive integers.
 *
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
 * Parse a single `--amends` id, tolerating a leading `#` (`#123` or `123`).
 *
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
 * Build the envelope and write it to `stdout` as a single JSON line
 * (or pretty-printed with --pretty). Exported for tests.
 *
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
  if (outPath) {
    // Script-output contract (Story #4708, AC-5): the full envelope is a
    // ~40KB artifact that would ride resident in the transcript for every
    // later turn. When it is captured to disk anyway, stdout carries a
    // compact digest naming the artifact instead of the payload itself.
    await writeEnvelopeFile(outPath, json);
    await writeStoriesTemplateFile(outPath, envelope);
    const resolved = path.resolve(outPath);
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
      // Advisory only (Story #4722): signals, no route — the planner owns
      // the trivial-vs-standard verdict and persist validates it by shape.
      // The nested `deliverLightSuggestion` is the recorded plan-side routing
      // handshake (Story #4741 AC-6) — advisory, never an automatic reroute.
      complexitySignals: envelope.complexitySignals
        ? {
            artifactCount: envelope.complexitySignals.artifactCount,
            riskHeuristicHits: envelope.complexitySignals.riskHeuristicHits,
            sensitivePathClasses:
              envelope.complexitySignals.sensitivePathClasses,
            deliverLightSuggestion:
              envelope.complexitySignals.deliverLightSuggestion ?? null,
          }
        : null,
      amends: envelope.amends ? { id: envelope.amends.id } : null,
    };
    stdout.write(`${JSON.stringify(digest)}\n`);
  } else {
    stdout.write(`${json}\n`);
  }
  return envelope;
}

/**
 * Persist the envelope to `--out` so `plan-persist.js` can derive the
 * `--tickets` source ids from it without an operator re-typing them.
 *
 * Writing is part of emitting, not a best-effort extra: a failed write means
 * persist will silently see no source tickets, so it throws rather than
 * warning past the problem.
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
 * Emit the ready-to-fill Story authoring template next to the captured
 * envelope (Story #4707 — one-shot authoring). The planner copies it to
 * `stories.json` and fills the placeholders; no step of the authoring path
 * requires reading `story-body.js` source. Written whenever `--out` is
 * passed, and throwing on failure for the same reason the envelope write
 * does: a silently missing template re-opens the format-discovery loop it
 * exists to close. The envelope's advisory `complexitySignals` are threaded
 * through so the skeleton's `changes[]` arrive pre-resolved to
 * creates-vs-refactors against the repo snapshot (Story #4723).
 *
 * @param {string} outPath The envelope `--out` path; the template lands in
 *   the same directory as {@link STORIES_TEMPLATE_FILENAME}.
 * @param {object} [envelope] The emitted plan-context envelope.
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

  // stdout is reserved for the JSON envelope: flip every Logger sink that
  // could land on stdout to stderr BEFORE any pipeline code runs
  // (Story #2278 — the same stdout-purity guarantee the retired pipeline
  // gives; this CLI is emit-only so the flip is unconditional).
  routeAllOutputToStderr();

  let config;
  let settings;
  try {
    config = resolveConfig();
    // `settings` retains the legacy bag shape `buildAuthoringContext` and
    // friends consume: `{ baseBranch, paths, planning, docsContextFiles }`.
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

runAsCli(import.meta.url, main, { source: 'plan-context' });
