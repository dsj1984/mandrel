/**
 * A green full-tier `run-tests.js` run on a `story-<id>` branch deposits the
 * `test` evidence close reads — a bonus; `evidence-gate.js` is the contract.
 * Other runners never load this, so absence of its line means nothing. Never
 * writes the coverage stamp (no coverage artifact exists). Never fails the run.
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

const GATE_NAME = 'test';

/** Must hash identically to the command close spawns. */
const GATE_COMMAND = Object.freeze({
  cmd: 'npm',
  args: Object.freeze(['test']),
});

/**
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
 * The main checkout (where close reads evidence), via `--git-common-dir`.
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
 * Deposit and report the outcome (with reason) on stderr.
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
 * Read side of {@link depositTestRunCredit}: when credited, close registers
 * the plain `test` gate so it reports as credited (never a second spend).
 * Every uncertainty resolves `false`.
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
