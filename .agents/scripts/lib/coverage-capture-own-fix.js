/**
 * Own-fix split for the affected coverage delta refresh, opted into by
 * `coverage.ownFixDeltaMaxFiles`. HEAD's first-parent chain back to the
 * stamp splits into base-sync merges (the base part) and the Story's own
 * non-merge commits (the own part); only a narrow, guarded shape is
 * eligible, and every uncertainty refuses.
 */

import picomatch from 'picomatch';
import { filterSuiteInputPaths } from './coverage-capture.js';

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec|e2e)\//;

/** Mirrors the audit-suite selector's test-file predicate. */
function isTestPath(file) {
  return TEST_FILE_RE.test(file) || TEST_DIR_RE.test(file);
}

function refuse(reason) {
  throw new Error(reason);
}

function lines(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter((l) => l.length > 0);
}

function git(ctx, args) {
  const res = ctx.spawn(ctx.cwd, ...args);
  return { status: res?.status ?? 1, stdout: res?.stdout ?? '' };
}

/** stdout of a git call that must succeed. */
function must(ctx, args) {
  const res = git(ctx, args);
  if (res.status !== 0) refuse(`git ${args[0]} failed`);
  return res.stdout;
}

const short = (sha) => sha.slice(0, 12);

/** `[sha, ...parents]` per step, newest first, rooted on the stamp. */
function firstParentChain(ctx) {
  const steps = lines(
    must(ctx, [
      'rev-list',
      '--first-parent',
      '--parents',
      `${ctx.commit}..HEAD`,
    ]),
  ).map((l) => l.split(/\s+/));
  if (steps.at(-1)?.[1] !== ctx.commit) {
    refuse("stamp is not on HEAD's first-parent chain");
  }
  return steps;
}

/** A non-merge commit the base already holds was fast-forwarded in. */
function assertNotOnBase(ctx, sha) {
  if (!ctx.ref) refuse('no base ref to attribute own commits against');
  const { status } = git(ctx, ['merge-base', '--is-ancestor', sha, ctx.ref]);
  if (status === 0)
    refuse(`own commit ${short(sha)} is reachable from ${ctx.ref}`);
  if (status !== 1)
    refuse(`cannot test own commit ${short(sha)} against ${ctx.ref}`);
}

function ownChanges(ctx, sha) {
  assertNotOnBase(ctx, sha);
  const out = must(ctx, [
    'diff-tree',
    '-r',
    '-M',
    '--name-status',
    '--no-commit-id',
    sha,
  ]);
  return lines(out).map((l) => {
    const [status, ...paths] = l.split('\t');
    return { sha, status: status.charAt(0), paths };
  });
}

function splitParts(ctx) {
  const base = new Set();
  const own = [];
  for (const [sha, ...parents] of firstParentChain(ctx)) {
    if (parents.length > 1) {
      for (const f of lines(
        must(ctx, ['diff', '--name-only', parents[0], sha]),
      ))
        base.add(f);
    } else {
      own.push(...ownChanges(ctx, sha));
    }
  }
  return { base: [...base], own };
}

function judgeBase(ctx, base) {
  const shared = ctx.inputs(base).find((f) => ctx.story.has(f));
  if (shared) refuse(`base part shares ${shared} with the Story's change set`);
  const config = ctx.configHandled ? null : ctx.suite(base).find(ctx.isConfig);
  if (config) refuse(`base part touches coverage-determining config ${config}`);
}

function judgeOwnChanges(ctx, own) {
  const paths = [...new Set(own.flatMap((c) => c.paths))];
  const config = ctx.suite(paths).find(ctx.isConfig);
  if (config) refuse(`own part touches coverage-determining config ${config}`);
  for (const c of own) {
    const moved = c.status === 'D' || c.status === 'R';
    const input = moved && ctx.suite(c.paths)[0];
    if (input) refuse(`own commit ${short(c.sha)} deletes or renames ${input}`);
  }
  return ctx.inputs(paths).filter((f) => ctx.delta.has(f));
}

/** A weakened test is how a row outside the delta goes stale high. */
function judgeOwnTests(ctx, files) {
  const tests = files.filter(isTestPath);
  if (tests.length === 0) return;
  const out = must(ctx, [
    'diff',
    '--numstat',
    ctx.commit,
    'HEAD',
    '--',
    ...tests,
  ]);
  for (const [added, deleted, file] of lines(out).map((l) => l.split('\t'))) {
    if (added === '-' || Number(deleted) > Number(added)) {
      refuse(`own part removes lines from test file ${file}`);
    }
  }
}

function judge(ctx, { base, own }) {
  judgeBase(ctx, base);
  const ownFiles = judgeOwnChanges(ctx, own);
  if (ownFiles.length > ctx.max) {
    refuse(
      `own part has ${ownFiles.length} suite-input file(s), over ownFixDeltaMaxFiles ${ctx.max}`,
    );
  }
  judgeOwnTests(ctx, ownFiles);
  const baseFiles = ctx.inputs(base).filter((f) => ctx.delta.has(f));
  return { own: ownFiles.length, base: baseFiles.length };
}

/**
 * @param {{ cwd: string, commit: string, ref: string | null, spawn: Function, max: number, delta: Set<string>, story: Set<string>, suite: (f: string[]) => string[], inputs: (f: string[]) => string[], isConfig: (f: string) => boolean, configHandled: boolean }} ctx
 * @returns {{ ok: true, own: number, base: number } | { ok: false, reason: string }}
 */
function classifyOwnFix(ctx) {
  try {
    return { ok: true, ...judge(ctx, splitParts(ctx)) };
  } catch (err) {
    return { ok: false, reason: `own-fix: ${err?.message ?? err}` };
  }
}

/** Refusals the split may re-judge; any other refusal stands. */
const REJUDGED = new Set(['overlap', 'own-commits', 'config']);

function ownFixContext({
  cwd,
  crap,
  coverage,
  storyFiles,
  stamp,
  rule,
  baseRef,
  spawn,
  isConfig,
}) {
  const isNonInput =
    coverage.nonInputGlobs?.length > 0
      ? picomatch(coverage.nonInputGlobs, { dot: true })
      : () => false;
  const suite = (files) => filterSuiteInputPaths(files, crap.coveragePath);
  return {
    cwd,
    commit: stamp.commit,
    ref: baseRef,
    spawn,
    max: coverage.ownFixDeltaMaxFiles,
    delta: new Set(rule.delta),
    story: new Set(storyFiles),
    suite,
    inputs: (files) => suite(files).filter((f) => !isNonInput(f)),
    isConfig,
    configHandled: coverage.captureHandlesConfigChanges === true,
  };
}

/** The eligible plan's log line, distinct so the hit rate is countable. */
function reportOwnFix(plan, crap, logger, formatFreshnessDetail) {
  const files = plan.rule.delta;
  const detail = formatFreshnessDetail({
    stamp: plan.stamp,
    requiredScope: 'affected',
    verdict: 'own-fix-delta-refresh',
    deltaFiles: files.length,
  });
  logger.info(
    `[coverage-capture] Coverage at ${crap.coveragePath} needs an own-fix delta refresh — re-measuring ${files.length} file(s) changed since ${short(plan.commit)} (${plan.ownFix.own} own file(s), ${plan.ownFix.base} base file(s)). ${detail}`,
  );
  return { baseRef: plan.commit, dropFiles: files };
}

/**
 * The verdict on a delta today's rule refused: that refusal stands, with no
 * git command run, unless `ownFixDeltaMaxFiles` is set and the refusal was
 * a Story overlap or config; then the own-fix split decides.
 */
export function judgeOwnFix(opts) {
  const { coverage, rule, stamp } = opts;
  const no = (reason) => ({ eligible: false, reason, stamp, rule });
  if (!(coverage?.ownFixDeltaMaxFiles >= 1) || !REJUDGED.has(rule.rule)) {
    return no(rule.reason);
  }
  const own = classifyOwnFix(ownFixContext(opts));
  if (!own.ok) return no(own.reason);
  const plan = { eligible: true, restamp: false, commit: stamp.commit };
  const report = (p, crap, logger) =>
    reportOwnFix(p, crap, logger, opts.formatFreshnessDetail);
  return { ...plan, rule, stamp, ownFix: own, report };
}
