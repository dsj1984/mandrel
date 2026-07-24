/**
 * story-deliver-terminal.js — the one terminal envelope every Story
 * close-and-land invocation emits, and the shared next-command vocabulary
 * (Story #4543).
 *
 * Before this module the delivery tail had **two** divergent return
 * contracts, both prose and neither validated:
 * `.agents/workflows/helpers/deliver-story.md` defined one shape and
 * `.agents/agents/story-worker.md` a different one, so a caller could not
 * distinguish a landed Story from a parked one without re-probing GitHub.
 * `story-deliver-terminal.schema.json` is now the SSOT both docs reference
 * rather than restate, and this module is its only writer.
 *
 * Two exports carry the contract:
 *
 *   - {@link buildTerminalEnvelope} assembles and **validates** the envelope.
 *     It throws on a schema violation rather than emitting a malformed
 *     terminal: a silently-wrong terminal is exactly the failure this Story
 *     exists to eliminate, so failing loudly at the writer is the point.
 *   - {@link NEXT_COMMANDS} is the next-command vocabulary shared with
 *     `deliver-recover.js`, so a `pending` envelope and a recovery probe
 *     name the same command for the same state instead of inventing two
 *     dialects for one condition.
 *
 * `TERMINAL_EXIT_CODES` maps status → process exit code. `pending` gets its
 * **own** code (3) precisely so a caller can tell "slow CI, resume me" from
 * "hard block, come look" without parsing stdout — the distinction the
 * pre-#4543 pipeline collapsed by treating budget exhaustion as a block.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'schemas',
  'story-deliver-terminal.schema.json',
);

export const TERMINAL_ENVELOPE_KIND = 'story-deliver-terminal';

/**
 * status → process exit code.
 *
 * `pending` is **3**, not 0 and not 1. Zero would tell a headless caller the
 * Story landed when it did not; one would conflate a resumable slow-CI wait
 * with a hard block and send the operator to diagnose branch protection that
 * is working fine. A distinct code is what lets `/deliver` resume without
 * classifying.
 */
export const TERMINAL_EXIT_CODES = Object.freeze({
  landed: 0,
  pending: 3,
  blocked: 1,
  failed: 1,
  /**
   * `escalated` reuses **2**, the code `/deliver-light` already documents for
   * "the gate did not proceed light" — the escalation is that outcome made
   * terminal, not a new one, so giving it a fresh code would fork a vocabulary
   * callers already branch on. It stays distinct from `landed` (nothing was
   * delivered) and from `blocked`/`failed` (nothing is wrong — the work simply
   * belongs to `/plan`).
   */
  escalated: 2,
});

export const TERMINAL_STATUSES = Object.freeze([
  'landed',
  'pending',
  'blocked',
  'failed',
  'escalated',
]);

/** Cap on the prompt echoed into an escalation's `/plan` next command. */
const PLAN_PROMPT_MAX = 200;

/**
 * Render an operator prompt safe to sit inside the double quotes of the
 * `/plan "<prompt>"` next command: collapse newlines (a next command is one
 * line by contract), escape backslashes and double quotes so the quoting
 * cannot be broken out of, and cap the length so a long prompt does not turn
 * the envelope into a transcript. Total — a non-string yields the empty
 * string, which the escalation builder rejects rather than emitting.
 *
 * @param {unknown} prompt
 * @returns {string}
 */
function quoteForPlan(prompt) {
  const text =
    typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';
  const capped =
    text.length > PLAN_PROMPT_MAX
      ? `${text.slice(0, PLAN_PROMPT_MAX - 1).trimEnd()}…`
      : text;
  return capped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The shared next-command vocabulary. Every producer of a "what now?"
 * answer — the `pending` terminal envelope, an `escalated` one, and
 * `deliver-recover.js` — builds its command from here, so the surfaces never
 * drift into naming different commands for the same observed state.
 */
export const NEXT_COMMANDS = Object.freeze({
  /**
   * Resume a bounded merge wait that expired with the PR still in flight.
   *
   * `--wait` is load-bearing: without it the confirm CLI probes once and
   * answers `pending` again, so the cumulative-budget give-up never fires and
   * a wedged PR is never escalated to anyone.
   */
  resumeLand: (storyId) =>
    `node .agents/scripts/single-story-confirm-merge.js --story ${storyId} --wait`,
  /** Confirm a merged-but-mislabelled Story (the idempotent flip + tail). */
  confirmMerge: (storyId) =>
    `node .agents/scripts/single-story-confirm-merge.js --story ${storyId}`,
  /** Enter the red-CI fix loop against the failing PR. */
  watchCi: (storyId, prNumber) =>
    `node .agents/scripts/pr-watch-with-update.js --pr ${prNumber} --story ${storyId}`,
  /** Re-run close for a Story whose PR was never opened. */
  close: (storyId) =>
    `node .agents/scripts/single-story-close.js --story ${storyId}`,
  /** Resume implementation in the Story worktree. */
  implement: (storyId) =>
    `node .agents/scripts/single-story-init.js --story ${storyId}`,
  /** Re-assert a drifted Projects v2 Status column. */
  resync: (storyId) =>
    `node .agents/scripts/resync-status-column.js --story ${storyId}`,
  /** Probe a stranded Story and print its single next command. */
  recover: (storyId) =>
    `node .agents/scripts/deliver-recover.js --story ${storyId}`,
  /**
   * Hand over-scope work to `/plan` — the next command of an `escalated`
   * terminal (Story #4746).
   *
   * The only entry here that is a slash command rather than a script, and
   * deliberately so: the other entries resume a Story that exists, while this
   * one names work that has no Story yet and needs planning before it can have
   * one. It is quoted for a shell but addressed to a **fresh session** — see
   * the workflow's escalation section for why running it in the escalating
   * session is forbidden.
   */
  escalateToPlan: (prompt) => `/plan "${quoteForPlan(prompt)}"`,
});

/** @type {Function|null} */
let _validator = null;

/**
 * Compile (once) and return the terminal-envelope validator.
 *
 * @returns {Function}
 */
function getValidator() {
  if (_validator) return _validator;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  _validator = ajv.compile(schema);
  return _validator;
}

/**
 * Validate a candidate envelope against the shipped schema.
 *
 * @param {object} envelope
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTerminalEnvelope(envelope) {
  const validate = getValidator();
  const valid = validate(envelope);
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message}`,
  );
  return { valid: false, errors };
}

/**
 * Drop `undefined`-valued keys so the schema's `additionalProperties: false`
 * and its nullable unions both stay satisfiable from one optional-argument
 * builder signature.
 *
 * @param {object} obj
 * @returns {object}
 */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Assemble the terminal envelope and validate it before returning.
 *
 * Throws a `TypeError` naming the schema violations when the assembled
 * object does not validate. That is deliberate: the whole point of the
 * envelope is that a caller can trust its status without re-probing
 * GitHub, so emitting an unvalidated one would reintroduce the ambiguity
 * this replaces.
 *
 * @param {object} args
 * @param {number|null} args.storyId `null` only for an `escalated` terminal,
 *   which by construction never authored a Story.
 * @param {'landed'|'pending'|'blocked'|'failed'|'escalated'} args.status
 * @param {string} args.phase
 * @param {string} [args.storyBranch]
 * @param {string} [args.baseBranch]
 * @param {object|null} [args.pr]
 * @param {object} [args.gates]
 * @param {object|null} [args.tail]
 * @param {object|null} [args.blocked]
 * @param {object|null} [args.failure]
 * @param {object|null} [args.escalation]
 * @param {string|null} [args.nextCommand]
 * @param {number} args.elapsedSeconds
 * @param {object|null} [args.waitBudget]
 * @param {string} [args.timestamp]
 * @returns {object} The validated envelope.
 */
export function buildTerminalEnvelope({
  storyId,
  status,
  phase,
  storyBranch,
  baseBranch,
  pr,
  gates,
  tail,
  blocked,
  failure,
  escalation,
  nextCommand,
  elapsedSeconds = 0,
  waitBudget,
  timestamp = new Date().toISOString(),
}) {
  const envelope = compact({
    kind: TERMINAL_ENVELOPE_KIND,
    // `Number(null)` is 0, which would quietly satisfy nothing and confuse
    // everything — a nullish storyId stays null and lets the schema decide
    // whether this status is allowed to omit one.
    storyId: storyId === null || storyId === undefined ? null : Number(storyId),
    status,
    phase,
    storyBranch: storyBranch ?? null,
    baseBranch: baseBranch ?? null,
    pr: pr ?? null,
    gates,
    tail: tail ?? null,
    blocked: blocked ?? null,
    failure: failure ?? null,
    escalation: escalation ?? null,
    nextCommand: nextCommand ?? null,
    elapsedSeconds: Math.max(0, Number(elapsedSeconds) || 0),
    waitBudget: waitBudget ?? null,
    timestamp,
  });

  const { valid, errors } = validateTerminalEnvelope(envelope);
  if (!valid) {
    throw new TypeError(
      `buildTerminalEnvelope: assembled envelope violates story-deliver-terminal.schema.json:\n` +
        errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
  return envelope;
}

/**
 * Build the `escalated` terminal — the one envelope emitted before a Story
 * exists (Story #4746).
 *
 * `/deliver-light`'s suitability gate already decided correctly when it
 * overrode a `lite` self-verdict on shape; what it lacked was an outcome a
 * session could not walk past. A mandrel-bench 2.13.0 light-arm run did
 * exactly that — it read the gate's `escalate-plan`, then invoked `/plan`
 * in the same session and delivered. The continuation was not harmless:
 * planning inside a session already framed as small work authored ONE Story
 * against the scenario's 3-5 contract, where a fresh `/plan` session on the
 * identical seed authored four. Escalation silently produced the very
 * under-decomposition the guard exists to prevent.
 *
 * So the outcome is a validated envelope with its own exit code, naming the
 * `/plan` command that owns the work, and asserting per artifact that nothing
 * was started. Every guarantee here is enforced by the schema rather than by
 * prose: `storyId` must be null, `escalation.created.*` are pinned `false`.
 *
 * @param {{
 *   prompt: string,
 *   reasons?: string[],
 *   elapsedSeconds?: number,
 *   timestamp?: string,
 * }} args
 * @returns {object} The validated `escalated` envelope.
 */
export function buildEscalationTerminal({
  prompt,
  reasons,
  elapsedSeconds = 0,
  timestamp,
}) {
  const quoted = quoteForPlan(prompt);
  if (quoted === '') {
    // An escalation whose next command is `/plan ""` hands the operator
    // nothing — the same walk-past-able non-outcome in envelope clothing.
    throw new TypeError(
      'buildEscalationTerminal: a non-empty prompt is required — the escalated terminal exists to name the /plan invocation that owns the work',
    );
  }
  const recorded = (Array.isArray(reasons) ? reasons : []).filter(
    (r) => typeof r === 'string' && r.trim() !== '',
  );
  return buildTerminalEnvelope({
    storyId: null,
    status: 'escalated',
    phase: 'suitability-gate',
    escalation: {
      reasons:
        recorded.length > 0
          ? recorded
          : ['predicted scope exceeds the light ceilings — escalate to /plan'],
      // Not computed from anything: the escalation path returns before the
      // receipt/init call sites, so these are the assertion that it did.
      created: { receiptStory: false, storyBranch: false, worktree: false },
    },
    nextCommand: NEXT_COMMANDS.escalateToPlan(prompt),
    elapsedSeconds,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

/**
 * Resolve the process exit code for a terminal envelope.
 *
 * @param {object} envelope
 * @returns {number}
 */
export function exitCodeForTerminal(envelope) {
  return TERMINAL_EXIT_CODES[envelope?.status] ?? 1;
}

/** The markers a caller scans stdout for to recover the envelope. */
export const TERMINAL_BEGIN_MARKER = '--- STORY DELIVER TERMINAL ---';
export const TERMINAL_END_MARKER = '--- END TERMINAL ---';

/**
 * Write a terminal envelope to stdout, between its markers.
 *
 * **Deliberately not `Logger.info`.** The envelope is this CLI's
 * machine-readable contract — every invocation emits exactly ONE, and a
 * headless caller parses it out of stdout to decide what happened.
 * `Logger.info` is level-gated, so under the documented
 * `AGENT_LOG_LEVEL=silent` (§ 1.H) the envelope silently vanished and the
 * caller got a bare exit code: precisely the "no envelope at all" outcome
 * Story #4543 exists to remove. A contract payload must not be suppressible
 * by a verbosity knob.
 *
 * Single home for the marker format so the four emit sites (the runner's
 * terminal, the close CLI's failed-terminal catch, and both confirm-CLI
 * paths) cannot drift apart.
 *
 * @param {object} envelope
 * @param {{ write?: (s: string) => void }} [opts] `write` is a test seam.
 * @returns {void}
 */
export function emitTerminalEnvelope(
  envelope,
  { write = (s) => process.stdout.write(s) } = {},
) {
  // Story #4685 — compact (not 2-space pretty) JSON. The envelope is a
  // machine contract callers recover with `JSON.parse`, so pretty-printing
  // only adds turn-resident bytes without helping any consumer.
  write(
    `\n${TERMINAL_BEGIN_MARKER}\n${JSON.stringify(envelope)}\n${TERMINAL_END_MARKER}\n`,
  );
}

/**
 * Map a `runConfirmMergePhase` outcome onto the schema-validated terminal
 * envelope (Story #4543). One writer, one shape — the two prose contracts
 * this replaces disagreed with each other precisely because each surface
 * assembled its own.
 *
 * @returns {object} A validated `story-deliver-terminal` envelope.
 */
export function terminalFromWaitOutcome({
  waitOutcome,
  storyId,
  storyBranch,
  baseBranch,
  prNumber,
  prUrl,
  autoMergeEnabled,
  gates,
  elapsedSeconds,
}) {
  const prBase = {
    number: prNumber,
    url: prUrl ?? null,
    autoMergeEnabled: Boolean(autoMergeEnabled),
  };
  const common = {
    storyId,
    storyBranch,
    baseBranch,
    gates,
    elapsedSeconds,
  };

  if (waitOutcome.terminal === 'landed') {
    return buildTerminalEnvelope({
      ...common,
      status: 'landed',
      phase: 'post-land',
      pr: {
        ...prBase,
        state: 'MERGED',
        // The observed rollup, not an assumed 'success' — a merge can land by
        // admin override or with non-required checks red.
        checksStatus: waitOutcome.prProbe?.checksStatus ?? null,
      },
      tail: waitOutcome.tail,
      nextCommand: null,
    });
  }

  if (waitOutcome.terminal === 'pending') {
    return buildTerminalEnvelope({
      ...common,
      status: 'pending',
      phase: 'confirm-merge',
      pr: {
        ...prBase,
        state: waitOutcome.prProbe?.state ?? 'OPEN',
        checksStatus: waitOutcome.prProbe?.checksStatus ?? null,
      },
      waitBudget: waitOutcome.waitBudget,
      nextCommand: NEXT_COMMANDS.resumeLand(storyId),
    });
  }

  // blocked — the classifier already named the class and the friction
  // comment already carries the class-specific remediation, so the next
  // command mirrors it rather than inventing a second opinion.
  const nextCommand =
    waitOutcome.blockClass === 'checks-failed'
      ? NEXT_COMMANDS.watchCi(storyId, prNumber)
      : waitOutcome.blockClass === 'merged-flip-failed'
        ? NEXT_COMMANDS.confirmMerge(storyId)
        : NEXT_COMMANDS.recover(storyId);
  return buildTerminalEnvelope({
    ...common,
    status: 'blocked',
    phase: 'confirm-merge',
    pr: {
      ...prBase,
      state: waitOutcome.prProbe?.state ?? null,
      checksStatus: waitOutcome.prProbe?.checksStatus ?? null,
    },
    blocked: {
      blockClass: waitOutcome.blockClass,
      reason: waitOutcome.reason,
      frictionCommentId: waitOutcome.frictionCommentId ?? null,
    },
    nextCommand,
  });
}
