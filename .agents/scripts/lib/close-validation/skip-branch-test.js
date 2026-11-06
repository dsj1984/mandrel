/**
 * The skip-branch `test` run: when coverage-capture takes its incremental
 * skip, handoff and close run `project.commands.testChanged` keyed on the
 * `origin/<baseBranch>` merge-base instead of the full suite, credited under
 * close's full-suite `test` identity as `scope: delta`.
 */

import { gitSpawn } from '../git-utils.js';
import { testGateConfigHash } from '../test-run-credit.js';
import { resolveTestGateArgv } from './commands.js';
import {
  NO_TEST_CHANGED,
  resolveTestChangedCommand,
  substituteChangedSince,
} from './test-delta.js';

const HEX_SHA = /^[0-9a-f]{7,64}$/i;

/** The merge-base sha, or `null` when git fails or prints nothing. */
function readMergeBase(gitSpawnImpl, cwd, baseBranch) {
  try {
    const res = gitSpawnImpl(cwd, 'merge-base', `origin/${baseBranch}`, 'HEAD');
    return res?.status === 0 ? String(res.stdout ?? '').trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * The scope both handoff and close read: `testChanged` and the merge-base it
 * is keyed on, or the reason the full suite runs instead.
 *
 * @returns {{ testChanged: object, since: string } | { fallback: string }}
 */
export function resolveSkipBranchScope({
  config,
  cwd,
  baseBranch,
  gitSpawnImpl = gitSpawn,
}) {
  const testChanged = resolveTestChangedCommand(config);
  if (testChanged.disabled) return { fallback: NO_TEST_CHANGED };
  const since = readMergeBase(gitSpawnImpl, cwd, baseBranch);
  return since ? { testChanged, since } : { fallback: 'merge-base unreadable' };
}

/** Close's skip-branch `test` gate. */
export function buildSkipBranchTestGate({ config, testChanged, since }) {
  const short = since.slice(0, 12);
  return {
    name: 'test',
    label: `test (testChanged since ${short})`,
    ...substituteChangedSince(testChanged, since),
    fullSuiteLock: true,
    evidenceIdentity: resolveTestGateArgv(config),
    evidenceNote: { scope: 'delta', since },
    hint: `\`${testChanged.raw}\` (\`project.commands.testChanged\`, the tests affected since ${short}) exited non-zero. Fix the failing tests, commit, and re-run close.`,
  };
}

/**
 * Close's `test` gate: the scoped run when a skip-branch scope resolved,
 * else the plain full suite (`project.commands.test`).
 */
export function closeTestGate(config, scope) {
  return scope?.since
    ? buildSkipBranchTestGate({ config, ...scope })
    : { name: 'test', ...resolveTestGateArgv(config), fullSuiteLock: true };
}

const SKIP_PREFIX =
  '[close-validation] coverage-capture will take the incremental skip (no changed file under the CRAP target dirs) — registering';

/** Close's one log line naming the `test` shape the skip branch registers. */
function describeCloseScope(scope) {
  return scope.since
    ? `${SKIP_PREFIX} the \`test\` gate as \`project.commands.testChanged\` since ${scope.since.slice(0, 12)}, credited as the full suite.`
    : `${SKIP_PREFIX} the plain \`test\` gate (${scope.fallback}) so this close still runs the suite.`;
}

/** On the skip branch, close's scope (logged); elsewhere `null`. */
export function closeTestScope({ skipBranch, log, gitSpawnImpl, ...where }) {
  if (!skipBranch) return null;
  const scope = resolveSkipBranchScope({
    ...where,
    baseBranch: where.baseBranch || 'main',
    ...(gitSpawnImpl ? { gitSpawnImpl } : {}),
  });
  log?.(describeCloseScope(scope));
  return scope;
}

/**
 * The handoff's `test` deposit tail for evidence-gate and its step label: the
 * scoped run, or close's full `test` argv naming why.
 *
 * @returns {{ argv: string[], label: string, fallback?: string }}
 */
export function skipBranchDeposit({ config, cwd, baseBranch, gitSpawnImpl }) {
  const scope = resolveSkipBranchScope({
    config,
    cwd,
    baseBranch,
    gitSpawnImpl,
  });
  if (scope.fallback) {
    const { cmd, args } = resolveTestGateArgv(config);
    return {
      argv: ['--', cmd, ...args],
      label: `test (full suite: ${scope.fallback})`,
      fallback: scope.fallback,
    };
  }
  const { cmd, args } = scope.testChanged;
  return {
    argv: ['--changed-since', scope.since, '--', cmd, ...args],
    label: `test (testChanged since ${scope.since.slice(0, 12)})`,
  };
}

/** evidence-gate's `--changed-since` refusal, or `null` when it may run. */
export function changedSinceError(gate, changedSince) {
  if (changedSince === null || changedSince === undefined) return null;
  if (gate !== 'test') return '--changed-since is valid only with --gate test';
  return HEX_SHA.test(String(changedSince))
    ? null
    : `--changed-since must be a hex commit sha, got "${changedSince}"`;
}

/**
 * evidence-gate's scoped run: the token substituted, the sha in the env, and
 * the pass credited under close's full-suite `test` identity.
 */
export function scopedEvidenceRun({ cmd, args, since, config, cwd }) {
  const run = substituteChangedSince({ cmd, args }, since);
  return {
    cmd: run.cmd,
    cmdArgs: run.args,
    env: run.env,
    note: { scope: 'delta', since },
    configHash: testGateConfigHash(config, cwd),
  };
}
