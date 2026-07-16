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
 *   - `executing` with no PR → resume implementation. The work never reached
 *     close.
 *   - `closing` with a pending PR → resume the land. The overwhelmingly
 *     common shape now that the merge wait is bounded: the wait returned
 *     `pending` and something has to pick it back up.
 *   - `closing` with a red PR → enter the fix loop. Waiting is pointless; no
 *     budget turns a failed check green.
 *   - `closing` with a MERGED PR → run confirm. **This is the strand a
 *     `/deliver` re-run refuses outright**, because `single-story-init.js`
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

import { gh as defaultGh } from '../gh-exec.js';
import { gitSpawn as defaultGitSpawn, getStoryBranch } from '../git-utils.js';
import { deriveChecksStatus } from './merge-poll.js';
import { NEXT_COMMANDS } from './story-deliver-terminal.js';
import { STATE_LABELS } from './ticketing.js';

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
 * The decision table. Pure: every input is an already-observed probe, so the
 * mapping is testable without git, GitHub, or a clock.
 *
 * Returns exactly one `{ shape, nextCommand, evidence[], detail }` — never a
 * list of candidates.
 *
 * @param {{ storyId: number, ticket: object, branch: object, pr: object|null }} probes
 * @returns {{ shape: string, nextCommand: string|null, detail: string, evidence: string[] }}
 */
export function decideRecovery({ storyId, ticket, branch, pr }) {
  const evidence = [
    `label=${ticket?.stateLabel ?? 'none'}`,
    `issue=${ticket?.issueState ?? 'unknown'}`,
    `pr=${pr?.number ? `#${pr.number} ${pr.state ?? '?'}` : 'none'}`,
    `checks=${pr?.checksStatus ?? 'n/a'}`,
    `branch.local=${branch?.local ?? false}`,
    `branch.remote=${branch?.remote ?? false}`,
    `worktree=${branch?.worktreePath ?? 'none'}`,
    `lease=${ticket?.lease ?? 'unclaimed'}`,
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
        `A /deliver re-run cannot fix this — single-story-init.js hard-errors on an ` +
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
          `failure and push a new commit on \`story-${storyId}\`; auto-merge stays armed ` +
          `across retries.`,
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
    return {
      shape: 'executing-no-pr',
      nextCommand: NEXT_COMMANDS.implement(storyId),
      detail:
        `Story is \`agent::executing\` with no PR. Implementation never finished. Re-init ` +
        `(idempotent — it reuses the existing branch and worktree) and resume in the ` +
        `worktree it prints.`,
      evidence,
    };
  }

  return {
    shape: 'ready',
    nextCommand: NEXT_COMMANDS.close(storyId),
    detail:
      `Story is at \`${label ?? 'no agent:: state label'}\` — not mid-delivery, so there ` +
      `is no strand to recover. Deliver it normally via /deliver ${storyId}.`,
    evidence,
  };
}

/**
 * Probe live state and resolve the single next command. Read-only.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.cwd
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {object} [args.gh]
 * @param {Function} [args.gitSpawnFn]
 * @returns {Promise<object>}
 */
export async function recoverStory({
  storyId,
  cwd,
  provider,
  config,
  gh = defaultGh,
  gitSpawnFn,
}) {
  const storyBranch = getStoryBranch(storyId);
  const ticket = await probeTicket({ provider, storyId });
  if (!ticket.ok) {
    throw new Error(
      `deliver-recover: could not read Story #${storyId}: ${ticket.error}`,
    );
  }
  const branch = probeBranch({ cwd, storyBranch, config, gitSpawnFn });
  const pr = await probePr({ storyBranch, gh });
  const decision = decideRecovery({ storyId, ticket, branch, pr });
  return {
    storyId,
    storyBranch,
    probes: { ticket, branch, pr },
    ...decision,
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
