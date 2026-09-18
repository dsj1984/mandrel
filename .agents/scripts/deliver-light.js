#!/usr/bin/env node

/**
 * `/deliver-light` entry point — a thin shell, not a second engine: a
 * risk-only suitability gate, a receipt Story, then the same init/close
 * scripts `/mandrel-deliver` uses (never reimplemented). `--backstop`
 * re-checks the ACTUAL diff, the only size block. An escalation ends the
 * light path, not the session.
 *
 * Exit codes: 0 ok, 1 usage error, 2 escalated, 3 backstop blocked.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { resolveBackstopOutcome } from './lib/orchestration/light-backstop.js';
import { recordGateRefusal } from './lib/orchestration/light-escalation.js';
import {
  buildReceiptStoryTicket,
  deriveLightSuitability,
  resolveLightGateOutcome,
} from './lib/orchestration/light-suitability.js';
import {
  assemblePlanStories,
  createStoryIssues,
} from './lib/orchestration/plan-persist/story-ops.js';
import {
  buildEscalationTerminal,
  emitTerminalEnvelope,
  exitCodeForTerminal,
} from './lib/orchestration/story-deliver-terminal.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `\
Usage:
  deliver-light.js --prompt <text> [--creates csv] [--refactors csv]
                   --reason <text> [--amends '#id']
  deliver-light.js --backstop --story <id>

The thin /deliver-light entry point: suitability gate → inline receipt Story →
the same single-story-init.js / single-story-close.js engine /mandrel-deliver uses.

The gate judges RISK, not size. Only two things refuse: a verdict with no
recorded reason, and an un-waivable risk rule the predicted PATHS trip (a
sensitive-path class, a migration paired with its consumers). The predicted-
shape ceilings were self-declared buckets and are gone (Story #5344, after
Story #5313 had already demoted them to warnings). The --backstop pass measures
the ACTUAL diff and is the only size block.

Gate options:
  --prompt <text>    Operator prompt describing the change. Required for the gate.
  --creates <csv>    Predicted NEW file paths (comma-separated).
  --refactors <csv>  Predicted edited/existing file paths (comma-separated).
  --reason <text>    Recorded reason for taking the light path. Required: an
                     un-ledgered verdict escalates.
  --amends <#id>     Mark this as an amendment of an existing issue.

Backstop options:
  --backstop         Re-check the ACTUAL diff after implementation. Bounds the
                     change's IMPLEMENTATION half by magnitude (changed lines +
                     file sprawl); test/doc/baseline companions are exempt from
                     the counts but still matched for sensitive paths. A block
                     emits a nextCommand recycling the receipt through /mandrel-plan.
  --story <id>       Story issue number whose story-<id> branch to diff.

  --pretty           Pretty-print the JSON envelope.
  --help             Show this help.
`;

/**
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
 * Pure. The prompt and `--amends` are deliberately not inputs: only the
 * recorded reason and the predicted paths carry a routing signal.
 * @param {{
 *   creates?: string[],
 *   refactors?: string[],
 *   reason?: string,
 *   injectedRules?: object,
 * }} args
 * @returns {{ action: string, suitability: object, outcome: object }}
 */
export function runLightGate({
  creates = [],
  refactors = [],
  reason,
  injectedRules,
} = {}) {
  const predictedChanges = buildPredictedChanges({ creates, refactors });
  const suitability = deriveLightSuitability({
    predictedChanges,
    verdict: { reason },
    injectedRules,
  });
  const outcome = resolveLightGateOutcome({ suitability });
  return { action: outcome.action, suitability, outcome };
}

/**
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
  const ticket = buildReceiptStoryTicket({
    prompt,
    changedFiles,
    amends,
  });
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
 * @param {object} values
 * @param {{ resolveFn?: typeof resolveBackstopOutcome }} [deps]
 * @returns {Promise<number>}
 */
async function runBackstopMode(values, deps = {}) {
  const { resolveFn = resolveBackstopOutcome } = deps;
  const storyId = Number.parseInt(String(values.story ?? ''), 10);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    process.stderr.write(HELP);
    throw new Error('[deliver-light] --backstop requires --story <id>');
  }
  const { result, nextCommand, preservation, exitCode, message } =
    await resolveFn({ storyId });
  const extra = nextCommand === null ? {} : { nextCommand, preservation };
  emit({ mode: 'backstop', storyId, ...result, ...extra }, values.pretty);
  if (result.blocked) Logger.warn(message);
  else Logger.info(message);
  return exitCode;
}

/**
 * The escalate branch sits above every creation call site, so "nothing was
 * started" is a property of the control flow, not a claim of the envelope.
 * @param {object} values
 * @param {{
 *   createProviderFn?: typeof createProvider,
 *   resolveConfigFn?: typeof resolveConfig,
 *   createReceiptFn?: typeof createLightReceipt,
 *   emitFn?: typeof emit,
 *   emitTerminalFn?: typeof emitTerminalEnvelope,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runGateMode(values, deps = {}) {
  const {
    createProviderFn = createProvider,
    resolveConfigFn = resolveConfig,
    createReceiptFn = createLightReceipt,
    emitFn = emit,
    emitTerminalFn = emitTerminalEnvelope,
    recordRefusalFn = recordGateRefusal,
  } = deps;

  if (!values.prompt || String(values.prompt).trim() === '') {
    process.stderr.write(HELP);
    throw new Error('[deliver-light] --prompt <text> is required for the gate');
  }

  const gate = runLightGate({
    creates: parseCsvPaths(values.creates),
    refactors: parseCsvPaths(values.refactors),
    reason: values.reason,
  });

  if (gate.action !== 'proceed-light') {
    const envelope = buildEscalationTerminal({
      prompt: String(values.prompt),
      reasons: gate.outcome.reasons,
    });
    emitTerminalFn(envelope);
    // Telemetered so the rules stay recalibratable from evidence.
    await recordRefusalFn({ gate, amends: values.amends });
    Logger.warn(
      `[deliver-light] ESCALATED to /mandrel-plan — the light path ENDS here; run ${envelope.nextCommand}, seeded with these reasons: ${gate.outcome.reasons.join('; ')}`,
    );
    return exitCodeForTerminal(envelope);
  }

  const provider = createProviderFn(resolveConfigFn());
  const receipt = await createReceiptFn({
    provider,
    prompt: String(values.prompt),
    changedFiles: [
      ...parseCsvPaths(values.creates),
      ...parseCsvPaths(values.refactors),
    ],
    amends: values.amends ?? null,
  });
  emitFn(
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
      reason: { type: 'string' },
      amends: { type: 'string' },
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
  usage: HELP,
});
