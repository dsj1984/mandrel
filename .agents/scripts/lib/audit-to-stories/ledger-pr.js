/**
 * The `--ledger-commit` write sequence. Every refusal precedes the first
 * write.
 */

/**
 * Read-only git probe that never throws; a checkout with no commits is an
 * answer, not a crash. Writes use `runStep`, where failure is fatal.
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
 * Qualifies the branch name so it is unique across bases (a same-day retry
 * must not collide) yet deterministic per base (so a retry recognises its own
 * half-finished branch).
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
 * A local, never-pushed ledger branch is a failed run's commit: resume at the
 * push, so a failed push plus its retry yields exactly one PR.
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
 * Refuses before any write. HEAD off the base branch would cut the ledger
 * branch from a feature tip and carry its unrelated commits into the PR.
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
 * @param {unknown} result
 * @returns {string|null}
 */
function pullRequestUrl(result) {
  const text = typeof result === 'string' ? result : (result?.stdout ?? '');
  const match = /https?:\/\/\S+/.exec(String(text ?? ''));
  return match ? match[0] : null;
}

/**
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
    await runStep('resume-branch', () => git(cwd, 'checkout', branch));
    return;
  }
  await runStep('fetch-base', () => git(cwd, 'fetch', 'origin', base));
  await runStep('create-branch', () =>
    git(cwd, 'checkout', '-b', branch, `origin/${base}`),
  );
  await runStep('stage-ledger', () => git(cwd, 'add', '--', ledgerPath));
  // The pathspec keeps the commit ledger-only in a dirty checkout.
  await runStep('commit-ledger', () =>
    git(cwd, 'commit', '-m', subject, '--', ledgerPath),
  );
}

/**
 * Never requests auto-merge: landing the ledger stays an operator decision.
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
 * Best-effort, from a `finally`: a failed restore must never mask the failure
 * that caused it.
 *
 * @param {{ git: Function, cwd: string, startBranch: string, branch: string }} params
 */
function restoreBranch({ git, cwd, startBranch, branch }) {
  if (!startBranch || startBranch === branch) return;
  try {
    git(cwd, 'checkout', startBranch);
  } catch (_) {
    // Deliberately swallowed.
  }
}

/**
 * Re-runnable; always restores the starting branch.
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
