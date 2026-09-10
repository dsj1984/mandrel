/**
 * lib/audit-to-stories/ledger-pr.js — everything the ledger PR is made of.
 *
 * The mechanical half of `--ledger-commit`: how the branch is named, when the
 * checkout is refused, the commit sequence itself, the push, and the PR body.
 * `ledger-commit.js` next door keeps only the two entry points and the
 * persistence assessment they share, so the run sequence there reads as a
 * sequence rather than as a git driver.
 *
 * Every refusal in this module happens **before** its first write, so a refused
 * run cannot have left a branch or a commit behind. The git and `gh` seams are
 * injected (`.agents/rules/test-seams.md`), so the whole retry matrix is
 * assertable without a live remote.
 */

/**
 * Run a read-only git probe that must never throw: a checkout with no commits
 * (or no repository at all) is a legitimate answer of "nothing to report", not
 * a crash. The write path uses `runStep` instead, where a failure IS fatal.
 *
 * @param {(cwd: string, ...args: string[]) => string} git
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} trimmed stdout, or `''` when git failed.
 */
export function probeGit(git, cwd, args) {
  try {
    const out = git(cwd, ...args);
    return typeof out === 'string' ? out.trim() : '';
  } catch (_) {
    return '';
  }
}

/**
 * Does a ref resolve in this checkout? Read-only, and never fatal — an absent
 * ref is the answer, not an error.
 *
 * @param {(cwd: string, ...args: string[]) => string} git
 * @param {string} cwd
 * @param {string} ref
 * @returns {boolean}
 */
function refExists(git, cwd, ref) {
  return (
    probeGit(git, cwd, ['rev-parse', '--verify', '--quiet', ref]).length > 0
  );
}

/**
 * The short sha the branch name carries.
 *
 * Dating the branch alone was not enough to make a retry safe: a second run on
 * the same day found `chore/audit-ledger-<date>` already present and failed at
 * `create-branch`, so the *first* failure (usually a push) permanently poisoned
 * every retry that day. Qualifying the name with the base commit makes it
 * unique across bases while staying **deterministic** for the same base — which
 * is exactly what lets a retry recognise its own half-finished branch.
 *
 * @param {(cwd: string, ...args: string[]) => string} git
 * @param {string} cwd
 * @param {string} baseRef — `origin/<base>`.
 * @returns {string}
 */
function shortSha(git, cwd, baseRef) {
  for (const ref of [baseRef, 'HEAD']) {
    const sha = probeGit(git, cwd, ['rev-parse', '--short', ref]);
    if (sha) return sha;
  }
  return 'initial';
}

/**
 * Resolve the ledger branch for this run, and whether it is a **resume**.
 *
 * A ledger branch that exists locally and has never been pushed is the wreckage
 * of a failed run, not a landed one: its commit is already made, so the work
 * left is the push and the PR. Recognising it is what turns a failed push plus
 * its retry into exactly one PR instead of a stranded branch and a run
 * reporting `ledger-unchanged` — which is what the ledger file honestly is once
 * its change has been committed onto that branch.
 *
 * @param {{ git: Function, cwd: string, base: string, date: string }} params
 * @returns {{ branch: string, resuming: boolean }}
 */
function resolveLedgerBranch({ git, cwd, base, date }) {
  const branch = `chore/audit-ledger-${date}-${shortSha(git, cwd, `origin/${base}`)}`;
  return {
    branch,
    resuming:
      refExists(git, cwd, `refs/heads/${branch}`) &&
      !refExists(git, cwd, `refs/remotes/origin/${branch}`),
  };
}

/**
 * Refuse, naming the step, when the checkout cannot legitimately produce a
 * ledger PR. Both refusals happen **before** any write, so a refused run leaves
 * no branch and no commit behind.
 *
 * HEAD parked off the base branch is the one an unattended sweep actually
 * meets: a job that has already checked out a feature branch would otherwise
 * cut its ledger branch from that branch's tip and open a PR carrying every
 * unrelated commit on it.
 *
 * @param {{ hasOrigin: boolean, onBaseBranch: boolean, headBranch: string,
 *   baseBranch: string }} state
 * @param {string} branch — the ledger branch name, allowed as a resume HEAD.
 */
function assertCommittable(state, branch) {
  if (!state.hasOrigin) {
    throw new Error(
      '--ledger-commit failed at step "verify-origin": this checkout has no "origin" remote, ' +
        'so the ledger branch could never be pushed. Add the remote, or commit the ledger by hand.',
    );
  }
  if (!state.onBaseBranch && state.headBranch !== branch) {
    throw new Error(
      `--ledger-commit failed at step "verify-base-branch": HEAD is on "${state.headBranch || '(detached)'}", ` +
        `not the base branch "${state.baseBranch}". Nothing was committed — the ledger branch is cut from ` +
        `origin/${state.baseBranch}, and running from a feature branch would carry its commits into the ledger PR. ` +
        `Check out ${state.baseBranch} and re-run.`,
    );
  }
}

/**
 * Extract the PR URL `gh pr create` prints, so the caller can name it in the
 * run summary. A wrapper that returns something else yields `null` rather than
 * a fabricated link.
 *
 * @param {unknown} result
 * @returns {string|null}
 */
function pullRequestUrl(result) {
  const text = typeof result === 'string' ? result : (result?.stdout ?? '');
  const match = /https?:\/\/\S+/.exec(String(text ?? ''));
  return match ? match[0] : null;
}

/**
 * Wrap one write step so a git or `gh` failure surfaces as a fatal error that
 * names the step that broke. Accepts sync and async steps alike.
 * @param {string} name
 * @param {() => unknown} fn
 * @returns {Promise<unknown>}
 */
async function runStep(name, fn) {
  try {
    return await fn();
  } catch (error) {
    throw new Error(
      `--ledger-commit failed at step "${name}": ${error?.message ?? error}`,
      { cause: error },
    );
  }
}

/**
 * Compose the ledger PR body. Kept separate so the step sequence below reads
 * as a sequence and not as a string-building exercise.
 * @param {string} ledgerPath
 * @param {string} date
 * @returns {string}
 */
function pullRequestBody(ledgerPath, date) {
  return [
    `Reconciles the cross-run audit ledger (\`${ledgerPath}\`) written by the`,
    `unattended \`audit-to-stories --auto\` sweep on ${date}.`,
    '',
    'Ledger-only change — no source, workflow or documentation file is touched.',
    'Merging it is what gives the next sweep a memory: without it the ledger',
    'dies with the checkout and every later run re-proposes findings this one',
    'already filed, and re-surfaces findings a human already rejected.',
    '',
    'Auto-merge is deliberately not requested: the ledger records machine-derived',
    'lifecycle state, and a human glance before it lands is the point.',
  ].join('\n');
}

/**
 * Cut the ledger branch from `origin/<base>` and commit the ledger onto it —
 * or, when `resuming`, simply check out the branch a failed run already
 * committed onto, because those steps have already succeeded.
 *
 * @param {object} ctx
 * @returns {Promise<void>}
 */
async function commitLedgerOnto({
  git,
  cwd,
  branch,
  base,
  ledgerPath,
  subject,
  resuming = false,
}) {
  if (resuming) {
    // The commit already exists on that branch; all it is missing is a push.
    await runStep('resume-branch', () => git(cwd, 'checkout', branch));
    return;
  }
  await runStep('fetch-base', () => git(cwd, 'fetch', 'origin', base));
  await runStep('create-branch', () =>
    git(cwd, 'checkout', '-b', branch, `origin/${base}`),
  );
  await runStep('stage-ledger', () => git(cwd, 'add', '--', ledgerPath));
  // The `-- <path>` pathspec is what keeps the commit ledger-only even when
  // the sweep's checkout carries unrelated dirt.
  await runStep('commit-ledger', () =>
    git(cwd, 'commit', '-m', subject, '--', ledgerPath),
  );
}

/**
 * Push the ledger branch and open its PR, returning the PR URL.
 *
 * Auto-merge is never requested: the ledger records machine-derived lifecycle
 * state a human should glance at, so landing it stays an operator decision.
 *
 * @param {object} ctx
 * @returns {Promise<string|null>}
 */
async function pushAndOpenPullRequest({
  git,
  cwd,
  gh,
  branch,
  base,
  subject,
  ledgerPath,
  date,
}) {
  await runStep('push-branch', () =>
    git(cwd, 'push', '--set-upstream', 'origin', branch),
  );
  return pullRequestUrl(
    await runStep('open-pull-request', () =>
      gh.pr.create([
        '--base',
        base,
        '--head',
        branch,
        '--title',
        subject,
        '--body',
        pullRequestBody(ledgerPath, date),
      ]),
    ),
  );
}

/**
 * Put the checkout back on the branch the run started on.
 *
 * Best-effort by design, and called from a `finally`: on the failure path
 * especially — where the next thing the operator runs is the retry — leaving
 * them parked on a half-finished ledger branch is its own defect, but a failure
 * to restore must never mask the failure that caused it.
 *
 * @param {{ git: Function, cwd: string, startBranch: string, branch: string }} params
 */
function restoreBranch({ git, cwd, startBranch, branch }) {
  if (!startBranch || startBranch === branch) return;
  try {
    git(cwd, 'checkout', startBranch);
  } catch (_) {
    // Deliberately swallowed — see the contract above.
  }
}

/**
 * Run the whole `--ledger-commit` write sequence against an assessed checkout:
 * refuse or skip, cut (or resume) the branch, push, open the PR, and put the
 * checkout back where it started.
 *
 * **Re-runnable**, which is the property an unattended sweep needs. The two
 * ways a retry used to misbehave are both closed here:
 *
 *   - The branch name is qualified by the base commit, so a same-day retry no
 *     longer collides with the branch a failed run left behind.
 *   - A ledger already committed on an **unpushed** ledger branch resumes at
 *     the push rather than reporting `ledger-unchanged` (the ledger file is
 *     clean — it is committed, just not pushed) and abandoning the work.
 *     Across a failed push and its retry that yields exactly one PR.
 *
 * The branch the run started on is restored in a `finally`, so a failure
 * anywhere in the sequence — and success alike — leaves the operator's checkout
 * where they left it rather than parked on a ledger branch.
 *
 * @param {{ state: object, ledgerPath: string, cwd: string, git: Function,
 *   gh: object, date: string }} params
 * @returns {Promise<object>} the result the CLI summarises.
 */
export async function openLedgerPullRequest({
  state,
  ledgerPath,
  cwd,
  git,
  gh,
  date,
}) {
  const base = state.baseBranch;
  const subject = `chore(audit): reconcile audit ledger ${date}`;
  const { branch, resuming } = resolveLedgerBranch({ git, cwd, base, date });

  if (!state.changed && !resuming) {
    return { committed: false, reason: 'ledger-unchanged', ledgerPath };
  }
  assertCommittable(state, branch);

  const startBranch = state.headBranch;
  let prUrl = null;
  try {
    await commitLedgerOnto({
      git,
      cwd,
      branch,
      base,
      ledgerPath,
      subject,
      resuming,
    });
    prUrl = await pushAndOpenPullRequest({
      git,
      cwd,
      gh,
      branch,
      base,
      subject,
      ledgerPath,
      date,
    });
  } finally {
    restoreBranch({ git, cwd, startBranch, branch });
  }

  return {
    committed: true,
    resumed: resuming,
    branch,
    subject,
    baseBranch: base,
    prUrl,
    ledgerPath,
  };
}
