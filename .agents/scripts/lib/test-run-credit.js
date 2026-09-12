/**
 * lib/test-run-credit.js — let a green bare `npm test` earn the credit close
 * reads (Story #5313).
 *
 * Until this module the only suite run that deposited credit was the one
 * shaped exactly like the close gate — `coverage-capture.js --cwd <worktree>`
 * or `evidence-gate.js --standalone … -- npm test` — and the digest, the
 * worker boot context and the reference all carried prose explaining which
 * invocation to type. A worker that ran the project's own test runner paid
 * for the suite and then close paid for it again. The runner is the natural
 * depositor: it knows the tree it ran against, whether the run was green,
 * and whether it ran the whole suite.
 *
 * On a green **full-tier** run inside a `story-<id>` checkout the runner
 * records the `test` gate's evidence in the same keyspace
 * `close-validation/runner.js` consults — keyed on HEAD and the tree
 * fingerprint, hashed on the exact `{ cmd: 'npm', args: ['test'], cwd }`
 * close will spawn — so close's `test` gate short-circuits at unchanged HEAD.
 * The freshness keying is untouched: a later commit voids the record exactly
 * as it voids one `evidence-gate.js` wrote.
 *
 * What it deliberately does **not** do is write the coverage capture stamp:
 * that stamp is a claim that `coverage/coverage-final.json` describes this
 * tree, and a bare `npm test` produces no such artifact. The CRAP gate still
 * runs `coverage-capture.js` when it needs one.
 *
 * Total: every failure — not a Story branch, no git, an unwritable evidence
 * file — is reported by reason and never fails the test run that earned it.
 *
 * @module lib/test-run-credit
 */

import path from 'node:path';

import { gitSpawn as defaultGitSpawn } from './git-utils.js';
import {
  recordPass as defaultRecordPass,
  shouldSkip as defaultShouldSkip,
  hashCommandConfig,
  treeFingerprint,
} from './validation-evidence.js';

/** The gate name close's runner looks the record up under. */
const GATE_NAME = 'test';

/** The exact command close spawns for that gate — the hash must match it. */
const GATE_COMMAND = Object.freeze({
  cmd: 'npm',
  args: Object.freeze(['test']),
});

/**
 * Read one trimmed git stdout line, or `null` on any failure.
 *
 * @param {Function} gitSpawnFn
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null}
 */
function gitLine(gitSpawnFn, cwd, args) {
  try {
    const res = gitSpawnFn(cwd, ...args);
    if (res?.status !== 0) return null;
    const line = String(res.stdout ?? '').trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/**
 * The Story id a checkout's branch names, or `null` off a Story branch.
 *
 * @param {string|null} branch
 * @returns {number|null}
 */
export function storyIdFromBranch(branch) {
  const match = /^story-(\d+)$/.exec(branch ?? '');
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The checkout whose temp tree holds the evidence keyspace: the **main**
 * checkout, which is where close runs with `--cwd <main-repo>`. From a
 * worktree `git rev-parse --git-common-dir` names the main `.git`; from the
 * main checkout it names its own. Either way the parent is the checkout.
 *
 * @param {string} cwd
 * @param {Function} gitSpawnFn
 * @returns {string|null}
 */
export function resolveEvidenceRoot(cwd, gitSpawnFn) {
  const common = gitLine(gitSpawnFn, cwd, ['rev-parse', '--git-common-dir']);
  if (!common) return null;
  const absolute = path.resolve(cwd, common);
  return path.basename(absolute) === '.git' ? path.dirname(absolute) : null;
}

/**
 * Deposit the `test` gate's evidence for a green full-suite run.
 *
 * @param {{
 *   cwd: string,
 *   tier?: string,
 *   status?: number,
 *   durationMs?: number|null,
 *   gitSpawnFn?: typeof defaultGitSpawn,
 *   recordPassFn?: typeof defaultRecordPass,
 * }} args
 * @returns {{ deposited: boolean, reason: string, storyId?: number, sha?: string }}
 */
export function depositTestRunCredit({
  cwd,
  tier = 'full',
  status = 0,
  durationMs = null,
  gitSpawnFn = defaultGitSpawn,
  recordPassFn = defaultRecordPass,
} = {}) {
  if (status !== 0) return { deposited: false, reason: 'run-not-green' };
  if (tier !== 'full') return { deposited: false, reason: 'not-full-tier' };
  const storyId = storyIdFromBranch(
    gitLine(gitSpawnFn, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  );
  if (storyId === null)
    return { deposited: false, reason: 'not-a-story-branch' };
  const sha = gitLine(gitSpawnFn, cwd, ['rev-parse', 'HEAD']);
  const evidenceRoot = resolveEvidenceRoot(cwd, gitSpawnFn);
  if (!sha || !evidenceRoot) {
    return { deposited: false, reason: 'tree-unreadable', storyId };
  }
  return writeRecord({
    storyId,
    sha,
    cwd,
    evidenceRoot,
    durationMs,
    gitSpawnFn,
    recordPassFn,
  });
}

/**
 * Deposit and say so on stderr — the runner's one-line hook. The line is
 * the only surface a worker sees, so it names the outcome by reason.
 *
 * @param {Parameters<typeof depositTestRunCredit>[0] & { log?: (line: string) => void }} args
 * @returns {ReturnType<typeof depositTestRunCredit>}
 */
export function reportTestRunCredit({
  log = (line) => process.stderr.write(`${line}\n`),
  ...args
} = {}) {
  const credit = depositTestRunCredit(args);
  log(
    credit.deposited
      ? `[run-tests] ✓ deposited the close test credit for story #${credit.storyId} at ${credit.sha.slice(0, 7)}`
      : `[run-tests] no close test credit deposited (${credit.reason})`,
  );
  return credit;
}

/**
 * Is the `test` gate already credited for this tree — did a green bare
 * `npm test` in the Story worktree deposit its evidence? The read side of
 * {@link depositTestRunCredit}, consulted by `close-validation/gates.js`.
 *
 * When it did, close registers the plain `test` gate beside the capture gate
 * even though coverage-capture is the active test runner: the runner's
 * evidence check then skips it as credited, so close REPORTS the suite the
 * worker already ran instead of silently folding it into the capture. It is
 * never a second spend — an uncredited tree resolves `false` and the
 * pre-#5313 shape (capture alone runs the suite) is unchanged. Every
 * uncertainty resolves `false`.
 *
 * @param {{
 *   storyId?: number|null,
 *   cwd?: string,
 *   evidenceCwd?: string|null,
 *   gitSpawnImpl?: typeof defaultGitSpawn,
 *   shouldSkipImpl?: typeof defaultShouldSkip,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {boolean}
 */
export function predictsTestEvidenceCredit({
  storyId,
  cwd,
  evidenceCwd,
  gitSpawnImpl = defaultGitSpawn,
  shouldSkipImpl = defaultShouldSkip,
  log,
} = {}) {
  if (!Number.isInteger(storyId) || storyId <= 0) return false;
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  try {
    const sha = gitLine(gitSpawnImpl, cwd, ['rev-parse', 'HEAD']);
    if (!sha) return false;
    const verdict = shouldSkipImpl(
      {
        storyId,
        gateName: GATE_NAME,
        currentSha: sha,
        configHash: hashCommandConfig({
          cmd: GATE_COMMAND.cmd,
          args: [...GATE_COMMAND.args],
          cwd: path.resolve(cwd),
        }),
        inputFingerprint: treeFingerprint(cwd, gitSpawnImpl),
      },
      { cwd: evidenceCwd ?? cwd, standalone: true },
    );
    if (verdict.skip !== true) return false;
    log?.(
      '[close-validation] a green `npm test` already deposited the test credit for this tree — registering the plain `test` gate so close reports it as credited.',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The write itself, split out so the guard chain above stays flat.
 *
 * @param {{ storyId: number, sha: string, cwd: string, evidenceRoot: string, durationMs: number|null, gitSpawnFn: Function, recordPassFn: Function }} args
 * @returns {{ deposited: boolean, reason: string, storyId: number, sha: string }}
 */
function writeRecord({
  storyId,
  sha,
  cwd,
  evidenceRoot,
  durationMs,
  gitSpawnFn,
  recordPassFn,
}) {
  try {
    recordPassFn(
      {
        storyId,
        gateName: GATE_NAME,
        sha,
        configHash: hashCommandConfig({
          cmd: GATE_COMMAND.cmd,
          args: [...GATE_COMMAND.args],
          cwd: path.resolve(cwd),
        }),
        exitCode: 0,
        durationMs,
        inputFingerprint: treeFingerprint(cwd, gitSpawnFn),
      },
      { cwd: evidenceRoot, standalone: true },
    );
    return { deposited: true, reason: 'recorded', storyId, sha };
  } catch (err) {
    return {
      deposited: false,
      reason: `record-failed: ${err?.message ?? err}`,
      storyId,
      sha,
    };
  }
}
