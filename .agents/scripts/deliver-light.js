#!/usr/bin/env node

/**
 * deliver-light.js — the `/deliver-light` entry point (Story #4740).
 *
 * A **thin entry point, not a second delivery engine.** It runs the
 * suitability gate, authors a minimal receipt `type::story`, and then hands off
 * to the SAME engine scripts `/mandrel-deliver` uses:
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
 *     `createStoryIssues` surface) and prints the init/close hand-off,
 *     carrying any predicted-shape `warnings[]` (Story #5313: an over-ceiling
 *     prediction warns, it no longer stops). An un-ledgered verdict or an
 *     un-waivable risk rule emits an `escalated` terminal envelope, never
 *     landing silently. The former attended stop-and-ask outcome and the
 *     flag that answered it went with the gate they answered.
 *   - **backstop** (`--backstop --story <id>`) — re-check the ACTUAL diff of
 *     the Story branch after implementation; exit non-zero when it exceeds the
 *     light ceilings, so an over-scope diff is blocked rather than landed.
 *
 * ## Escalation is terminal, not advisory (Story #4746)
 *
 * Over-scope under `--yes` emits a schema-validated `story-deliver-terminal`
 * envelope with status `escalated` and **ends the session**. Before that it was
 * an ordinary gate envelope plus exit 2 — a warning a caller could walk past,
 * and one mandrel-bench 2.13.0 light-arm run did exactly that: it read the
 * escalation, invoked `/mandrel-plan` in the same session, and delivered. In-session
 * planning under-decomposed (ONE Story against the scenario's 3-5 contract,
 * where a fresh `/mandrel-plan` session on the identical seed authored four), so
 * escalation silently produced the outcome the guard exists to prevent.
 * {@link module:lib/orchestration/story-deliver-terminal.buildEscalationTerminal}
 * carries the guarantees the schema then enforces.
 *
 * Usage:
 *   node .agents/scripts/deliver-light.js --prompt "<text>" \
 *     --creates path,path --acceptance 1 --route lite --reason "<why>"
 *   node .agents/scripts/deliver-light.js --prompt "<text>" --amends '#123' --route lite --reason "<why>"
 *   node .agents/scripts/deliver-light.js --backstop --story 4741
 *
 * Exit codes: 0 ok (proceed / clean backstop), 1 usage error, 2 the gate did
 * not proceed light (an `escalated` terminal), 3 the diff backstop blocked.
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
                   [--acceptance n] [--kinds csv] [--magnitude m]
                   [--uncertainty u] [--route lite|full] [--reason <text>]
                   [--amends '#id'] [--yes]
  deliver-light.js --backstop --story <id>

The thin /deliver-light entry point: suitability gate → inline receipt Story →
the same single-story-init.js / single-story-close.js engine /mandrel-deliver uses.

The gate judges EFFORT and RISK, not artifact counts: N instances of one
mechanical edit is one kind at N sites. A predicted shape past a light ceiling
is a WARNING on the envelope, not a refusal (Story #5313); only an un-ledgered
verdict or an un-waivable risk rule (sensitive path, migration span) escalates.
The --backstop pass enforces size against the actual diff.

Gate options:
  --prompt <text>    Operator prompt describing the change. Required for the gate.
  --creates <csv>    Predicted NEW file paths (comma-separated).
  --refactors <csv>  Predicted edited/existing file paths (comma-separated).
  --acceptance <n>   Predicted acceptance-criteria count (default 1). Not capped.
  --kinds <csv>      Distinct KINDS of change (default: one per assumption, so
                     N same-shaped edits count once).
  --magnitude <m>    Coarse effort bucket: trivial | moderate | substantial
                     (default moderate; substantial routes to /mandrel-plan).
  --uncertainty <u>  determined (the request fixes the shape) | needs-design
                     (default determined; needs-design routes to /mandrel-plan).
  --route <r>        Ledgered model verdict route: lite | full.
  --reason <text>    Recorded reason for a lite verdict (required for lite).
  --amends <#id>     Mark this as an amendment of an existing issue.
  --yes              Unattended marker. Escalation is terminal either way;
                     the flag is accepted so unattended callers keep their
                     invocation shape.

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
 *   kinds?: string[],
 *   magnitude?: string,
 *   uncertainty?: string,
 *   route?: string,
 *   reason?: string,
 *   injectedRules?: object,
 * }} args `kinds` / `magnitude` / `uncertainty` are the declared effort-and-risk
 *   axes the gate judges (Story #4764); omitting them declares no signal, not a
 *   small one — an unrecognized bucket is reported as a warning (Story #5313).
 * @returns {{ action: string, suitability: object, outcome: object }}
 */
export function runLightGate({
  creates = [],
  refactors = [],
  acceptance,
  kinds,
  magnitude,
  uncertainty,
  route,
  reason,
  injectedRules,
} = {}) {
  const predictedChanges = buildPredictedChanges({ creates, refactors });
  const suitability = deriveLightSuitability({
    predictedChanges,
    predictedAcceptance: synthesizeAcceptance(acceptance),
    predictedKinds: kinds,
    predictedMagnitude: magnitude,
    predictedUncertainty: uncertainty,
    verdict: { route, reason },
    injectedRules,
  });
  const outcome = resolveLightGateOutcome({ suitability });
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
 * The engine hand-off — the SAME scripts `/mandrel-deliver` uses. Named here as
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
 * Backstop mode — re-check the actual diff. The decision lives in
 * {@link module:lib/orchestration/light-backstop}; this branches and prints.
 *
 * @param {object} values Parsed CLI values.
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
 * Gate mode — judge the prompt and, on proceed, author the receipt Story.
 *
 * The three outcomes are deliberately asymmetric in what they emit:
 *
 *   - **`escalate-plan`** returns a schema-validated `escalated` **terminal
 *     envelope** and stops (Story #4746). It is placed **first**, above every
 *     creation call site, so "nothing was started" is a property of the
 *     control flow rather than a claim the envelope makes about itself.
 *   - **`proceed-light`** authors the receipt Story and prints the hand-off,
 *     carrying the predicted-shape `warnings[]` (Story #5313) on the envelope
 *     and on stderr, so an over-ceiling prediction is stated rather than
 *     silently waved through. The former attended stop-and-ask outcome is
 *     gone: the gate never had a question a human could answer that the diff
 *     backstop does not answer better.
 *
 * The injectable seams exist so the no-side-effect guarantee is testable
 * without a network: a test asserts the escalate path never reaches them.
 *
 * @param {object} values Parsed CLI values.
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
    acceptance: values.acceptance
      ? Number.parseInt(String(values.acceptance), 10)
      : 1,
    kinds: parseCsvPaths(values.kinds),
    magnitude: values.magnitude,
    uncertainty: values.uncertainty,
    route: values.route,
    reason: values.reason,
  });

  if (gate.action !== 'proceed-light') {
    const envelope = buildEscalationTerminal({
      prompt: String(values.prompt),
      reasons: gate.outcome.reasons,
    });
    emitTerminalFn(envelope);
    // The refusal is still telemetered (Story #4856): the ceilings stay
    // recalibratable from evidence even now that only risk rules refuse.
    await recordRefusalFn({ gate, amends: values.amends });
    Logger.warn(
      `[deliver-light] ESCALATED to /mandrel-plan — this session ENDS here; run ${envelope.nextCommand} in a FRESH session: ${gate.outcome.reasons.join('; ')}`,
    );
    return exitCodeForTerminal(envelope);
  }

  const warnings = gate.outcome.warnings ?? [];
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
      warnings,
      nextCommands: buildNextCommands(receipt.storyId),
      outcome: gate.outcome,
    },
    values.pretty,
  );
  for (const warning of warnings) {
    Logger.warn(`[deliver-light] ⚠ ${warning}`);
  }
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
      kinds: { type: 'string' },
      magnitude: { type: 'string' },
      uncertainty: { type: 'string' },
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
  usage: HELP,
});
