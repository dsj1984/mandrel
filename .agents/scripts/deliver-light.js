#!/usr/bin/env node

/**
 * deliver-light.js — the `/deliver-light` entry point (Story #4740).
 *
 * A **thin entry point, not a second delivery engine.** It runs the
 * suitability gate, authors a minimal receipt `type::story`, and then hands off
 * to the SAME engine scripts `/deliver` uses:
 *
 *   suitability gate  →  inline receipt Story  →  single-story-init.js
 *     →  (agent implements + self-evals)  →  diff backstop
 *     →  single-story-close.js  (close-and-land, every gate byte-identical)
 *
 * Worktree, branch, lease, PR, and merge mechanics are **invoked, never
 * reimplemented** — this file contains no parallel init/close logic
 * ({@link buildNextCommands} references the engine scripts by name). The
 * reusable decision core lives in
 * {@link module:lib/orchestration/light-suitability}; this module is the CLI
 * shell plus the receipt-authoring and diff-backstop wiring.
 *
 * Two modes:
 *
 *   - **gate** (default) — judge a prompt's predicted footprint. On
 *     `proceed-light` it authors the receipt Story (via the plan-persist
 *     `createStoryIssues` surface) and prints the init/close hand-off. On
 *     over-scope it prints `ask-operator` (attended) or `escalate-plan`
 *     (`--yes`), never landing silently.
 *   - **backstop** (`--backstop --story <id>`) — re-check the ACTUAL diff of
 *     the Story branch after implementation; exit non-zero when it exceeds the
 *     light ceilings, so an over-scope diff is blocked rather than landed.
 *
 * Usage:
 *   node .agents/scripts/deliver-light.js --prompt "<text>" \
 *     --creates path,path --acceptance 1 --route lite --reason "<why>"
 *   node .agents/scripts/deliver-light.js --prompt "<text>" --amends '#123' --route lite --reason "<why>"
 *   node .agents/scripts/deliver-light.js --backstop --story 4741
 *
 * Exit codes: 0 ok (proceed / clean backstop), 1 usage error, 2 the gate did
 * not proceed light (ask-operator / escalate-plan), 3 the diff backstop blocked.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { computeChangeSet } from './lib/orchestration/change-set.js';
import {
  buildReceiptStoryTicket,
  checkLightDiffBackstop,
  deriveLightSuitability,
  resolveLightGateOutcome,
} from './lib/orchestration/light-suitability.js';
import {
  assemblePlanStories,
  createStoryIssues,
} from './lib/orchestration/plan-persist/story-ops.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `\
Usage:
  deliver-light.js --prompt <text> [--creates csv] [--refactors csv]
                   [--acceptance n] [--route lite|full] [--reason <text>]
                   [--amends '#id'] [--yes]
  deliver-light.js --backstop --story <id>

The thin /deliver-light entry point: suitability gate → inline receipt Story →
the same single-story-init.js / single-story-close.js engine /deliver uses.

Gate options:
  --prompt <text>    Operator prompt describing the change. Required for the gate.
  --creates <csv>    Predicted NEW file paths (comma-separated).
  --refactors <csv>  Predicted edited/existing file paths (comma-separated).
  --acceptance <n>   Predicted acceptance-criteria count (default 1).
  --route <r>        Ledgered model verdict route: lite | full.
  --reason <text>    Recorded reason for a lite verdict (required for lite).
  --amends <#id>     Mark this as an amendment of an existing issue.
  --yes              Unattended: over-scope fails closed to /plan (no prompt).

Backstop options:
  --backstop         Re-check the ACTUAL diff after implementation.
  --story <id>       Story issue number whose story-<id> branch to diff.

  --pretty           Pretty-print the JSON envelope.
  --help             Show this help.
`;

/** Exit code when the gate did not resolve to proceed-light. */
const EXIT_NOT_PROCEED = 2;
/** Exit code when the diff backstop blocked the land. */
const EXIT_BACKSTOP_BLOCKED = 3;

/**
 * Split a comma-separated path list into trimmed, non-empty entries.
 *
 * @param {string|undefined} csv
 * @returns {string[]}
 */
export function parseCsvPaths(csv) {
  if (typeof csv !== 'string' || csv.trim() === '') return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Assemble the predicted `changes[]` footprint from the declared creates /
 * refactors lists — the input {@link deriveLightSuitability} shape-checks.
 *
 * @param {{ creates?: string[], refactors?: string[] }} args
 * @returns {Array<{ path: string, assumption: string }>}
 */
export function buildPredictedChanges({ creates = [], refactors = [] } = {}) {
  return [
    ...creates.map((path) => ({ path, assumption: 'creates' })),
    ...refactors.map((path) => ({ path, assumption: 'refactors-existing' })),
  ];
}

/**
 * Synthesize a predicted-acceptance array of the requested length — the shape
 * gate reads the count, not the text, so placeholder strings suffice. A count
 * below 1 yields a single-item array (a Story with no contract cannot be judged
 * trivial, and the shape derivation rejects a zero-length acceptance anyway).
 *
 * @param {unknown} count
 * @returns {string[]}
 */
export function synthesizeAcceptance(count) {
  const n =
    typeof count === 'number' && Number.isFinite(count) && count >= 1
      ? Math.floor(count)
      : 1;
  return Array.from({ length: n }, (_v, i) => `AC-${i + 1}`);
}

/**
 * Run the suitability gate purely — no I/O. Returns the outcome envelope the
 * CLI serializes. The prompt text and `--amends` target are deliberately **not**
 * inputs: routing is shape-checked identically whether or not the change is an
 * amendment (Story #4740 R3), and the prompt's text carries no routing signal —
 * the predicted footprint does. Both flow into the receipt Story instead.
 *
 * @param {{
 *   creates?: string[],
 *   refactors?: string[],
 *   acceptance?: number,
 *   route?: string,
 *   reason?: string,
 *   yes?: boolean,
 *   injectedRules?: object,
 * }} args
 * @returns {{ action: string, suitability: object, outcome: object }}
 */
export function runLightGate({
  creates = [],
  refactors = [],
  acceptance,
  route,
  reason,
  yes = false,
  injectedRules,
} = {}) {
  const predictedChanges = buildPredictedChanges({ creates, refactors });
  const suitability = deriveLightSuitability({
    predictedChanges,
    predictedAcceptance: synthesizeAcceptance(acceptance),
    verdict: { route, reason },
    injectedRules,
  });
  const outcome = resolveLightGateOutcome({ suitability, yes });
  return { action: outcome.action, suitability, outcome };
}

/**
 * Author the receipt Story via the plan-persist creation surface (reused, not
 * reimplemented). Injectable seams keep it unit-testable without a network.
 *
 * @param {{
 *   provider: object,
 *   prompt: string,
 *   changedFiles?: string[],
 *   amends?: string|number|null,
 *   assembleFn?: typeof assemblePlanStories,
 *   createFn?: typeof createStoryIssues,
 * }} args
 * @returns {Promise<{ storyId: number, url: string|undefined, title: string }>}
 */
export async function createLightReceipt({
  provider,
  prompt,
  changedFiles = [],
  amends = null,
  assembleFn = assemblePlanStories,
  createFn = createStoryIssues,
} = {}) {
  const ticket = buildReceiptStoryTicket({ prompt, changedFiles, amends });
  const { stories } = assembleFn([ticket]);
  const { created } = await createFn({ provider, stories });
  const receipt = created[0];
  if (!receipt || !Number.isInteger(receipt.id)) {
    throw new Error(
      '[deliver-light] receipt Story creation did not return a numeric id',
    );
  }
  return { storyId: receipt.id, url: receipt.url, title: receipt.title };
}

/**
 * The engine hand-off — the SAME scripts `/deliver` uses. Named here as
 * commands, never reimplemented: this is the whole of deliver-light's
 * relationship to worktree/branch/lease/PR/merge mechanics.
 *
 * @param {number} storyId
 * @returns {{ init: string, close: string }}
 */
export function buildNextCommands(storyId) {
  return {
    init: `node .agents/scripts/single-story-init.js --story ${storyId}`,
    close: `node .agents/scripts/single-story-close.js --story ${storyId} --cwd <main-repo>`,
  };
}

/**
 * Run the diff backstop against a Story branch's actual change set.
 *
 * @param {{
 *   storyId: number,
 *   baseRef?: string,
 *   cwd?: string,
 *   computeFn?: typeof computeChangeSet,
 *   injectedRules?: object,
 * }} args
 * @returns {ReturnType<typeof checkLightDiffBackstop>}
 */
export function runDiffBackstop({
  storyId,
  baseRef = 'main',
  cwd = process.cwd(),
  computeFn = computeChangeSet,
  injectedRules,
} = {}) {
  const { files } = computeFn({
    baseRef,
    headRef: `story-${storyId}`,
    cwd,
  });
  return checkLightDiffBackstop({ changedFiles: files, injectedRules });
}

/**
 * Emit a JSON envelope on stdout (the machine surface) so a headless caller can
 * branch on it. Human-readable log lines stay on stderr.
 *
 * @param {object} envelope
 * @param {boolean} pretty
 */
function emit(envelope, pretty) {
  process.stdout.write(
    pretty
      ? `${JSON.stringify(envelope, null, 2)}\n`
      : `${JSON.stringify(envelope)}\n`,
  );
}

/**
 * Backstop mode — re-check the actual diff.
 *
 * @param {{ story?: string, pretty: boolean }} values
 * @returns {Promise<number>}
 */
async function runBackstopMode(values) {
  const storyId = Number.parseInt(String(values.story ?? ''), 10);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    process.stderr.write(HELP);
    throw new Error('[deliver-light] --backstop requires --story <id>');
  }
  const result = runDiffBackstop({ storyId });
  emit({ mode: 'backstop', storyId, ...result }, values.pretty);
  if (result.blocked) {
    Logger.warn(
      `[deliver-light] diff backstop BLOCKED Story #${storyId}: ${result.reasons.join('; ')}`,
    );
    return EXIT_BACKSTOP_BLOCKED;
  }
  Logger.info(`[deliver-light] diff backstop clean for Story #${storyId}.`);
  return 0;
}

/**
 * Gate mode — judge the prompt and, on proceed, author the receipt Story.
 *
 * @param {object} values Parsed CLI values.
 * @returns {Promise<number>}
 */
async function runGateMode(values) {
  if (!values.prompt || String(values.prompt).trim() === '') {
    process.stderr.write(HELP);
    throw new Error('[deliver-light] --prompt <text> is required for the gate');
  }

  const gate = runLightGate({
    creates: parseCsvPaths(values.creates),
    refactors: parseCsvPaths(values.refactors),
    acceptance: values.acceptance
      ? Number.parseInt(String(values.acceptance), 10)
      : 1,
    route: values.route,
    reason: values.reason,
    yes: values.yes === true,
  });

  if (gate.action !== 'proceed-light') {
    emit(
      { mode: 'gate', action: gate.action, outcome: gate.outcome },
      values.pretty,
    );
    Logger.warn(
      `[deliver-light] gate did not proceed light (${gate.action}): ${gate.outcome.reasons.join('; ')}`,
    );
    return EXIT_NOT_PROCEED;
  }

  const provider = createProvider(resolveConfig());
  const receipt = await createLightReceipt({
    provider,
    prompt: String(values.prompt),
    changedFiles: [
      ...parseCsvPaths(values.creates),
      ...parseCsvPaths(values.refactors),
    ],
    amends: values.amends ?? null,
  });
  emit(
    {
      mode: 'gate',
      action: 'proceed-light',
      storyId: receipt.storyId,
      url: receipt.url,
      nextCommands: buildNextCommands(receipt.storyId),
      outcome: gate.outcome,
    },
    values.pretty,
  );
  Logger.info(
    `[deliver-light] receipt Story #${receipt.storyId} created — hand off to single-story-init.js.`,
  );
  return 0;
}

async function main() {
  const { values } = parseArgs({
    options: {
      prompt: { type: 'string' },
      creates: { type: 'string' },
      refactors: { type: 'string' },
      acceptance: { type: 'string' },
      route: { type: 'string' },
      reason: { type: 'string' },
      amends: { type: 'string' },
      yes: { type: 'boolean', default: false },
      backstop: { type: 'boolean', default: false },
      story: { type: 'string' },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // stdout is a JSON stream — keep human-readable output on stderr.
  routeAllOutputToStderr();

  return values.backstop ? runBackstopMode(values) : runGateMode(values);
}

runAsCli(import.meta.url, main, {
  source: 'deliver-light',
  propagateExitCode: true,
});
