#!/usr/bin/env node
/**
 * .agents/scripts/quality-preview.js — Per-file MI/CRAP delta preview.
 *
 * Runs the maintainability + CRAP gates in-process via the per-kind
 * preview runners under `lib/baselines/preview-gates.js`, then merges
 * their structured envelopes into a single per-file delta table
 * contributors can read while the diff is still warm. Designed for
 * three callers:
 *
 *   1. `npm run quality:preview`   — interactive operator, pretty table.
 *   2. `npm run quality:watch`     — chokidar wrapper re-emits on save.
 *   3. `.husky/pre-commit`         — block the commit on threshold violations.
 *
 * The pre-commit hook passes `--staged` and nothing else — the index is
 * already the exact delta the operator is about to commit, and
 * `tests/pre-commit-hook.test.js` pins that `--changed-since` stays off it.
 * (This docblock previously claimed the hook passed `--changed-since HEAD`,
 * describing a wiring the hook has not used for some time; the stale prose
 * sent at least one bug report at the wrong flag — Story #5131.)
 *
 * `--staged` is merge-aware: while a merge is in progress the index is read
 * against `MERGE_HEAD` rather than `HEAD`, so a base-sync merge commit is
 * scored for the merging branch's own work and its conflict resolutions, not
 * for everything the base branch landed. See `resolveMergeHead` in
 * `lib/changed-files.js`.
 *
 * The CLI exits 0 when both envelopes report zero violations and the script
 * could not surface a regression. Any violation in either envelope, or any
 * non-zero gate exit, propagates as a non-zero exit code so git/husky/CI
 * surface the failure. The merge logic is exported as `mergeEnvelopes` for
 * unit testing without spawning the gate scripts.
 */

import path from 'node:path';
import process from 'node:process';
import {
  runCrapPreview,
  runMaintainabilityPreview,
} from './lib/baselines/preview-gates.js';
import { resolveMergeHead } from './lib/changed-files.js';
import { respondToHelp } from './lib/cli-usage.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import { resolveCyclomaticPolicy } from './lib/cyclomatic-ceiling.js';

const USAGE = {
  invocation:
    'node .agents/scripts/quality-preview.js [--staged | --changed-since <ref>] [--json]',
  summary:
    'Preview the per-file maintainability and CRAP deltas for the change set, and exit non-zero on any threshold violation.',
  flags: [
    [
      '--staged',
      'Score the git index only (the pre-commit-hook scope). During a merge the index is read against MERGE_HEAD.',
    ],
    [
      '--changed-since <ref>',
      'Score the diff against <ref> (default: HEAD). Last occurrence wins.',
    ],
    ['--json', 'Emit both gate envelopes plus the merged table as JSON.'],
  ],
};

/**
 * Framework default for `delivery.quality.codingGuardrails.cyclomaticFlag`,
 * used only when a caller drives `mergeEnvelopes` / `renderTable` without a
 * resolved config in hand (tests, and the pure-function surface). `runCli`
 * always passes the resolved value.
 */
const DEFAULT_CYCLOMATIC_FLAG = 8;

/**
 * Parse `--changed-since <ref>` from argv. Defaults to `HEAD` when the flag is
 * present without a value. Returns `null` when the flag is absent so callers
 * can fall through to the gate scripts' own diff defaults.
 *
 * **Last occurrence wins** (Story #4603). `npm run <alias> -- --changed-since <base>`
 * appends the operator's flag *after* any flag baked into the npm script, so a
 * first-wins scan silently discarded the operator's base and compared against
 * the script's hardcoded one instead — reporting a false green for a branch the
 * gate had never actually scored. Last-wins matches the convention every
 * mainstream CLI parser follows for repeated scalar flags, and makes the
 * npm-alias passthrough behave the way its callers already assume.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
export function parseChangedSinceArg(argv) {
  let resolved = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--changed-since') continue;
    const next = argv[i + 1];
    resolved = next && !next.startsWith('--') ? next : 'HEAD';
  }
  return resolved;
}

/**
 * Detect `--json` (machine-readable mode). When set, the merged envelope is
 * written to stdout as JSON instead of the human-readable table; the exit code
 * still reflects gate health so CI runners can fail fast.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function parseJsonFlag(argv) {
  return argv.includes('--json');
}

/**
 * Detect `--staged` (pre-commit mode). Used by `.husky/pre-commit` to
 * scope both MI and CRAP preview gates to `git diff --name-only --cached`
 * so only index (staged) paths are scored. When present, `--staged` takes
 * precedence over `--changed-since`.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function parseStagedFlag(argv) {
  return argv.includes('--staged');
}

/**
 * Coerce a caller-supplied flag ceiling to a usable number, falling back to
 * the framework default for anything non-finite.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeFlag(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : DEFAULT_CYCLOMATIC_FLAG;
}

/**
 * Fold one CRAP violation into its per-file aggregate row. Mutates `row`.
 *
 * Split out of `mergeEnvelopes` (Story #4923): threading the resolved
 * `cyclomaticFlag` through pushed that function from c=12 — exactly at the
 * must-fix ceiling — to c=13, and the same Story starts *enforcing* that
 * ceiling. Recording its own breach in `baselines/cyclomatic.json` would have
 * been the first re-spend of the slack the Story reclaims.
 *
 * @param {{ worstCrapDelta: number, newOverCeilingMethods: number }} row
 * @param {{ crap?: number, ceiling?: number, baseline?: number, cyclomatic?: number, kind?: string }} v
 * @param {number} flag resolved `codingGuardrails.cyclomaticFlag`
 * @returns {void}
 */
function foldCrapViolation(row, v, flag) {
  const crap = Number(v.crap ?? 0);
  const isNew = v.kind === 'new';
  const against = Number((isNew ? v.ceiling : v.baseline) ?? 0);
  const delta = crap - against;
  if (Number.isFinite(delta) && delta > row.worstCrapDelta) {
    row.worstCrapDelta = delta;
  }
  if (!isNew) return;
  const cyclomatic = Number(v.cyclomatic ?? 0);
  if (Number.isFinite(cyclomatic) && cyclomatic > flag) {
    row.newOverCeilingMethods += 1;
  }
}

/**
 * Merge an MI envelope (from `runMaintainabilityPreview`) and a CRAP
 * envelope (from `runCrapPreview`) into a per-file delta map. Pure —
 * no I/O, no spawn. Tests pin the math without invoking the runners.
 *
 * Output rows are keyed by file (forward-slash relative path) and carry:
 *   - `miDrop`: maintainability score drop from baseline (0 when unchanged or
 *     improved). Higher = worse.
 *   - `worstCrapDelta`: largest CRAP regression delta among the file's
 *     methods (max of `crap - baseline` for matched-baseline rows, `crap`
 *     for new-method rows). 0 when the file has no CRAP violations.
 *   - `newOverCeilingMethods`: count of new-method violations (kind:'new')
 *     scoring above the flag ceiling. The CRAP envelope's `cyclomatic` field
 *     is the per-method `c` reading.
 *
 * `cyclomaticFlag` is the resolved
 * `delivery.quality.codingGuardrails.cyclomaticFlag` (Story #4923). It used to
 * be the literal `8` written into this function and into the column header, so
 * a consumer that tuned the knob saw its own value validated by the schema,
 * defaulted by the bootstrap, resolved by `lib/config/quality.js` — and then
 * ignored here. The parameter defaults to the framework default so a caller
 * with no config in hand still gets the historical reading.
 *
 * @param {{ violations?: Array<{ file: string, drop?: number }> } | null} miEnvelope
 * @param {{ violations?: Array<{
 *   file: string,
 *   crap: number,
 *   baseline: number | null,
 *   ceiling: number,
 *   cyclomatic: number,
 *   kind: 'new' | 'regression' | 'drifted-regression' | string,
 * }>} | null} crapEnvelope
 * @param {{ cyclomaticFlag?: number }} [opts]
 * @returns {{
 *   rows: Array<{
 *     file: string,
 *     miDrop: number,
 *     worstCrapDelta: number,
 *     newOverCeilingMethods: number,
 *   }>,
 *   totals: { miRegressions: number, crapViolations: number },
 *   cyclomaticFlag: number,
 * }}
 */
export function mergeEnvelopes(
  miEnvelope,
  crapEnvelope,
  { cyclomaticFlag = DEFAULT_CYCLOMATIC_FLAG } = {},
) {
  const flag = normalizeFlag(cyclomaticFlag);
  /** @type {Map<string, { miDrop: number, worstCrapDelta: number, newOverCeilingMethods: number }>} */
  const byFile = new Map();
  const ensure = (file) => {
    let row = byFile.get(file);
    if (!row) {
      row = { miDrop: 0, worstCrapDelta: 0, newOverCeilingMethods: 0 };
      byFile.set(file, row);
    }
    return row;
  };

  const miViolations = miEnvelope?.violations ?? [];
  for (const v of miViolations) {
    if (!v?.file) continue;
    const row = ensure(v.file);
    const drop = Number(v.drop ?? 0);
    if (Number.isFinite(drop) && drop > row.miDrop) row.miDrop = drop;
  }

  const crapViolations = crapEnvelope?.violations ?? [];
  for (const v of crapViolations) {
    if (!v?.file) continue;
    foldCrapViolation(ensure(v.file), v, flag);
  }

  const rows = Array.from(byFile.entries())
    .map(([file, agg]) => ({ file, ...agg }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    rows,
    totals: {
      miRegressions: miEnvelope?.summary?.regressions ?? 0,
      crapViolations:
        (crapEnvelope?.summary?.regressions ?? 0) +
        (crapEnvelope?.summary?.newViolations ?? 0),
    },
    cyclomaticFlag: flag,
    // Story #5313: advisories ride the merge but never the exit code.
    advisories: Array.isArray(crapEnvelope?.cyclomaticAdvisories)
      ? crapEnvelope.cyclomaticAdvisories
      : [],
  };
}

/**
 * Render the cyclomatic advisories block (Story #5313), or `null` when the
 * scan carried none. One line per method at or over the ceiling; the block
 * says outright that it is advisory so a reader does not hunt for the exit
 * code it did not change.
 *
 * @param {Array<{ file: string, method: string, startLine: number, cyclomatic: number }>} advisories
 * @returns {string|null}
 */
export function renderAdvisories(advisories) {
  const list = Array.isArray(advisories) ? advisories : [];
  if (list.length === 0) return null;
  return [
    `Advisory — ${list.length} method(s) at cyclomatic 12 or above (reported, not a verdict; check-cyclomatic.js owns the ratchet):`,
    ...list.map(
      (a) => `  - ${a.file}:${a.startLine} ${a.method} (c=${a.cyclomatic})`,
    ),
  ].join('\n');
}

/**
 * Render the named diagnostics a gate envelope carries, or `null` when it
 * carries none (Story #4866).
 *
 * A diagnostic is what a gate emits *instead of* per-method verdicts when it
 * has established that no verdict it could produce would be meaningful — an
 * incomparable baseline, or a comparison basis whose drifted-row ratio proves
 * the two sides disagree on line coordinates. It must reach the operator
 * verbatim: the gate exits 0, so silence would read as a clean run.
 *
 * @param {Array<{ envelope: { diagnostics?: Array<{name: string, message: string}> } | null }>} results
 * @returns {string | null}
 */
export function renderDiagnostics(results) {
  const lines = [];
  for (const { envelope } of results ?? []) {
    for (const d of envelope?.diagnostics ?? []) {
      lines.push(`[${d.name}] ${d.message}`);
    }
  }
  return lines.length === 0 ? null : lines.join('\n');
}

/**
 * Compute the CLI exit code from a merge result + per-gate exit codes. Pure.
 *
 * The exit code is non-zero (1) whenever:
 *   - either gate returned a non-zero exit code (real violations or runtime
 *     failure), OR
 *   - the merged envelope reports any violation rows at all.
 *
 * Both signals are combined so a transient gate failure (e.g. JSON write
 * error) still surfaces even if the violations array happens to be empty.
 *
 * Advisories (`merged.advisories`, Story #5313) are deliberately not read
 * here: a method at cyclomatic 12 or above is reported and exits 0.
 *
 * @param {{ rows: Array<unknown>, totals: { miRegressions: number, crapViolations: number } }} merged
 * @param {number} miExit
 * @param {number} crapExit
 * @returns {number}
 */
export function computeExitCode(merged, miExit, crapExit) {
  if (miExit !== 0 || crapExit !== 0) return 1;
  if (merged.rows.length > 0) return 1;
  if (merged.totals.miRegressions > 0) return 1;
  if (merged.totals.crapViolations > 0) return 1;
  return 0;
}

/**
 * Render the per-file delta table. Columns:
 *   "file", "MI delta", "worst CRAP delta", "new-method count over c=<flag>".
 *
 * The last header used to hardcode `c=8`, which quietly lied to any consumer
 * that had tuned `codingGuardrails.cyclomaticFlag`. It now names the value the
 * count was actually taken against, read off the merge result — through the
 * same `normalizeFlag` the merge itself uses, rather than the second, hand-
 * inlined copy of that coercion this function used to carry.
 *
 * Pure — accepts pre-computed merge rows and returns a multi-line string. The
 * table renders even on a clean diff so operators see the "no drift" signal.
 *
 * @param {{ rows: Array<{ file: string, miDrop: number, worstCrapDelta: number, newOverCeilingMethods: number }>, totals: { miRegressions: number, crapViolations: number }, cyclomaticFlag?: number }} merged
 * @returns {string}
 */
/**
 * The table's body: one row per regressed file, or the single placeholder
 * line that keeps the "no drift" signal visible on a clean diff.
 *
 * Split out of `renderTable` so that function keeps a flat shape — the
 * empty-vs-populated branch and the row loop together carried it above the
 * per-method CRAP contract the pre-push preview enforces.
 *
 * @param {Array<{ file: string, miDrop: number, worstCrapDelta: number, newOverCeilingMethods: number }>} rows
 * @returns {string[]}
 */
function tableBodyLines(rows) {
  if (rows.length === 0) return ['| _(no per-file regressions)_ | — | — | — |'];
  return rows.map(
    (row) =>
      `| ${row.file} | -${row.miDrop.toFixed(2)} | +${row.worstCrapDelta.toFixed(2)} | ${row.newOverCeilingMethods} |`,
  );
}

export function renderTable(merged) {
  const flag = normalizeFlag(merged?.cyclomaticFlag);
  const header = [
    'file',
    'MI delta',
    'worst CRAP delta',
    `new-method count over c=${flag}`,
  ];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...tableBodyLines(merged.rows),
    '',
    `Totals: MI regressions=${merged.totals.miRegressions} · CRAP violations=${merged.totals.crapViolations}`,
  ].join('\n');
}

/**
 * Resolve `codingGuardrails.cyclomaticFlag` for the tree at `cwd`
 * (Story #4923), falling back to the framework default when the config cannot
 * be resolved at all.
 *
 * Best-effort by design: `quality:preview` is a developer-facing report, and a
 * run in a tree with no readable `.agentrc.json` should still render its table
 * rather than abort. Extracted from `runCli` rather than inlined so the CLI
 * body stays under the cyclomatic must-fix ceiling this same Story starts
 * enforcing — a gate whose own delivery breaches it is not a gate.
 *
 * @param {{ cwd: string, stderr: { write: (s: string) => void } }} args
 * @returns {number}
 */
function resolveCyclomaticFlag({ cwd, stderr }) {
  try {
    return resolveCyclomaticPolicy(getQuality(resolveConfig({ cwd }))).flag;
  } catch (err) {
    stderr.write(
      `[quality:preview] config resolution failed, using cyclomaticFlag=${DEFAULT_CYCLOMATIC_FLAG}: ${err?.message ?? err}\n`,
    );
    return DEFAULT_CYCLOMATIC_FLAG;
  }
}

/**
 * Invoke one preview runner, degrading a thrown failure into the same
 * `{ exitCode: 1, envelope: null }` shape a real gate failure produces.
 *
 * Both runners degraded identically before, in two hand-copied `catch`
 * arms; folding them into one helper removes the copy and keeps `runCli` a
 * pipeline rather than a pair of inlined error handlers. The emitted message
 * is byte-identical to the arm it replaces — `label` supplies the `MI` /
 * `CRAP` prefix.
 *
 * @param {(args: object) => Promise<{exitCode: number, envelope: object|null}>} runner
 * @param {{cwd: string, staged: boolean, changedSinceRef: string|null}} args
 * @param {'MI'|'CRAP'} label
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<{exitCode: number, envelope: object|null}>}
 */
function runGateSafely(runner, args, label, stderr) {
  return runner(args).catch((err) => {
    stderr.write(
      `[quality:preview] ${label} runner failed: ${err?.message ?? err}\n`,
    );
    return { exitCode: 1, envelope: null };
  });
}

/**
 * Render the scope header line.
 *
 * Story #5131 — when `--staged` runs during a merge the scope is re-based to
 * `MERGE_HEAD`, and the header says so. Without that line the operator sees a
 * table whose row count does not match `git diff --cached` with no way to tell
 * the narrowing was deliberate.
 *
 * The merge state is resolved here rather than read back off a gate envelope's
 * `summary.diffRef`: that field means "the ref this scope was resolved
 * against" for every scope kind, so anything that populates it — a future
 * scope mode, a test stub — would render a merge banner over a repo that is
 * not merging. Resolving it after the `!staged` early return also keeps the
 * probe off the `--changed-since` path, which has no use for it.
 *
 * @param {{ staged: boolean, ref: string|null, cwd: string }} args
 * @returns {string}
 */
function stagedScopeLine({ staged, ref, cwd }) {
  if (!staged) return `scope=diff ref=${ref}\n\n`;
  const mergeHead = resolveMergeHead({ cwd });
  if (!mergeHead) return 'scope=staged (git diff --cached)\n\n';
  return (
    `scope=staged (git diff --cached ${mergeHead.slice(0, 12)}) — merge in ` +
    "progress: scored against MERGE_HEAD, not HEAD, so the base branch's " +
    'incoming files are excluded\n\n'
  );
}

/**
 * Write the run's report — the `--json` envelope, or the human-readable
 * table plus any gate diagnostics and the non-zero-exit summary.
 *
 * Split out of `runCli` (Story #5109): the rendering half carried five of
 * that function's decision points, which put it over the per-method CRAP
 * contract the pre-push preview enforces. Output bytes are unchanged in both
 * modes. The exit code stays with the caller — this function only reports.
 *
 * @param {{
 *   json: boolean,
 *   staged: boolean,
 *   ref: string|null,
 *   cwd: string,
 *   miResult: {exitCode: number, envelope: object|null},
 *   crapResult: {exitCode: number, envelope: object|null},
 *   merged: ReturnType<typeof mergeEnvelopes>,
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 * }} args
 * @returns {void}
 */
function emitReport({
  json,
  staged,
  ref,
  cwd,
  miResult,
  crapResult,
  merged,
  stdout,
  stderr,
}) {
  const miExit = miResult.exitCode;
  const crapExit = crapResult.exitCode;
  if (json) {
    stdout.write(
      `${JSON.stringify(
        {
          ref: staged ? null : ref,
          staged,
          mi: { exit: miExit, envelope: miResult.envelope },
          crap: { exit: crapExit, envelope: crapResult.envelope },
          merged,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  stdout.write('\n--- quality:preview ---\n');
  stdout.write(stagedScopeLine({ staged, ref, cwd }));
  stdout.write(`${renderTable(merged)}\n`);
  const advisories = renderAdvisories(merged.advisories);
  if (advisories) stdout.write(`\n${advisories}\n`);
  const diagnostics = renderDiagnostics([miResult, crapResult]);
  if (diagnostics) stdout.write(`\n${diagnostics}\n`);
  if (miExit !== 0 || crapExit !== 0) {
    stderr.write(
      `\n[quality:preview] gate exits: mi=${miExit} crap=${crapExit}\n`,
    );
  }
}

/**
 * Top-level CLI entry: invoke both per-kind preview runners, merge, render,
 * and exit with the right code. Exposed as `runCli` so tests can drive the
 * full pipeline through injected runner stubs.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   runMi?: typeof runMaintainabilityPreview,
 *   runCrap?: typeof runCrapPreview,
 * }} [opts]
 * @returns {Promise<{ exitCode: number, merged: ReturnType<typeof mergeEnvelopes> }>}
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  runMi = runMaintainabilityPreview,
  runCrap = runCrapPreview,
} = {}) {
  const json = parseJsonFlag(argv);
  const staged = parseStagedFlag(argv);
  const ref = staged ? null : (parseChangedSinceArg(argv) ?? 'HEAD');

  // Story #5109 — the two gates run **one after the other**, not under a
  // `Promise.all`. Each scores its batch with its own `runOnPool` budget
  // sized to `os.availableParallelism()`, so overlapping them oversubscribed
  // the host by 2x and stacked two escomplex heaps: a 58-file preview peaked
  // at 1.0-1.2 GB RSS for 3.9 s of CPU. Serialising them bounds the preview
  // to one `availableParallelism` of workers and one heap at a time. The two
  // runners share no state and neither reads the other's envelope, so the
  // emitted envelopes — and therefore the merged table and the exit code —
  // are identical either way; only the peak cost differs.
  //
  // Each runner gets its own options literal rather than one shared object,
  // so serialising them cannot introduce a coupling the concurrent form
  // did not have.
  const miResult = await runGateSafely(
    runMi,
    { cwd, staged, changedSinceRef: ref },
    'MI',
    stderr,
  );
  const crapResult = await runGateSafely(
    runCrap,
    { cwd, staged, changedSinceRef: ref },
    'CRAP',
    stderr,
  );

  // Story #4923 — the over-ceiling column counts against the *resolved*
  // `codingGuardrails.cyclomaticFlag`, not the literal that used to be written
  // into `mergeEnvelopes` and the column header.
  const cyclomaticFlag = resolveCyclomaticFlag({ cwd, stderr });
  const merged = mergeEnvelopes(miResult.envelope, crapResult.envelope, {
    cyclomaticFlag,
  });

  emitReport({
    json,
    staged,
    ref,
    cwd,
    miResult,
    crapResult,
    merged,
    stdout,
    stderr,
  });

  return {
    exitCode: computeExitCode(merged, miResult.exitCode, crapResult.exitCode),
    merged,
  };
}

// cli-opt-out: Windows-aware main-guard with leading-slash drive-letter normalisation; mirrors quality-watch.js so the diagnostic surface stays consistent across the gate suite.
// Only run main when invoked directly — keep the module importable from tests.
const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = new URL(import.meta.url).pathname;
    const normalizedSelf = /^\/[A-Za-z]:/.test(self) ? self.slice(1) : self;
    return path.resolve(normalizedSelf) === invoked;
  } catch {
    return false;
  }
})();

if (isDirect && !respondToHelp(process.argv.slice(2), USAGE)) {
  runCli().then(({ exitCode }) => {
    process.exit(exitCode);
  });
}
