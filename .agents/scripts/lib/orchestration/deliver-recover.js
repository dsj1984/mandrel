/**
 * deliver-recover.js — probe a stranded Story and name its ONE next command.
 * Read-only: probes, a decision table over label × PR × branch × worktree ×
 * close artifacts, and one command plus its evidence — never a menu. The
 * command vocabulary is `story-deliver-terminal.js#NEXT_COMMANDS`.
 */

import nodeFs from 'node:fs';

import {
  closeGateLogPath,
  storyTerminalEnvelopePath,
} from '../config/temp-paths.js';
import { gh as defaultGh } from '../gh-exec.js';
import { gitSpawn as defaultGitSpawn, getStoryBranch } from '../git-utils.js';
import {
  CHECKS_FAILED_CLASS,
  deriveChecksStatus,
  isPrMerged,
} from './merge-poll.js';
import { NEXT_COMMANDS } from './story-deliver-terminal.js';
import { STATE_LABELS } from './ticketing.js';

/**
 * Gate-log freshness window for a close to count as live. Generous because
 * gate output is bursty; erring toward "live" only costs a re-probe.
 */
const CLOSE_IN_FLIGHT_WINDOW_MS = 120_000;

/**
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
 * Local branch, remote tracking ref and worktree path. No network.
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
 * `--state all`: the merged-but-label-stale strand needs the merged PR.
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
 * Probe the close's persisted terminal envelope and gate log — the only
 * evidence separating a dead implementation from a close mid-gate-chain
 * (both read `executing` with no PR). Never throws; absent reads are `null`.
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
 * A fresh gate log newer than the envelope wins: a Story can be closed more
 * than once, and a prior attempt's envelope must not mask a live one.
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
 * Close finished but its envelope never reached the caller. Relay the
 * envelope's own `nextCommand`; a landed one names none, so fall back to the
 * idempotent confirm.
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
 * A close is running: the only safe command is this probe again; every
 * other one (notably re-init) would race it.
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
 * The `agent::executing` rows; order matters (artifacts before push state).
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
  // `executing` + no PR is ambiguous from labels alone; artifacts decide.
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
  // The worker pushes before its creditable capture, so pushed means
  // handed off (close owed) and unpushed means implementation unfinished.
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
 * A close that blocked on a red required check disarmed auto-merge and wrote
 * the CI digest, so the next step is the ci-remediation loop — never this
 * probe again. `null` for every other blocked class (or with no PR to watch).
 *
 * @returns {{ shape: string, nextCommand: string, detail: string, evidence: string[] } | null}
 */
function decideBlockedChecksFailed({ storyId, pr, closeArtifacts, evidence }) {
  const envelope = closeArtifacts?.envelope;
  if (envelope?.blocked?.blockClass !== CHECKS_FAILED_CLASS) return null;
  const prNumber = pr?.number ?? envelope?.pr?.number ?? null;
  if (!prNumber) return null;
  return {
    shape: 'blocked-checks-failed',
    nextCommand: NEXT_COMMANDS.watchCi(storyId, prNumber),
    detail:
      `Story is \`agent::blocked\` because a required check on PR #${prNumber} went red. ` +
      `The close disarmed auto-merge and wrote the CI digest ` +
      `(\`story-${storyId}-ci-digest.json\` under the configured tempRoot). Per ` +
      `\`.agents/rules/ci-remediation.md\`, either fix the failure at source and push a new ` +
      `commit on \`story-${storyId}\`, or — when the root cause is outside this delivery — run ` +
      `\`node .agents/scripts/file-ci-gap.js --story ${storyId} --pr ${prNumber} --verdict <verdict> ` +
      `--owner <consumer|framework|platform> --evidence "<proof reading>"\`. Then run the watcher: ` +
      `a green on a new head SHA, or the one rerun a filed capacity / unreproducible-tier verdict ` +
      `admits, re-arms auto-merge.`,
    evidence,
  };
}

/**
 * The pure decision table: exactly one verdict, never a list.
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
  const merged = isPrMerged(pr);

  // A merged PR outranks every label: only the flip + tail remain.
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
    const checksFailed = decideBlockedChecksFailed({
      storyId,
      pr,
      closeArtifacts,
      evidence,
    });
    if (checksFailed) return checksFailed;
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
 * Shapes a live delivery may be mutating (e.g. a PR about to open), so they
 * earn a stability re-probe; the other shapes are settled.
 */
const TRANSIENT_SHAPES = new Set([
  'executing-no-pr',
  'executing-pushed-no-pr',
  'executing-with-pr',
  'closing-no-pr',
  'closing-pr-pending',
  'closing-pr-red',
  'close-in-flight',
]);

/** Settle window: enough for one push / PR open / label flip to land. */
const STABILITY_DELAY_MS = 5000;

/**
 * The two probes disagreed, so neither is safe to act on; re-probe later.
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

/** Throws only when the ticket is unreadable. */
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
 * Probe live state and resolve the single next command. Transient shapes
 * are re-probed after a settle window: a match returns the fresher verdict,
 * a divergence returns `in-transition`.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.cwd
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {object} [args.gh]
 * @param {Function} [args.gitSpawnFn]
 * @param {boolean} [args.reprobe=true] Skip the stability pass when false.
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
 * Render the report with its evidence so the reasoning can be checked.
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
