/**
 * deliver-recover.js — probe a stranded Story and name its ONE next command
 * (Story #4543).
 *
 * Recovery here is a **read, not a repair**. Every input is already
 * probeable — labels and lease from the ticket, the branch locally and via
 * its tracking ref, the worktree path, the PR by head branch (with state,
 * merge, and checks probes) — so this module is probes, a decision table
 * over `label × PR × branch × worktree`, and one command with the evidence it
 * was derived from. It never mutates anything, and it never prints a menu of
 * options: a menu is what an operator already has, and it is the thing they
 * cannot act on.
 *
 * The strand shapes the table resolves, and why each is real:
 *
 *   - `executing`, branch UNPUSHED, no PR → resume implementation. The work
 *     never reached close. Since Story #5267 the worker pushes before its
 *     creditable capture, so an unpushed branch means this and nothing else.
 *   - `executing`, branch PUSHED, no PR → run close. The worker's hand-off
 *     landed; only the close-and-land tail is owed, and re-initializing here
 *     would re-open finished work.
 *   - `closing` with a pending PR → resume the land. The overwhelmingly
 *     common shape now that the merge wait is bounded: the wait returned
 *     `pending` and something has to pick it back up.
 *   - `closing` with a red PR → enter the fix loop. Waiting is pointless; no
 *     budget turns a failed check green.
 *   - `closing` with a MERGED PR → run confirm. **This is the strand a
 *     `/mandrel-deliver` re-run refuses outright**, because `single-story-init.js`
 *     hard-errors on an already-closed Story — so before this surface, the
 *     merged-but-label-stale Story had no automated way back.
 *   - `done` with a drifted board → run resync. The GitHub Projects bot won
 *     the race.
 *   - `blocked` → print the class-specific remediation the friction comment
 *     already names, rather than inventing a second opinion about a
 *     condition that was already classified.
 *
 * The command vocabulary is shared with the terminal envelope
 * (`story-deliver-terminal.js#NEXT_COMMANDS`), so recovery and normal
 * resumption speak one language instead of two dialects for one state.
 */

import nodeFs from 'node:fs';

import {
  closeGateLogPath,
  storyTerminalEnvelopePath,
} from '../config/temp-paths.js';
import { gh as defaultGh } from '../gh-exec.js';
import { gitSpawn as defaultGitSpawn, getStoryBranch } from '../git-utils.js';
import { deriveChecksStatus } from './merge-poll.js';
import { NEXT_COMMANDS } from './story-deliver-terminal.js';
import { STATE_LABELS } from './ticketing.js';

/**
 * How recently the gate log must have been appended for the close that writes
 * it to count as live (Story #4816).
 *
 * The window is generous on purpose. Gate output arrives in bursts — a single
 * `npm test` gate can run for a long stretch between lines — so a tight window
 * would read a slow-but-healthy close as dead and re-open the exact
 * misdiagnosis this exists to remove. Being wrong in the other direction is
 * cheap: the verdict for a live close is "re-run this read-only probe", which
 * costs nothing if the close has in fact already exited.
 */
const CLOSE_IN_FLIGHT_WINDOW_MS = 120_000;

/**
 * Probe the ticket: state labels, issue open/closed, and the lease holder.
 *
 * @returns {Promise<object>}
 */
export async function probeTicket({ provider, storyId }) {
  try {
    const ticket = await provider.getTicket(storyId);
    const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
    const stateLabel =
      labels.find((l) => typeof l === 'string' && l.startsWith('agent::')) ??
      null;
    return {
      ok: true,
      stateLabel,
      labels,
      issueState: ticket?.state ?? null,
      title: ticket?.title ?? null,
      lease: ticket?.assignees?.[0] ?? ticket?.assignee ?? null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Probe the Story branch locally and its remote tracking ref, plus the
 * worktree path. Pure git — no network.
 *
 * @returns {object}
 */
export function probeBranch({ cwd, storyBranch, config, gitSpawnFn }) {
  const spawn = gitSpawnFn ?? defaultGitSpawn;
  const localRef = spawn(
    cwd,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${storyBranch}`,
  );
  const remoteRef = spawn(
    cwd,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${storyBranch}`,
  );
  const worktreeRoot =
    config?.delivery?.worktreeIsolation?.root ?? '.worktrees';
  const worktrees = spawn(cwd, 'worktree', 'list', '--porcelain');
  const worktreePath =
    worktrees.status === 0 &&
    typeof worktrees.stdout === 'string' &&
    worktrees.stdout.includes(`${worktreeRoot}/${storyBranch}`)
      ? `${worktreeRoot}/${storyBranch}`
      : null;
  return {
    local: localRef.status === 0,
    remote: remoteRef.status === 0,
    worktreePath,
  };
}

/**
 * Probe the PR for the Story branch. `--state all` is required: a merged PR
 * is no longer `open`, and the merged-but-label-stale strand is precisely
 * the one that matters most here.
 *
 * @returns {Promise<object|null>}
 */
export async function probePr({ storyBranch, gh = defaultGh }) {
  try {
    const rows = await gh.pr.list(
      ['--head', storyBranch, '--state', 'all'],
      ['number', 'url', 'state', 'mergedAt', 'statusCheckRollup'],
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    return {
      number: Number(row?.number) || null,
      url: row?.url ?? null,
      state: row?.state ?? null,
      mergedAt: row?.mergedAt ?? null,
      checksStatus: deriveChecksStatus(row?.statusCheckRollup),
    };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

/**
 * Probe the two on-disk artifacts a close leaves behind (Story #4816): the
 * persisted terminal envelope and the gate log.
 *
 * These exist because the label-and-PR probes above cannot see the difference
 * between an implementation that died and a close that is still running —
 * both read `agent::executing` with no PR for the whole gate chain. The
 * artifacts can: a persisted envelope means the close already reached a
 * verdict, and a recently-appended gate log means one is mid-chain right now.
 * Gate-log freshness is exactly the signal operators were already using by
 * hand to tell the two apart, which is the argument for reading it here
 * instead of expecting them to know.
 *
 * Never throws: an unreadable or absent artifact is a `null` reading, and the
 * table falls back to the label-only verdict it always had.
 *
 * @param {{
 *   storyId: number,
 *   config?: object,
 *   fsImpl?: typeof nodeFs,
 *   nowMs?: number,
 *   windowMs?: number,
 * }} args
 * @returns {{
 *   envelope: object|null,
 *   envelopePath: string|null,
 *   envelopeMtimeMs: number|null,
 *   gateLogPath: string|null,
 *   gateLogAgeMs: number|null,
 *   gateLogMtimeMs: number|null,
 *   gateLogFresh: boolean,
 * }}
 */
export function probeCloseArtifacts({
  storyId,
  config,
  fsImpl = nodeFs,
  nowMs = Date.now(),
  windowMs = CLOSE_IN_FLIGHT_WINDOW_MS,
}) {
  const empty = {
    envelope: null,
    envelopePath: null,
    envelopeMtimeMs: null,
    gateLogPath: null,
    gateLogAgeMs: null,
    gateLogMtimeMs: null,
    gateLogFresh: false,
  };
  let envelopePath = null;
  let gateLogPath = null;
  try {
    envelopePath = storyTerminalEnvelopePath(storyId, config);
    gateLogPath = closeGateLogPath(storyId, config);
  } catch {
    return empty;
  }

  let envelope = null;
  let envelopeMtimeMs = null;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(envelopePath, 'utf8'));
    // A parsed non-object (or an array) is not an envelope; treat it as
    // absent rather than handing the table something it cannot read fields
    // off of.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      envelope = parsed;
      envelopeMtimeMs = fsImpl.statSync(envelopePath).mtimeMs;
    }
  } catch {
    envelope = null;
    envelopeMtimeMs = null;
  }

  let gateLogMtimeMs = null;
  try {
    gateLogMtimeMs = fsImpl.statSync(gateLogPath).mtimeMs;
  } catch {
    gateLogMtimeMs = null;
  }
  const gateLogAgeMs =
    gateLogMtimeMs === null ? null : Math.max(0, nowMs - gateLogMtimeMs);

  return {
    envelope,
    envelopePath,
    envelopeMtimeMs,
    gateLogPath,
    gateLogAgeMs,
    gateLogMtimeMs,
    gateLogFresh: gateLogAgeMs !== null && gateLogAgeMs <= windowMs,
  };
}

/**
 * Is a close running right now, outranking whatever a persisted envelope says?
 *
 * A persisted envelope is definitive about the close that wrote it — but a
 * Story can be closed more than once (a `pending` wait resumed, a red gate
 * fixed and re-run), and a *stale* envelope from the previous attempt must not
 * out-argue a gate log the current attempt is appending to as we read. So the
 * live signal wins whenever the gate log is both fresh and fresher than the
 * envelope.
 *
 * @param {object} artifacts A {@link probeCloseArtifacts} reading.
 * @returns {boolean}
 */
function closeLooksLive(artifacts) {
  if (!artifacts?.gateLogFresh) return false;
  if (artifacts.envelopeMtimeMs === null) return true;
  return artifacts.gateLogMtimeMs > artifacts.envelopeMtimeMs;
}

/**
 * The verdict for a Story whose close already finished but whose envelope
 * never reached the caller — the orphaned-turn shape (Story #4816).
 *
 * Nothing is re-derived here: the envelope on disk is the same
 * schema-validated object the close emitted, so its own `status` and
 * `nextCommand` are relayed rather than a second opinion invented from
 * labels. A `landed` envelope carries a null next command, and the honest
 * follow-up for a landed-but-mislabelled Story is the idempotent confirm.
 */
function envelopeOnDiskVerdict({ storyId, artifacts, evidence }) {
  const { envelope, envelopePath } = artifacts;
  return {
    shape: 'close-envelope-on-disk',
    nextCommand: envelope.nextCommand ?? NEXT_COMMANDS.confirmMerge(storyId),
    detail:
      `The close for this Story already reached a terminal verdict — \`${envelope.status}\` ` +
      `at phase \`${envelope.phase}\` — but the label still reads mid-flight, which is the ` +
      `signature of a worker turn that ended before it could relay the envelope. The close ` +
      `itself is not in doubt: read the full envelope at \`${envelopePath}\` rather than ` +
      `re-deriving its state, and run the command below (the envelope's own \`nextCommand\`, ` +
      `or the idempotent confirm when it landed and named none).`,
    evidence,
  };
}

/**
 * The verdict for a close that is running as we probe (Story #4816).
 *
 * The next command is this probe again. That is not a shrug: there is no
 * attach-to-a-running-close surface, the close needs nothing from anyone, and
 * every *other* command an operator might reach for here is actively harmful
 * — which is why the detail names the re-init hazard explicitly instead of
 * leaving it implied.
 */
function closeInFlightVerdict({ storyId, artifacts, evidence }) {
  const seconds = Math.round((artifacts.gateLogAgeMs ?? 0) / 1000);
  return {
    shape: 'close-in-flight',
    nextCommand: NEXT_COMMANDS.recover(storyId),
    detail:
      `A close is RUNNING for this Story right now: \`${artifacts.gateLogPath}\` was appended ` +
      `${seconds}s ago. \`agent::executing\` with no PR does NOT mean the work stalled here — ` +
      `the implementation is done and the close is mid-gate-chain, before its push. ` +
      `**Do not run \`single-story-init.js\`**: re-initializing the worktree ` +
      `underneath a live close risks a second close racing the first on one PR (double label ` +
      `flip, double post-land tail). Let it finish — it emits its own terminal envelope and ` +
      `persists a copy — then re-run the command below for a settled verdict.`,
    evidence,
  };
}

/**
 * The `agent::executing` rows of the table (Story #4543; split on push state
 * by Story #5267).
 *
 * Lifted out of {@link decideRecovery} because this label alone fans out into
 * five distinct strands, and because the push-state split below only reads
 * correctly next to the artifact probes it is ordered after.
 *
 * @param {{ storyId: number, branch: object, pr: object|null, closeArtifacts?: object, evidence: string[] }} args
 * @returns {{ shape: string, nextCommand: string|null, detail: string, evidence: string[] }}
 */
function decideExecuting({ storyId, branch, pr, closeArtifacts, evidence }) {
  if (pr?.number) {
    return {
      shape: 'executing-with-pr',
      nextCommand: NEXT_COMMANDS.close(storyId),
      detail:
        `PR #${pr.number} exists but the Story is still \`agent::executing\` — the close ` +
        `opened the PR and then died before the label flip. Re-run close; it reuses the ` +
        `open PR rather than opening a duplicate.`,
      evidence,
    };
  }
  // Story #4816 — the close artifacts get the first word here, and ONLY
  // here. Every other row of this table describes a state whose evidence is
  // already unambiguous; `executing` + no PR is the one row that reads
  // identically for a dead implementation and for a close that is halfway
  // through its gate chain, and answering it from labels alone is what sent
  // operators to re-init on top of a live close.
  if (closeLooksLive(closeArtifacts)) {
    return closeInFlightVerdict({
      storyId,
      artifacts: closeArtifacts,
      evidence,
    });
  }
  if (closeArtifacts?.envelope) {
    return envelopeOnDiskVerdict({
      storyId,
      artifacts: closeArtifacts,
      evidence,
    });
  }
  // Story #5267 — push state is what separates the two remaining strands, and
  // it separates them cleanly now that the worker pushes BEFORE its creditable
  // capture. Before that ordering, a worker whose turn ended on the
  // backgrounded capture left an unpushed branch that was indistinguishable
  // from work that never got started; now an unpushed branch means exactly one
  // thing, and a pushed one means the hand-off happened and only close is
  // owed.
  if (branch?.remote) {
    return {
      shape: 'executing-pushed-no-pr',
      nextCommand: NEXT_COMMANDS.close(storyId),
      detail:
        `\`story-${storyId}\` is PUSHED to origin but no PR exists and no close left an ` +
        `artifact behind — the worker finished and handed off, and the close never ran (or ` +
        `died before its first gate). Nothing needs re-implementing: run close, which is ` +
        `idempotent. Do NOT re-init — the branch already carries the finished work.`,
      evidence,
    };
  }
  return {
    shape: 'executing-no-pr',
    nextCommand: NEXT_COMMANDS.implement(storyId),
    detail:
      `Story is \`agent::executing\`, \`story-${storyId}\` is UNPUSHED, there is no PR, and ` +
      `no close left an artifact behind (no persisted terminal envelope, no recent gate ` +
      `log) — implementation never finished. Re-init (idempotent — it reuses the existing ` +
      `branch and worktree) and resume in the worktree it prints.`,
    evidence,
  };
}

/**
 * The decision table. Pure: every input is an already-observed probe, so the
 * mapping is testable without git, GitHub, or a clock.
 *
 * Returns exactly one `{ shape, nextCommand, evidence[], detail }` — never a
 * list of candidates.
 *
 * @param {{
 *   storyId: number,
 *   ticket: object,
 *   branch: object,
 *   pr: object|null,
 *   closeArtifacts?: object,
 * }} probes
 * @returns {{ shape: string, nextCommand: string|null, detail: string, evidence: string[] }}
 */
export function decideRecovery({
  storyId,
  ticket,
  branch,
  pr,
  closeArtifacts,
}) {
  const evidence = [
    `label=${ticket?.stateLabel ?? 'none'}`,
    `issue=${ticket?.issueState ?? 'unknown'}`,
    `pr=${pr?.number ? `#${pr.number} ${pr.state ?? '?'}` : 'none'}`,
    `checks=${pr?.checksStatus ?? 'n/a'}`,
    `branch.local=${branch?.local ?? false}`,
    `branch.remote=${branch?.remote ?? false}`,
    `worktree=${branch?.worktreePath ?? 'none'}`,
    `lease=${ticket?.lease ?? 'unclaimed'}`,
    `closeEnvelope=${closeArtifacts?.envelope ? closeArtifacts.envelope.status : 'none'}`,
    `gateLogAge=${
      closeArtifacts?.gateLogAgeMs === null ||
      closeArtifacts?.gateLogAgeMs === undefined
        ? 'none'
        : `${Math.round(closeArtifacts.gateLogAgeMs / 1000)}s`
    }`,
  ];

  const label = ticket?.stateLabel;
  const merged = pr?.state === 'MERGED' || Boolean(pr?.mergedAt);

  // A merged PR outranks every label reading. The code is on the base
  // branch; whatever the label says, the only thing left is the flip + tail.
  if (merged && label !== STATE_LABELS.DONE) {
    return {
      shape: 'merged-label-stale',
      nextCommand: NEXT_COMMANDS.confirmMerge(storyId),
      detail:
        `PR #${pr.number} is MERGED but the Story is at \`${label ?? 'no state label'}\`. ` +
        `A /mandrel-deliver re-run cannot fix this — single-story-init.js hard-errors on an ` +
        `already-closed Story. The confirm CLI is idempotent and flips the label from ` +
        `the already-merged PR, then runs the land tail.`,
      evidence,
    };
  }

  if (label === STATE_LABELS.BLOCKED) {
    return {
      shape: 'blocked',
      nextCommand: NEXT_COMMANDS.recover(storyId),
      detail:
        `Story is at \`agent::blocked\`. The block was already classified when it was ` +
        `filed — read the \`friction\` comment on #${storyId} for the class-specific ` +
        `remediation, resolve it, then transition back to \`agent::executing\`. ` +
        `Re-run this probe afterwards to confirm the strand cleared.`,
      evidence,
    };
  }

  if (label === STATE_LABELS.DONE) {
    return {
      shape: 'done-board-drift',
      nextCommand: NEXT_COMMANDS.resync(storyId),
      detail:
        `Story is \`agent::done\`. Nothing to deliver. If the Projects board still shows ` +
        `it as In Progress, the GitHub built-in workflow won the post-merge race; the ` +
        `resync re-asserts the column and is a no-op otherwise.`,
      evidence,
    };
  }

  if (label === STATE_LABELS.CLOSING) {
    if (pr?.checksStatus === 'failure') {
      return {
        shape: 'closing-pr-red',
        nextCommand: NEXT_COMMANDS.watchCi(storyId, pr.number),
        detail:
          `PR #${pr.number} has a red required check. Waiting cannot help — fix the ` +
          `failure and push a new commit on \`story-${storyId}\`; the red disarmed ` +
          `auto-merge, and only a green on a new head SHA re-arms it.`,
        evidence,
      };
    }
    if (pr?.number) {
      return {
        shape: 'closing-pr-pending',
        nextCommand: NEXT_COMMANDS.resumeLand(storyId),
        detail:
          `PR #${pr.number} is open and healthy. This is the normal resumable shape after ` +
          `a bounded merge wait returned \`pending\`. The confirm CLI polls it to a ` +
          `confirmed merge and runs the land tail.`,
        evidence,
      };
    }
    return {
      shape: 'closing-no-pr',
      nextCommand: NEXT_COMMANDS.close(storyId),
      detail:
        `Story is at \`agent::closing\` but no PR exists for \`story-${storyId}\`. The ` +
        `close did not reach the pull-request phase; re-run it (close is idempotent and ` +
        `reuses an existing PR when one is found).`,
      evidence,
    };
  }

  if (label === STATE_LABELS.EXECUTING) {
    return decideExecuting({ storyId, branch, pr, closeArtifacts, evidence });
  }

  return {
    shape: 'ready',
    nextCommand: NEXT_COMMANDS.close(storyId),
    detail:
      `Story is at \`${label ?? 'no agent:: state label'}\` — not mid-delivery, so there ` +
      `is no strand to recover. Deliver it normally via /mandrel-deliver ${storyId}.`,
    evidence,
  };
}

/**
 * The shapes a LIVE delivery process actively mutates while it runs. A probe
 * that lands mid-close can read `executing` + `pr=none` seconds before the
 * push and PR-open land, and confidently misdirect the operator to re-init a
 * Story whose close is about to open a PR (observed live on Story #4712: two
 * probes seconds apart flipped `executing-no-pr` → `executing-with-pr`).
 * These shapes therefore earn a stability re-probe before the verdict is
 * trusted; the remaining shapes (`merged-label-stale`, `blocked`,
 * `done-board-drift`, `ready`) describe settled states no live process is
 * racing to change.
 */
const TRANSIENT_SHAPES = new Set([
  'executing-no-pr',
  'executing-pushed-no-pr',
  'executing-with-pr',
  'closing-no-pr',
  'closing-pr-pending',
  'closing-pr-red',
  // Story #4816 — the definition of this shape is "a process is mutating this
  // Story right now", so it is the most transient row in the table: the second
  // probe often catches the push and PR landing and returns a settled verdict
  // instead.
  'close-in-flight',
]);

/**
 * Default settle window between the two probes of the stability pass. Long
 * enough for an in-flight push / `gh pr create` / label flip to land (each is
 * a single network call), short enough that the read-only CLI stays
 * interactive.
 */
const STABILITY_DELAY_MS = 5000;

/**
 * Build the verdict for a state observed mid-mutation: the two probe rounds
 * derived DIFFERENT shapes, so neither is safe to act on — acting on the
 * first misdirects (the #4712 shape), acting on the second may race the same
 * live process again. The one next command is the probe itself, re-run once
 * the live process settles.
 *
 * @param {{ storyId: number, first: object, second: object, delayMs: number }} args
 * @returns {{ shape: string, nextCommand: string, detail: string, evidence: string[] }}
 */
function buildInTransitionVerdict({ storyId, first, second, delayMs }) {
  return {
    shape: 'in-transition',
    nextCommand: NEXT_COMMANDS.recover(storyId),
    detail:
      `Two probes ${Math.round(delayMs / 1000)}s apart derived different shapes ` +
      `(\`${first.shape}\` → \`${second.shape}\`): a delivery process is actively ` +
      `mutating this Story's state right now (a push, PR open, or label flip landed ` +
      `between the probes). Acting on either verdict risks duplicating or misdirecting ` +
      `the live run. Wait for it to finish, then re-run this probe for a settled verdict.`,
    evidence: [
      `probe1.shape=${first.shape}`,
      `probe2.shape=${second.shape}`,
      ...second.evidence,
    ],
  };
}

/**
 * One full probe round: ticket + branch + PR → decision. Throws only when
 * the ticket itself is unreadable (the probe cannot run without it).
 */
async function probeAndDecide({
  storyId,
  storyBranch,
  cwd,
  provider,
  config,
  gh,
  gitSpawnFn,
  fsImpl,
}) {
  const ticket = await probeTicket({ provider, storyId });
  if (!ticket.ok) {
    throw new Error(
      `deliver-recover: could not read Story #${storyId}: ${ticket.error}`,
    );
  }
  const branch = probeBranch({ cwd, storyBranch, config, gitSpawnFn });
  const pr = await probePr({ storyBranch, gh });
  // Re-read on every round: the whole point of the stability pass is that a
  // second look can catch a close that has since flushed a gate line or
  // written its envelope.
  const closeArtifacts = probeCloseArtifacts({
    storyId,
    config,
    ...(fsImpl ? { fsImpl } : {}),
  });
  const decision = decideRecovery({
    storyId,
    ticket,
    branch,
    pr,
    closeArtifacts,
  });
  return { probes: { ticket, branch, pr, closeArtifacts }, decision };
}

/**
 * Probe live state and resolve the single next command. Read-only.
 *
 * Transient shapes (`executing-*` / `closing-*`) get a **stability re-probe**
 * (same consecutive-evidence pattern the merge wait's fail-fast uses, Story
 * #4695): a second probe after a short settle window. Matching shapes return
 * the fresher verdict; diverging shapes return `in-transition` instead of a
 * confidently wrong command. Settled shapes skip the second round — their
 * state has no live process racing to change it.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.cwd
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {object} [args.gh]
 * @param {Function} [args.gitSpawnFn]
 * @param {boolean} [args.reprobe=true] Disable to skip the stability pass
 *   (single-probe legacy behavior — for scripted callers that own their own
 *   settling).
 * @param {number} [args.stabilityDelayMs] Settle window between the probes.
 * @param {Function} [args.sleepFn] Test seam for the settle wait.
 * @param {typeof nodeFs} [args.fsImpl] Test seam for the close-artifact reads.
 * @returns {Promise<object>}
 */
export async function recoverStory({
  storyId,
  cwd,
  provider,
  config,
  gh = defaultGh,
  gitSpawnFn,
  fsImpl,
  reprobe = true,
  stabilityDelayMs = STABILITY_DELAY_MS,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const storyBranch = getStoryBranch(storyId);
  const probeArgs = {
    storyId,
    storyBranch,
    cwd,
    provider,
    config,
    gh,
    gitSpawnFn,
    fsImpl,
  };

  const first = await probeAndDecide(probeArgs);
  if (!reprobe || !TRANSIENT_SHAPES.has(first.decision.shape)) {
    return {
      storyId,
      storyBranch,
      probes: first.probes,
      stability: { reprobed: false },
      ...first.decision,
    };
  }

  await sleepFn(stabilityDelayMs);
  const second = await probeAndDecide(probeArgs);

  if (second.decision.shape === first.decision.shape) {
    // Stable across the settle window — trust the fresher evidence.
    return {
      storyId,
      storyBranch,
      probes: second.probes,
      stability: { reprobed: true, stable: true, delayMs: stabilityDelayMs },
      ...second.decision,
    };
  }

  return {
    storyId,
    storyBranch,
    probes: second.probes,
    stability: { reprobed: true, stable: false, delayMs: stabilityDelayMs },
    ...buildInTransitionVerdict({
      storyId,
      first: first.decision,
      second: second.decision,
      delayMs: stabilityDelayMs,
    }),
  };
}

/**
 * Render the operator-facing report: the shape, the one command, and the
 * evidence it was derived from — so the operator can check the reasoning
 * rather than trust it.
 *
 * @param {object} recovery
 * @returns {string}
 */
export function renderRecovery(recovery) {
  const lines = [
    `Story #${recovery.storyId} — ${recovery.shape}`,
    '',
    recovery.detail,
    '',
    'Evidence:',
    ...recovery.evidence.map((e) => `  - ${e}`),
    '',
  ];
  if (recovery.nextCommand) {
    lines.push('Next command:', `  ${recovery.nextCommand}`, '');
  } else {
    lines.push('Next command: none — nothing to do.', '');
  }
  return lines.join('\n');
}
