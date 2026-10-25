/**
 * Close's `test` delta re-credit: after base-sync merged incoming paths, plan
 * a `testChanged` run keyed on the pre-sync head instead of the full suite.
 * The incoming-path rules are coverage-capture's own delta rules.
 */

import { getChangedFiles } from '../changed-files.js';
import { closeDeltaIneligibility } from '../coverage-capture-delta.js';
import { hasTestCreditAt } from '../test-run-credit.js';
import { resolveTestGateArgv } from './commands.js';

/**
 * `project.commands.testChanged`: absent or `null` is disabled with no argv —
 * it has no default. The schema guards it like every other command.
 *
 * @param {object|null|undefined} config
 */
function resolveTestChangedCommand(config) {
  const raw = config?.project?.commands?.testChanged?.trim() || null;
  const [cmd, ...args] = raw ? raw.split(/\s+/) : [];
  return { cmd, args, raw, disabled: raw === null };
}

const CHANGED_SINCE_TOKEN = '$MANDREL_CHANGED_SINCE';

/** `testChanged` keyed on `since`, credited as the full suite; no shell runs it, so the token is substituted here. */
function buildTestDeltaGate({ config, testChanged, since, incoming }) {
  const label = `test (delta since ${since.slice(0, 12)}, ${incoming} incoming path(s))`;
  return {
    name: 'test',
    label,
    cmd: testChanged.cmd,
    args: testChanged.args.map((a) => (a === CHANGED_SINCE_TOKEN ? since : a)),
    env: { MANDREL_CHANGED_SINCE: since },
    fullSuiteLock: true,
    evidenceIdentity: resolveTestGateArgv(config),
    evidenceNote: { scope: 'delta', since },
    hint: `The delta re-credit failed — \`${testChanged.raw}\` (\`project.commands.testChanged\`, scope: delta, the tests affected since ${since.slice(0, 12)}) exited non-zero after the base sync. Fix the failing tests, commit, and re-run close.`,
  };
}

/** Why the delta cannot replace the full run, or `null`; probes run lazily, cheapest first. */
function testDeltaIneligibility({
  testChanged,
  captureRuns,
  credited,
  incoming,
  storyFiles,
  config,
}) {
  if (testChanged.disabled) return 'no `project.commands.testChanged`';
  if (captureRuns) return 'coverage-capture runs the suite';
  if (!credited()) return 'no `test` credit for the pre-sync head';
  const files = storyFiles();
  if (!files) return 'Story change set unreadable';
  return closeDeltaIneligibility({
    delta: incoming,
    storyFiles: files,
    config,
  });
}

/** The Story's own change set against the synced base, or `null`. */
function readStoryFiles({ cwd, baseBranch, getChangedFilesImpl }) {
  if (!cwd || !baseBranch) return null;
  try {
    const files = getChangedFilesImpl({ ref: `origin/${baseBranch}`, cwd });
    return Array.isArray(files) ? files : null;
  } catch {
    return null;
  }
}

/**
 * Swap the plain `test` gate for the delta re-credit when every rule holds;
 * otherwise return `gates` unchanged, logging the failed rule (no base move
 * logs nothing). No plain `test` gate means coverage-capture runs the suite.
 *
 * @param {import('./gates.js').Gate[]} gates
 * @returns {import('./gates.js').Gate[]}
 */
export function applyTestDelta(
  gates,
  {
    baseSync,
    config,
    storyId,
    cwd,
    evidenceCwd,
    baseBranch,
    shouldSkipImpl,
    getChangedFilesImpl = getChangedFiles,
    log,
  },
) {
  const incoming = baseSync?.changedPaths ?? [];
  if (incoming.length === 0) return gates;
  const since = baseSync.creditedCommit;
  const testChanged = resolveTestChangedCommand(config);
  const index = gates.findIndex((g) => g.name === 'test');
  const reason = testDeltaIneligibility({
    testChanged,
    captureRuns: index === -1,
    credited: () =>
      hasTestCreditAt({
        config,
        storyId,
        cwd,
        evidenceCwd,
        sha: since,
        ...(shouldSkipImpl ? { shouldSkipImpl } : {}),
      }),
    incoming,
    storyFiles: () => readStoryFiles({ cwd, baseBranch, getChangedFilesImpl }),
    config,
  });
  if (reason) {
    log?.(
      `[close-validation] test delta re-credit not eligible (${reason}) — running the full suite`,
    );
    return gates;
  }
  const delta = buildTestDeltaGate({
    config,
    testChanged,
    since,
    incoming: incoming.length,
  });
  return gates.map((g, i) => (i === index ? delta : g));
}
