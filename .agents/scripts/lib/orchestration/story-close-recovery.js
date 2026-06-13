/* node:coverage ignore file -- prior-state detection over live git + filesystem signals; testing requires mocking the entire merge/worktree state machine, asserts only mock structure */

/**
 * story-close-recovery.js — prior-state detection for story-close.
 *
 * Reconstructs close-recovery state from git + filesystem signals at invocation
 * time. No on-disk schema — every signal is observable in the checkout.
 *
 * States (priority order, first match wins):
 *   - `partial-merge`        — a merge is in progress in the main checkout.
 *   - `uncommitted-worktree` — the story worktree exists with uncommitted work.
 *   - `already-merged`       — the story tip is reachable from `origin/epic/<id>`
 *                              already (typical Windows partial-reap recovery
 *                              path: merge + push succeeded but worktree reap
 *                              or ticket transitions stalled), OR the story
 *                              diff is fully present on `origin/epic/<id>` as
 *                              rebased commits with different SHAs (manual
 *                              recovery path, detected via `git cherry`
 *                              patch-id comparison; Story #3161), OR — when
 *                              both Story refs have already been reaped — the
 *                              Epic history carries an integration commit
 *                              referencing the Story (`(resolves #<id>)` /
 *                              `(refs #<id>)`), found via `git log --grep`
 *                              (ref-independent path; Story #3327 / Epic #3316).
 *   - `pushed-unmerged`      — the story branch is on origin and not yet merged.
 *   - `fresh`                — no prior close activity detected.
 */

import fs from 'node:fs';
import { resolveWorkingPath } from '../config-resolver.js';
import { gitSpawn } from '../git-utils.js';
import { Logger } from '../Logger.js';
import { resolvesOrRefsGrepArgs } from './resolves-token.js';

export const RECOVERY_STATES = Object.freeze({
  FRESH: 'fresh',
  PARTIAL_MERGE: 'partial-merge',
  UNCOMMITTED_WORKTREE: 'uncommitted-worktree',
  ALREADY_MERGED: 'already-merged',
  PUSHED_UNMERGED: 'pushed-unmerged',
});

const DEFAULT_GIT_ADAPTER = {
  status(cwd) {
    return gitSpawn(cwd, 'status', '--porcelain=v1');
  },
  lsRemote(cwd, ref) {
    return gitSpawn(cwd, 'ls-remote', '--heads', 'origin', ref);
  },
  isAncestor(cwd, ancestor, descendant) {
    return gitSpawn(cwd, 'merge-base', '--is-ancestor', ancestor, descendant);
  },
  showRef(cwd, ref) {
    return gitSpawn(cwd, 'show-ref', '--verify', '--quiet', ref);
  },
  fetchOrigin(cwd, ref) {
    return gitSpawn(cwd, 'fetch', '--quiet', 'origin', ref);
  },
  cherry(cwd, upstream, head) {
    return gitSpawn(cwd, 'cherry', upstream, head);
  },
  logGrep(cwd, ref, grepArgs) {
    return gitSpawn(cwd, 'log', ...grepArgs, '--format=%H', ref);
  },
};

const DEFAULT_FS_ADAPTER = {
  existsSync: fs.existsSync,
};

/**
 * Scan the Epic branch history for an integration/merge commit whose subject
 * references this Story via `(resolves #<id>)` or `(refs #<id>)`.
 *
 * This is the **ref-independent** already-merged signal: it survives the case
 * where BOTH the local `story-<id>` branch and the remote `origin/story-<id>`
 * ref have already been deleted by a prior partial close run, leaving no Story
 * ref to anchor the ancestor / cherry probes (branches a–c). Because the search
 * is scoped to the Epic ref's reachable history (`git log <epicRef> --grep`),
 * any match is by definition already an ancestor of the Epic tip — no separate
 * ancestor check is required.
 *
 * The closing paren in the pattern disambiguates `#<id>` from a longer id that
 * shares the same prefix (e.g. `#3327` must not match `(resolves #33270)`).
 *
 * **origin-only scope (Story #3907).** The probe is restricted to the
 * **remote** `origin/epic/<id>` ref. The earlier implementation also searched
 * the **local** `epic/<id>` ref, which mis-classifies the
 * "merged locally, push failed" recovery state: when a prior close created the
 * integration merge commit on the local Epic branch but the `git push` failed,
 * the local-ref scan finds that commit and reports ALREADY_MERGED. The resumed
 * close then skips the push, flips the ticket done, and reaps the branch — so
 * the merge survives in one clone only, and a sibling's `pull --rebase` can
 * linearize away the `(resolves #<id>)` commit that four subsystems depend on.
 * "Already merged" means "merged on the remote integration branch"; a
 * local-only merge is unpushed work, which the `pushed-unmerged` /
 * resume-from-post-merge paths re-push instead.
 *
 * @returns {{ sha: string, epicRef: string } | null}
 */
function findMergeCommitForStory({ cwd, storyId, epicId, git }) {
  if (!git.logGrep) return null;
  const grepArgs = resolvesOrRefsGrepArgs(storyId);
  const epicRef = `origin/epic/${epicId}`;
  const res = git.logGrep(cwd, epicRef, grepArgs);
  if (!res || res.status !== 0) return null;
  const sha = (res.stdout ?? '').toString().trim().split('\n')[0]?.trim();
  if (sha) return { sha, epicRef };
  return null;
}

function storyWorktreePath(cwd, storyId, worktreeRoot) {
  return resolveWorkingPath({
    worktreeEnabled: true,
    repoRoot: cwd,
    storyId,
    worktreeRoot,
  });
}

/**
 * Return true if `git status --porcelain=v1` output contains an unmerged
 * marker (`UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`). These are the entries
 * git emits while a merge is in progress with unresolved content.
 */
function hasUnmergedMarkers(porcelainOutput) {
  if (!porcelainOutput) return false;
  return porcelainOutput
    .split('\n')
    .some((line) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line));
}

/**
 * Return true if the porcelain output has any non-empty entries (i.e. the
 * working tree is not clean).
 */
function hasAnyUncommittedChanges(porcelainOutput) {
  if (!porcelainOutput) return false;
  return porcelainOutput.split('\n').some((line) => line.trim().length > 0);
}

/**
 * Probe: partial-merge — UU markers in the main checkout.
 *
 * @returns {{ phase: string, detail: object } | null}
 */
function detectPartialMerge({ cwd, detail, git }) {
  const mainStatus = git.status(cwd);
  const mainStatusOut = (mainStatus?.stdout ?? '').toString();
  if (!hasUnmergedMarkers(mainStatusOut)) return null;
  return {
    phase: RECOVERY_STATES.PARTIAL_MERGE,
    detail: { ...detail, checkout: cwd },
  };
}

/**
 * Probe: uncommitted-worktree — worktree present + dirty.
 *
 * @returns {{ phase: string, detail: object } | null}
 */
function detectUncommittedWorktree({
  cwd,
  storyId,
  worktreeRoot,
  detail,
  git,
  fs: fsAdapter,
}) {
  const wtPath = storyWorktreePath(cwd, storyId, worktreeRoot);
  if (!fsAdapter.existsSync(wtPath)) return null;
  const wtStatus = git.status(wtPath);
  const wtStatusOut = (wtStatus?.stdout ?? '').toString();
  if (!hasAnyUncommittedChanges(wtStatusOut)) return null;
  return {
    phase: RECOVERY_STATES.UNCOMMITTED_WORKTREE,
    detail: { ...detail, worktreePath: wtPath },
  };
}

/**
 * Probe: already-merged — story tip is reachable from `origin/epic/<id>`.
 *
 * Triggered when a prior close pushed the merge but stalled before the
 * ticket transitions / cascade / dashboard regen finished — typical
 * Windows partial-reap recovery
 * "merge/close succeed but branchDeleted: false"). Detected from either:
 *   a) the local `story-<id>` branch still exists and is an ancestor of
 *      `origin/epic/<id>`; or
 *   b) the remote `origin/story-<id>` ref is present and merged; or
 *   c) every commit on the Story branch is patch-equivalent (`git cherry`)
 *      to a commit already on the Epic (rebased-equivalents, Story #3161).
 * Any one signal is enough — the local branch may have been reaped while
 * the remote one survived, or vice versa.
 *
 * Returns `null` when `epicId` is absent or no merge signal matches.
 *
 * @returns {{ phase: string, detail: object } | null}
 */
/**
 * Probe (a): the local `story-<id>` branch still exists and is an ancestor
 * of `origin/epic/<id>`. Returns the resolved-detail fragment or `null`.
 * Story #4075 — extracted from `detectAlreadyMerged`.
 */
function probeLocalStoryMerged({
  cwd,
  storyBranch,
  epicId,
  git,
  probeAncestor,
}) {
  const localStoryRef = `refs/heads/${storyBranch}`;
  if (!(git.showRef && git.showRef(cwd, localStoryRef)?.status === 0)) {
    return null;
  }
  const remoteEpicRef = `origin/epic/${epicId}`;
  return probeAncestor(storyBranch, remoteEpicRef)
    ? { localStoryRef: storyBranch, remoteEpicRef }
    : null;
}

/**
 * Probe (b): the remote `origin/story-<id>` ref is present and is an
 * ancestor of an `origin/epic` ref. Story #4075 — extracted.
 */
function probeRemoteStoryMerged({
  storyBranch,
  epicRefs,
  lsrOut,
  probeAncestor,
}) {
  if (lsrOut.length === 0) return null;
  for (const epicRef of epicRefs) {
    if (probeAncestor(`origin/${storyBranch}`, epicRef)) {
      return {
        remoteStoryRef: `origin/${storyBranch}`,
        remoteEpicRef: epicRef,
      };
    }
  }
  return null;
}

/**
 * Probe (c): rebased equivalents (Story #3161). The Story tip is not an
 * ancestor of `origin/epic/<id>`, but every commit on the Story branch is
 * patch-equivalent (`git cherry`) to a commit already on the Epic — the
 * manual-recovery case where the operator rebased Story content directly
 * onto `epic/<id>`. Without this branch, `assertMergeReachable` throws at
 * resume time and strands close at `agent::closing`. Story #4075 —
 * extracted from `detectAlreadyMerged`.
 */
function probeRebasedEquivalents({ cwd, storyBranch, epicId, lsrOut, git }) {
  if (!git.cherry) return null;
  const candidates = [];
  const localStoryRefName = `refs/heads/${storyBranch}`;
  if (git.showRef && git.showRef(cwd, localStoryRefName)?.status === 0) {
    candidates.push({ ref: storyBranch, kind: 'local' });
  }
  if (lsrOut.length > 0) {
    candidates.push({ ref: `origin/${storyBranch}`, kind: 'remote' });
  }
  const remoteEpicRef = `origin/epic/${epicId}`;
  for (const cand of candidates) {
    const cherry = git.cherry(cwd, remoteEpicRef, cand.ref);
    if (!cherry || cherry.status !== 0) continue;
    const lines = (cherry.stdout ?? '')
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.every((l) => l.startsWith('- '))) {
      return {
        [cand.kind === 'local' ? 'localStoryRef' : 'remoteStoryRef']: cand.ref,
        remoteEpicRef,
        via: 'rebased-equivalents',
        equivalents: lines.length,
      };
    }
  }
  return null;
}

/**
 * Probe (d): ref-independent merge-commit-message scan (Story #3327 /
 * Epic #3316). Both the local and remote Story refs were deleted by a prior
 * partial close, so probes a–c have no ref to anchor on. Recover the
 * already-merged signal from the Epic history itself by locating the
 * integration commit whose subject carries `(resolves #<id>)` / `(refs
 * #<id>)`. Story #4075 — extracted from `detectAlreadyMerged`.
 */
function probeMergeCommitMessage({ cwd, storyId, epicId, git }) {
  const mc = findMergeCommitForStory({ cwd, storyId, epicId, git });
  return mc
    ? {
        via: 'merge-commit-message',
        mergeCommit: mc.sha,
        remoteEpicRef: mc.epicRef,
      }
    : null;
}

function detectAlreadyMerged({ cwd, storyId, epicId, lsrOut, detail, git }) {
  if (!epicId) return null;

  const storyBranch = `story-${storyId}`;
  const epicRefs = ['origin/epic', `origin/epic/${epicId}`];
  const probeAncestor = (storyRef, epicRef) =>
    git.isAncestor(cwd, storyRef, epicRef)?.status === 0;

  // Any one signal is enough — the local branch may have been reaped while
  // the remote survived (or vice versa), or both refs may be gone and only
  // the Epic merge-commit message remains. Probes run in cheapest-first
  // order; the first to resolve wins.
  const resolvedDetail =
    probeLocalStoryMerged({ cwd, storyBranch, epicId, git, probeAncestor }) ??
    probeRemoteStoryMerged({ storyBranch, epicRefs, lsrOut, probeAncestor }) ??
    probeRebasedEquivalents({ cwd, storyBranch, epicId, lsrOut, git }) ??
    probeMergeCommitMessage({ cwd, storyId, epicId, git });

  if (!resolvedDetail) return null;
  return {
    phase: RECOVERY_STATES.ALREADY_MERGED,
    detail: { ...detail, ...resolvedDetail },
  };
}

/**
 * Probe: pushed-unmerged — remote story branch exists and not yet merged.
 *
 * @returns {{ phase: string, detail: object } | null}
 */
function detectPushedUnmerged({ lsrOut, detail }) {
  if (lsrOut.length === 0) return null;
  return {
    phase: RECOVERY_STATES.PUSHED_UNMERGED,
    detail: { ...detail, remoteRef: lsrOut.split('\n')[0] },
  };
}

/**
 * Detect the prior-close state for a Story.
 *
 * Runs the single-purpose probes in priority order and returns the first
 * match, falling back to FRESH when none fire. Probe order is load-bearing:
 * partial-merge > uncommitted-worktree > already-merged > pushed-unmerged.
 *
 * @param {object} opts
 * @param {string} opts.cwd             Main checkout root.
 * @param {number|string} opts.storyId
 * @param {number|string} [opts.epicId] Epic id, used to form `origin/epic/<id>`.
 * @param {string} [opts.worktreeRoot]  Worktree root relative to cwd. Default `.worktrees`.
 * @param {object} [opts.git]           Git adapter. Defaults to real git via gitSpawn.
 * @param {object} [opts.fs]            FS adapter with `existsSync`. Defaults to node:fs.
 * @returns {{ phase: string, detail: object }}
 */
export function detectPriorPhase({
  cwd,
  storyId,
  epicId,
  worktreeRoot,
  git = DEFAULT_GIT_ADAPTER,
  fs: fsAdapter = DEFAULT_FS_ADAPTER,
} = {}) {
  if (!cwd) throw new Error('detectPriorPhase: cwd is required');
  if (!storyId) throw new Error('detectPriorPhase: storyId is required');

  const storyBranch = `story-${storyId}`;
  const detail = { storyId, storyBranch };

  // `lsRemote` is probed once and shared by the already-merged and
  // pushed-unmerged probes (both key off the remote story ref).
  const lsr = git.lsRemote(cwd, storyBranch);
  const lsrOut = (lsr?.stdout ?? '').toString().trim();

  return (
    detectPartialMerge({ cwd, detail, git }) ??
    detectUncommittedWorktree({
      cwd,
      storyId,
      worktreeRoot,
      detail,
      git,
      fs: fsAdapter,
    }) ??
    detectAlreadyMerged({ cwd, storyId, epicId, lsrOut, detail, git }) ??
    detectPushedUnmerged({ lsrOut, detail }) ?? {
      phase: RECOVERY_STATES.FRESH,
      detail,
    }
  );
}

export const RECOVERY_ACTIONS = Object.freeze({
  PROCEED: 'proceed',
  EXIT_PRIOR_STATE: 'exit-prior-state',
  RESUME_FROM_VALIDATE: 'resume-from-validate',
  RESUME_FROM_MERGE: 'resume-from-merge',
  RESUME_FROM_CONFLICT: 'resume-from-conflict',
  RESUME_FROM_POST_MERGE: 'resume-from-post-merge',
  RESTART: 'restart',
});

/**
 * Decide how to dispatch given a detected prior state and CLI flags.
 *
 * Exactly one of `resume` / `restart` may be truthy. Passing both throws.
 *
 * @param {object} opts
 * @param {string} opts.state     One of RECOVERY_STATES.
 * @param {boolean} [opts.resume]
 * @param {boolean} [opts.restart]
 * @returns {{ action: string, exitCode?: number, reason?: string }}
 */
export function computeRecoveryMode({ state, resume, restart } = {}) {
  if (resume && restart) {
    throw new Error(
      'computeRecoveryMode: --resume and --restart are mutually exclusive',
    );
  }

  if (state === RECOVERY_STATES.FRESH) {
    // Flags are no-ops on fresh state — proceed normally.
    return { action: RECOVERY_ACTIONS.PROCEED };
  }

  // ALREADY_MERGED short-circuits the prior-state gate: the merge has already
  // landed on `origin/epic/<id>`, so re-running close should pick up exactly
  // the post-merge work (ticket transitions, cascade, health, dashboard) that
  // stalled the first time. No `--resume` flag required — re-running close on
  // a successfully merged Story is the canonical recovery path for partial
  // reaps and is safe to perform automatically.
  if (state === RECOVERY_STATES.ALREADY_MERGED) {
    if (restart) return { action: RECOVERY_ACTIONS.RESTART };
    return { action: RECOVERY_ACTIONS.RESUME_FROM_POST_MERGE };
  }

  if (restart) {
    return { action: RECOVERY_ACTIONS.RESTART };
  }

  if (resume) {
    switch (state) {
      case RECOVERY_STATES.PARTIAL_MERGE:
        return { action: RECOVERY_ACTIONS.RESUME_FROM_CONFLICT };
      case RECOVERY_STATES.UNCOMMITTED_WORKTREE:
        return { action: RECOVERY_ACTIONS.RESUME_FROM_VALIDATE };
      case RECOVERY_STATES.PUSHED_UNMERGED:
        return { action: RECOVERY_ACTIONS.RESUME_FROM_MERGE };
      default:
        throw new Error(`computeRecoveryMode: unknown state "${state}"`);
    }
  }

  // Prior state detected + no flag → refuse to silently proceed.
  return {
    action: RECOVERY_ACTIONS.EXIT_PRIOR_STATE,
    exitCode: 2,
    reason: state,
  };
}

function dropWorktreeIfPresent({
  cwd,
  wtPath,
  progress,
  logger,
  gitSpawnFn = gitSpawn,
}) {
  if (!fs.existsSync(wtPath)) return;
  progress('RESTART', `Removing worktree ${wtPath}`);
  const remove = gitSpawnFn(cwd, 'worktree', 'remove', '--force', wtPath);
  if (remove.status !== 0) {
    logger.error(
      `[story-close] Worktree remove failed: ${remove.stderr || 'unknown'}. ` +
        'Attempting prune to clean stale registration.',
    );
  }
  gitSpawnFn(cwd, 'worktree', 'prune');
}

function recreateStoryBranchRef({
  cwd,
  storyBranch,
  epicBranch,
  gitSpawnFn = gitSpawn,
}) {
  gitSpawnFn(cwd, 'branch', '-D', storyBranch);
  const create = gitSpawnFn(cwd, 'branch', storyBranch, epicBranch);
  if (create.status !== 0) {
    throw new Error(
      `Failed to recreate ${storyBranch} from ${epicBranch}: ${create.stderr || 'unknown'}`,
    );
  }
}

function reseedWorktreeIfNeeded({
  cwd,
  wtConfig,
  storyId,
  storyBranch,
  progress,
  gitSpawnFn = gitSpawn,
}) {
  if (!wtConfig?.enabled) return;
  const wtPath = storyWorktreePath(cwd, storyId, wtConfig.root);
  const add = gitSpawnFn(cwd, 'worktree', 'add', wtPath, storyBranch);
  if (add.status !== 0) {
    throw new Error(
      `Failed to re-seed worktree at ${wtPath}: ${add.stderr || 'unknown'}`,
    );
  }
  progress('RESTART', `✅ Re-seeded worktree at ${wtPath}`);
}

/**
 * Restart path: abort any in-progress merge, drop the worktree, delete the
 * story branch ref, and re-seed branch + worktree from the Epic branch. The
 * caller then falls through to the normal fresh-close flow.
 *
 * Throws (never `logger.fatal`) on a failed branch recreate or worktree
 * re-seed, per `rules/orchestration-error-handling.md` — a failed recreate
 * MUST NOT fall through into the worktree re-seed.
 */
export function restartStoryState({
  cwd,
  orchestration,
  storyId,
  epicBranch,
  storyBranch,
  progress = () => {},
  logger = Logger,
  gitSpawnFn = gitSpawn,
} = {}) {
  progress('RESTART', `Resetting prior state for Story #${storyId}...`);
  gitSpawnFn(cwd, 'merge', '--abort');

  const wtConfig = orchestration?.worktreeIsolation;
  if (wtConfig?.enabled) {
    dropWorktreeIfPresent({
      cwd,
      wtPath: storyWorktreePath(cwd, storyId, wtConfig.root),
      progress,
      logger,
      gitSpawnFn,
    });
  }

  recreateStoryBranchRef({ cwd, storyBranch, epicBranch, gitSpawnFn });
  reseedWorktreeIfNeeded({
    cwd,
    wtConfig,
    storyId,
    storyBranch,
    progress,
    gitSpawnFn,
  });
}

/**
 * Single-call front door for the prior-state machine inside
 * `runStoryClose`. Detects the prior phase, computes the recovery mode for
 * the supplied flags, and:
 *
 *   - throws an `Error` with `exitCode: 2` (preserving the existing
 *     contract for the CLI wrapper) when no flag was supplied for a
 *     non-fresh state;
 *   - invokes `restartStoryState` (or the supplied `restartFn`) when
 *     `--restart` was passed;
 *   - emits the matching progress line for any `--resume` action.
 *
 * Returns a small dispatch summary the caller uses to branch into the
 * conflict-resume vs fresh-merge path and to decide whether to skip the
 * pre-merge validation gates.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {number|string} opts.storyId
 * @param {number|string} opts.epicId
 * @param {string} opts.epicBranch
 * @param {string} opts.storyBranch
 * @param {object} opts.orchestration
 * @param {boolean} [opts.resume]
 * @param {boolean} [opts.restart]
 * @param {Function} [opts.progress]
 * @param {object} [opts.logger]
 * @param {Function} [opts.detectFn]   Override for `detectPriorPhase` (tests).
 * @param {Function} [opts.restartFn]  Override for `restartStoryState` (tests).
 * @returns {{
 *   action: string,
 *   priorPhase: { phase: string, detail: object },
 *   resumeFromConflict: boolean,
 *   resumeFromMerge: boolean,
 *   resumeFromValidate: boolean,
 * }}
 */
export function dispatchRecovery({
  cwd,
  storyId,
  epicId,
  epicBranch,
  storyBranch,
  orchestration,
  resume = false,
  restart = false,
  progress = () => {},
  logger = Logger,
  detectFn = detectPriorPhase,
  restartFn = restartStoryState,
} = {}) {
  if (resume && restart) {
    throw new Error('--resume and --restart are mutually exclusive');
  }

  const priorPhase = detectFn({ cwd, storyId, epicId });
  const mode = computeRecoveryMode({
    state: priorPhase.phase,
    resume,
    restart,
  });

  if (mode.action === RECOVERY_ACTIONS.EXIT_PRIOR_STATE) {
    logger.error(
      `[phase=prior-state]\nPrior close state detected: ${priorPhase.phase}\n` +
        `${JSON.stringify(priorPhase.detail, null, 2)}\n\n` +
        'Re-run with --resume to continue from the detected state, or ' +
        '--restart to abort prior state and re-init.',
    );
    const err = new Error(`prior-state:${priorPhase.phase}`);
    err.exitCode = mode.exitCode ?? 2;
    throw err;
  }

  if (mode.action === RECOVERY_ACTIONS.RESTART) {
    progress(
      'RESTART',
      `--restart: aborting prior state (${priorPhase.phase}) and re-initializing`,
    );
    restartFn({
      cwd,
      orchestration,
      storyId,
      epicBranch,
      storyBranch,
      progress,
      logger,
    });
  }

  const resumeFromConflict =
    mode.action === RECOVERY_ACTIONS.RESUME_FROM_CONFLICT;
  const resumeFromMerge = mode.action === RECOVERY_ACTIONS.RESUME_FROM_MERGE;
  const resumeFromValidate =
    mode.action === RECOVERY_ACTIONS.RESUME_FROM_VALIDATE;
  const resumeFromPostMerge =
    mode.action === RECOVERY_ACTIONS.RESUME_FROM_POST_MERGE;

  if (resumeFromConflict) {
    progress(
      'RESUME',
      `--resume: resuming from conflict resolution (phase=${priorPhase.phase})`,
    );
  } else if (resumeFromMerge) {
    progress(
      'RESUME',
      `--resume: resuming from merge (phase=${priorPhase.phase})`,
    );
  } else if (resumeFromValidate) {
    progress(
      'RESUME',
      `--resume: resuming from validate (phase=${priorPhase.phase})`,
    );
  } else if (resumeFromPostMerge) {
    progress(
      'RESUME',
      `prior merge already landed on epic — skipping rebase + merge, ` +
        `running post-merge close work only (phase=${priorPhase.phase})`,
    );
  }

  return {
    action: mode.action,
    priorPhase,
    resumeFromConflict,
    resumeFromMerge,
    resumeFromValidate,
    resumeFromPostMerge,
  };
}
