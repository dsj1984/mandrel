#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * plan-context.js — step 1 of the collapsed `/mandrel-plan` pipeline.
 *
 * Emits one stdout-pure JSON envelope for the `/mandrel-plan` authoring middle.
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
 *   --out <path>     Override where the envelope is written (parent dirs
 *                    created). **Optional since Story #5342** — with no
 *                    `--out` the envelope lands at
 *                    `<tempRoot>/plan-<slug>/plan-context.json`, the plan
 *                    directory `/mandrel-plan` would have named by hand, and
 *                    `stories.template.json` lands beside it. That is where
 *                    `plan-persist.js` auto-discovers the `--tickets` source
 *                    ids from (Story #4554); without a captured envelope
 *                    persist cannot know a `--tickets` run happened, and
 *                    superseding degrades to the `--source-tickets` flag.
 *   --pretty         Pretty-print the written JSON envelope.
 *
 * stdout is reserved for a single JSON payload (Story #2278 discipline) —
 * the compact digest naming the written artifacts (Story #4708
 * script-output contract): `routeAllOutputToStderr()` runs before any
 * pipeline code so the stream is unconditionally parseable by `JSON.parse`.
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

/** Longest slug segment a default plan directory carries. */
const PLAN_SLUG_MAX_LENGTH = 48;

/**
 * Reduce free text to the hyphen-case segment a plan directory is named by.
 *
 * Deliberately lossy: the slug is a human-readable handle on a temp
 * directory, not an identity — two runs from the same seed land in the same
 * directory and the second overwrites the first, which is the idempotent
 * behaviour the operator already got from typing the same `--out` twice.
 *
 * @param {string} raw
 * @returns {string} A non-empty hyphen-case slug (`plan` when nothing survives).
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
 * Resolve where the envelope is written when the operator passed no `--out`
 * (Story #5342).
 *
 * `--out` was mandatory in practice and optional in the CLI: persist
 * auto-discovers the envelope and the `stories.template.json` beside it from
 * the plan directory, so a run without it silently lost superseding and the
 * authoring skeleton. The path it always pointed at is derivable — the
 * configured `tempRoot`, a `plan-<slug>` directory named for what is being
 * planned — so the CLI derives it rather than asking.
 *
 * Exported for tests: this is the join where a missing flag stops costing
 * the plan its source ids.
 *
 * @param {object} args
 * @param {string} args.mode One of `seed` | `seed-file` | `tickets` | `amends`.
 * @param {string} [args.seedText]
 * @param {string} [args.seedFilePath]
 * @param {number[]} [args.ticketIds]
 * @param {number} [args.amendsId]
 * @param {object} [args.config] Resolved config (for `project.paths.tempRoot`).
 * @param {string} [args.cwd]
 * @returns {string} Absolute path to the envelope file.
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
 * Build the envelope, write it (plus the `stories.template.json` skeleton)
 * to `outPath` — or to the derived default when none was passed
 * (Story #5342) — and print the compact digest on stdout. Exported for
 * tests.
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
    // Script-output contract (Story #4708, AC-5): the full envelope is a
    // ~40KB artifact that would ride resident in the transcript for every
    // later turn. It is always captured to disk (Story #5342 derives the
    // path when `--out` is absent), so stdout carries a compact digest
    // naming the artifacts instead of the payload itself.
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
      // Advisory only: signals, no route. `uiSurface` is the recorded
      // /prototype offer — advisory, never an automatic reroute. It rides the
      // digest because with `--out` the digest is the only thing the planner
      // reads.
      complexitySignals: envelope.complexitySignals
        ? {
            artifactCount: envelope.complexitySignals.artifactCount,
            sensitivePathClasses:
              envelope.complexitySignals.sensitivePathClasses,
            uiSurface: envelope.complexitySignals.uiSurface ?? null,
          }
        : null,
      // Story #5312: an envelope over the planner-context ceiling is written
      // truncated, and the digest names what was cut.
      truncated: envelope.truncated ?? null,
      amends: envelope.amends ? { id: envelope.amends.id } : null,
    };
    stdout.write(`${JSON.stringify(digest)}\n`);
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
 * requires reading `story-body.js` source. Written on every run (Story
 * #5342), and throwing on failure for the same reason the envelope write
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
