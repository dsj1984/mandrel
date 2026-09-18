/**
 * The one terminal envelope every Story close-and-land emits — sole writer of
 * `story-deliver-terminal.schema.json` — plus the next-command vocabulary
 * shared with `deliver-recover.js`.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { storyTerminalEnvelopePath } from '../config/temp-paths.js';
import { resolveConfig } from '../config-resolver.js';
import { validateTerminalEnvelope } from './story-deliver-terminal-schema.js';

export { validateTerminalEnvelope };

export const TERMINAL_ENVELOPE_KIND = 'story-deliver-terminal';

/**
 * `pending` has its own code so a caller can tell a resumable slow-CI wait
 * from a hard block without parsing stdout.
 */
export const TERMINAL_EXIT_CODES = Object.freeze({
  landed: 0,
  pending: 3,
  blocked: 1,
  failed: 1,
  /** Reuses `/deliver-light`'s "did not proceed light" code. */
  escalated: 2,
});

export const TERMINAL_STATUSES = Object.freeze([
  'landed',
  'pending',
  'blocked',
  'failed',
  'escalated',
]);

const PLAN_PROMPT_MAX = 200;

/**
 * One line, quote-escaped, length-capped. A non-string yields `''`.
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

/** Every "what now?" answer builds its command here so surfaces never drift. */
export const NEXT_COMMANDS = Object.freeze({
  /**
   * `--wait` is load-bearing: without it the cumulative-budget give-up never
   * fires and a wedged PR is never escalated.
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
  /** A slash command, not a script: the work has no Story yet. */
  escalateToPlan: (prompt) => `/mandrel-plan "${quoteForPlan(prompt)}"`,
});

/**
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
 * Throws a `TypeError` on a schema violation — callers trust the status
 * without re-probing GitHub. An unreadable schema does not throw.
 *
 * @param {object} args
 * @param {number|null} args.storyId `null` only for `escalated`.
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
 * @param {{ waitedSeconds: number, expired: boolean }|null} [args.lockWait]
 *   Full-suite lock wait; `waitBudget` is merge-wait only.
 * @param {string} [args.timestamp]
 * @param {{ schema: object|null, error: string|null }} [args.schemaSource]
 *   Test seam.
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
  lockWait,
  timestamp = new Date().toISOString(),
  schemaSource,
}) {
  const envelope = compact({
    kind: TERMINAL_ENVELOPE_KIND,
    // Nullish stays null (not `Number(null)` = 0); the schema decides.
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
    lockWait: lockWait ?? null,
    timestamp,
  });

  // `undefined` schemaSource triggers the callee's default.
  const { valid, errors } = validateTerminalEnvelope(envelope, {
    schemaSource,
  });
  if (!valid) {
    throw new TypeError(
      `buildTerminalEnvelope: assembled envelope violates story-deliver-terminal.schema.json:\n` +
        errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
  return envelope;
}

/**
 * The one envelope emitted before a Story exists. The schema pins `storyId`
 * null and `escalation.created.*` false — nothing was started.
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
    throw new TypeError(
      'buildEscalationTerminal: a non-empty prompt is required — the escalated terminal exists to name the /mandrel-plan invocation that owns the work',
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
          : [
              'predicted scope exceeds the light ceilings — escalate to /mandrel-plan',
            ],
      // Asserted, not computed: escalation returns before receipt/init.
      created: { receiptStory: false, storyBranch: false, worktree: false },
    },
    nextCommand: NEXT_COMMANDS.escalateToPlan(prompt),
    elapsedSeconds,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

/**
 * @param {object} envelope
 * @returns {number}
 */
export function exitCodeForTerminal(envelope) {
  return TERMINAL_EXIT_CODES[envelope?.status] ?? 1;
}

export const TERMINAL_BEGIN_MARKER = '--- STORY DELIVER TERMINAL ---';
export const TERMINAL_END_MARKER = '--- END TERMINAL ---';

/**
 * `undefined` on an unreadable config: the default temp root beats no copy.
 *
 * @param {typeof resolveConfig} resolveConfigImpl
 * @returns {object|undefined}
 */
function tolerantConfig(resolveConfigImpl) {
  try {
    return resolveConfigImpl();
  } catch {
    return undefined;
  }
}

/**
 * Disk copy of the envelope beside the Story's gate log — stdout's one reader
 * may have ended its turn. Best-effort (every failure returns `null`; stdout
 * is the contract) and atomic (pid-scoped tmp + rename, since a router may
 * poll mid-close). `config` is resolved lazily because crash-path emitters
 * have none, and the default temp root is where no router looks.
 *
 * @param {object} envelope A validated terminal envelope.
 * @param {{
 *   config?: object,
 *   fsImpl?: typeof nodeFs,
 *   resolveConfigImpl?: typeof resolveConfig,
 * }} [deps]
 * @returns {string|null} The path written, or `null` when nothing was.
 */
export function persistTerminalEnvelope(
  envelope,
  { config, fsImpl = nodeFs, resolveConfigImpl = resolveConfig } = {},
) {
  const storyId = envelope?.storyId;
  if (!Number.isInteger(storyId) || storyId <= 0) return null;
  let tmpPath = null;
  try {
    const resolved = config ?? tolerantConfig(resolveConfigImpl);
    const target = storyTerminalEnvelopePath(storyId, resolved);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    tmpPath = `${target}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmpPath, `${JSON.stringify(envelope)}\n`, 'utf8');
    fsImpl.renameSync(tmpPath, target);
    return target;
  } catch {
    if (tmpPath) {
      try {
        fsImpl.rmSync(tmpPath, { force: true });
      } catch {
        // Best-effort.
      }
    }
    return null;
  }
}

/**
 * Not `Logger.info`: a contract payload must survive `AGENT_LOG_LEVEL=silent`.
 * Single home of the marker format for every emit site. Persists first, so a
 * caller that read the markers can rely on the file existing.
 *
 * @param {object} envelope
 * @param {{
 *   write?: (s: string) => void,
 *   config?: object,
 *   persist?: typeof persistTerminalEnvelope,
 * }} [opts] `write` and `persist` are test seams.
 * @returns {void}
 */
export function emitTerminalEnvelope(
  envelope,
  {
    write = (s) => process.stdout.write(s),
    config,
    persist = persistTerminalEnvelope,
  } = {},
) {
  try {
    persist(envelope, { config });
  } catch {
    // The disk copy must never cost the caller the stdout contract.
  }
  // Compact JSON: pretty-printing only adds turn-resident bytes.
  write(
    `\n${TERMINAL_BEGIN_MARKER}\n${JSON.stringify(envelope)}\n${TERMINAL_END_MARKER}\n`,
  );
}

/**
 * Map a `runConfirmMergePhase` outcome onto the terminal envelope.
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
  lockWait,
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
    lockWait,
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
        // Observed, not assumed: admin merges land with checks red.
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

  // blocked — mirror the classifier's remediation, never a second opinion.
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
