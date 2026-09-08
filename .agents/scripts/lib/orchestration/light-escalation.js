/**
 * lib/orchestration/light-escalation.js — what the light path does when it
 * refuses a scope (Story #4856).
 *
 * Three behaviors, each previously missing, and each about a refusal rather
 * than a verdict — the verdicts live in
 * {@link module:lib/orchestration/light-suitability}:
 *
 *   1. **Recycling the receipt.** A blocked diff backstop used to tell the
 *      operator to "escalate to `/mandrel-plan`", which authored a brand-new Story and
 *      left the receipt open with no successor — orphaning its branch, its
 *      worktree, and a finished implementation. Naming the receipt as `/mandrel-plan`'s
 *      *input* recycles it instead: tickets mode already fetches a ticket,
 *      rewrites it into properly-planned Stories, and closes the source as
 *      superseded.
 *
 *      Deferring receipt creation until after the backstop would be the other
 *      fix, and is deliberately not taken: the issue id is load-bearing in
 *      `single-story-init.js` (the assignee lease, the `story-<id>` branch, the
 *      label state machine) and in the `(refs #<id>)` commit subject.
 *
 *   2. **Telemetering the refusal.** Neither light-path rejection emitted any
 *      signal, so an over-tight ceiling could only reach the framework as
 *      anecdote — which is exactly how the `maxFiles: 4` defect surfaced. The
 *      roll-up aggregates by category, so recording these makes the ceilings
 *      recalibratable from evidence.
 *
 *   3. **Preserving the refused work** ({@link preserveRefusedWork}, Story
 *      #4875). A refusal used to leave a finished implementation on a local
 *      `story-<id>` branch with no remote ref — the one shape routine branch
 *      and worktree cleanup is entitled to delete. The branch is published to
 *      `origin` (no PR, no merge) so the recycle command has something to
 *      recycle.
 *
 * Telemetry is best-effort by construction: a signals-write failure must never
 * change a gate's verdict.
 *
 * @module lib/orchestration/light-escalation
 */

import { getStoryBranch, gitSpawn } from '../git-utils.js';
import {
  emitRuntimeFriction,
  lightScopeRejectedCategory,
  RUNTIME_FRICTION_CATEGORIES,
} from '../observability/runtime-friction.js';
import { LIGHT_REFUSAL_CLASSES } from './light-suitability.js';

/**
 * The `/mandrel-plan` invocation that owns a Story the light path could not land.
 *
 * @param {number} storyId
 * @returns {string}
 */
function buildRecycleCommand(storyId) {
  return `/mandrel-plan ${storyId}`;
}

/**
 * The command that re-runs the backstop once the work is committed.
 *
 * The one refusal that is NOT about scope gets its own next step: an empty diff
 * over a dirty worktree means the backstop ran before the commit, and handing
 * that run to `/mandrel-plan` recycles a receipt whose implementation is fine
 * — the wrong door, dressed as an escalation (issue #5237).
 *
 * @param {number} storyId
 * @returns {string}
 */
function buildRerunBackstopCommand(storyId) {
  return `node .agents/scripts/deliver-light.js --backstop --story ${storyId}`;
}

/**
 * Coerce an `--amends` argument (`#123` or `123`) into a positive integer issue
 * number, or `null` when absent/malformed.
 *
 * This is the only Story context a **gate-stage** rejection can legitimately
 * claim: the signals stream is keyed on a Story id, and an `ask-operator` gate
 * has authored no receipt yet — deliberately, since not creating one is the
 * point of that outcome. A bare prompt's rejection therefore has no stream to
 * land in, and attributing it to a fabricated id would be worse than recording
 * nothing.
 *
 * @param {unknown} amends
 * @returns {number|null}
 */
function normalizeAmendsId(amends) {
  const match = /^#?(\d+)$/.exec(String(amends ?? '').trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Record a suitability-gate refusal (`ask-operator`) as friction, attributed to
 * the `--amends` target when there is one.
 *
 * @param {{
 *   gate: object,
 *   amends?: unknown,
 *   recordFrictionFn?: typeof recordScopeFriction,
 * }} args
 * @returns {Promise<boolean>}
 */
export async function recordGateRefusal({
  gate,
  amends,
  emitFn,
  recordFrictionFn = recordScopeFriction,
} = {}) {
  return recordFrictionFn({
    emitFn,
    storyId: normalizeAmendsId(amends),
    surface: 'suitability-gate',
    reasons: gate?.outcome?.reasons ?? [],
    details: {
      action: gate?.action ?? null,
      code: gate?.suitability?.shape?.code ?? null,
    },
  });
}

/**
 * Handle a blocked diff backstop: record the refusal as friction and return the
 * `/mandrel-plan` invocation that recycles the receipt.
 *
 * Lives here rather than in the CLI so the shell stays a shell — the backstop
 * mode's job is to branch and print, not to decide what a refusal means.
 *
 * @param {{
 *   storyId: number,
 *   result: object,
 *   preservation?: ReturnType<typeof preserveRefusedWork>,
 *   recordFrictionFn?: typeof recordScopeFriction,
 * }} args `result` is a {@link module:lib/orchestration/light-suitability.checkLightDiffBackstop}
 *   verdict; `preservation` is the {@link preserveRefusedWork} outcome.
 * @returns {Promise<string>} The recycle command.
 */
export async function handleBlockedBackstop({
  storyId,
  result,
  preservation,
  emitFn,
  recordFrictionFn = recordScopeFriction,
} = {}) {
  const refusalClass = result?.refusalClass ?? null;
  await recordFrictionFn({
    emitFn,
    storyId,
    surface: 'diff-backstop',
    category: lightScopeRejectedCategory(refusalClass),
    reasons: result?.reasons ?? [],
    details: {
      fileCount: result?.fileCount ?? null,
      implFiles: result?.magnitude?.implFiles ?? null,
      implLines: result?.magnitude?.implLines ?? null,
      ceilings: result?.ceilings ?? null,
      classes: result?.classes ?? [],
      // A refusal whose work was NOT preserved is a different (worse) event
      // than one whose branch reached origin — the roll-up must be able to
      // tell them apart.
      preserved: preservation?.preserved ?? null,
      refusalClass,
    },
  });
  return refusalClass === LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK
    ? buildRerunBackstopCommand(storyId)
    : buildRecycleCommand(storyId);
}

/**
 * Publish a refused light run's branch to `origin` so the finished work is
 * recoverable (Story #4875).
 *
 * A blocked backstop refuses the *land*, not the *work*: the implementation is
 * complete and the recycle command hands the receipt to `/mandrel-plan`, which will
 * want it. Before this, that work existed only as a local `story-<id>` branch
 * with no remote ref — an untracked branch is exactly what the routine merged-
 * branch sweeps and worktree reaping treat as disposable, so the only copy of a
 * finished implementation sat one cleanup away from deletion.
 *
 * Pushing is deliberately **not** a landing: the branch gets a remote ref, no
 * PR is opened, and nothing merges. Total by construction — a push failure
 * (offline, no write access, no such branch) is reported and never changes the
 * refusal verdict, because a preservation attempt must not be able to turn a
 * blocked backstop into a crash.
 *
 * Idempotent: re-running against an already-pushed branch is an up-to-date
 * no-op.
 *
 * @param {{
 *   storyId: number,
 *   cwd?: string,
 *   gitFn?: typeof gitSpawn,
 * }} args
 * @returns {{
 *   preserved: boolean,
 *   branch: string,
 *   remoteRef: string|null,
 *   detail: string,
 * }}
 */
export function preserveRefusedWork({
  storyId,
  cwd = process.cwd(),
  gitFn = gitSpawn,
} = {}) {
  const branch = getStoryBranch(storyId);
  const unpreserved = (detail) => ({
    preserved: false,
    branch,
    remoteRef: null,
    detail,
  });
  let result;
  try {
    result = gitFn(cwd, 'push', '--set-upstream', 'origin', branch);
  } catch (err) {
    return unpreserved(
      `could not publish ${branch}: ${err?.message ?? err} — the finished work is LOCAL ONLY; push it before any branch cleanup runs`,
    );
  }
  if (result?.status !== 0) {
    return unpreserved(
      `could not publish ${branch}: ${result?.stderr || 'git push failed'} — the finished work is LOCAL ONLY; push it before any branch cleanup runs`,
    );
  }
  return {
    preserved: true,
    branch,
    remoteRef: `origin/${branch}`,
    detail: `refused work preserved on origin/${branch} — the branch is no longer the only copy, and no PR was opened`,
  };
}

/**
 * Record a light-path scope rejection as friction.
 *
 * Total: never throws, and returns `false` rather than propagating when the
 * signals surface is unavailable.
 *
 * @param {{
 *   storyId?: number|null,
 *   surface: string,
 *   category?: string,
 *   reasons?: string[],
 *   details?: object,
 *   emitFn?: typeof emitRuntimeFriction,
 * }} args `category` defaults to the unclassified light-refusal bucket, which
 *   is what the suitability gate emits: it refuses a prompt before any diff
 *   exists, so it carries no refusal class to encode.
 * @returns {Promise<boolean>}
 */
async function recordScopeFriction({
  storyId,
  surface,
  category = RUNTIME_FRICTION_CATEGORIES.LIGHT_SCOPE_REJECTED,
  reasons = [],
  details = {},
  emitFn,
} = {}) {
  const emit = emitFn ?? emitRuntimeFriction;
  try {
    return await emit({
      storyId,
      category,
      tool: 'deliver-light',
      details: { surface, reasons, ...details },
    });
  } catch {
    return false;
  }
}
