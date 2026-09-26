#!/usr/bin/env node
/**
 * quality-preview.js — per-file MI/CRAP delta preview; exits non-zero on any
 * violation. The pre-commit hook passes only `--staged`. During a merge,
 * `--staged` reads the index against `MERGE_HEAD` so a base-sync commit is
 * scored for the branch's own work, not everything the base landed.
 */

import path from 'node:path';
import process from 'node:process';
import {
  runCrapPreview,
  runMaintainabilityPreview,
} from './lib/baselines/preview-gates.js';
import { resolveMergeHead } from './lib/changed-files.js';
import { respondToHelp } from './lib/cli-usage.js';
import { CODING_GUARDRAILS } from './lib/config/quality.js';

const USAGE = {
  invocation:
    'node .agents/scripts/quality-preview.js [--staged | --changed-since <ref>] [--only mi|crap] [--json]',
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
    [
      '--only mi|crap',
      'Run one half only — maintainability (`mi`) or CRAP (`crap`); the other half is reported as not run. Default: both, serially.',
    ],
    ['--json', 'Emit both gate envelopes plus the merged table as JSON.'],
  ],
};

const DEFAULT_CYCLOMATIC_FLAG = CODING_GUARDRAILS.cyclomaticFlag;

/**
 * `--changed-since <ref>` (bare flag → `HEAD`, absent → `null`). Last
 * occurrence wins so `npm run <alias> -- --changed-since <base>` overrides a
 * flag baked into the npm script.
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
 * @param {string[]} argv
 * @returns {boolean}
 */
export function parseJsonFlag(argv) {
  return argv.includes('--json');
}

/**
 * `--staged` scores only index paths and takes precedence over
 * `--changed-since`.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function parseStagedFlag(argv) {
  return argv.includes('--staged');
}

/** The halves `--only` can select. */
const PREVIEW_HALVES = new Set(['mi', 'crap']);

/**
 * `--only <half>` (last occurrence wins); `null` runs both halves. A value
 * outside {@link PREVIEW_HALVES} is returned as-is for the caller to refuse.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
function parseOnlyArg(argv) {
  const at = argv.lastIndexOf('--only');
  return at === -1 ? null : (argv[at + 1] ?? '');
}

/**
 * @param {string|null} only
 * @returns {boolean}
 */
function isUnknownHalf(only) {
  return only !== null && !PREVIEW_HALVES.has(only);
}

/**
 * Run `half` unless `--only` selected the other one.
 *
 * @param {{ only: string|null, half: 'mi'|'crap', run: () => Promise<{exitCode: number, envelope: object|null}> }} opts
 * @returns {Promise<{exitCode: number, envelope: object|null}>}
 */
function runHalf({ only, half, run }) {
  return only === null || only === half ? run() : Promise.resolve(NOT_RUN);
}

/**
 * The `--json` field naming the selected half; empty for the default run so
 * its envelope stays byte-identical.
 *
 * @param {string|null} only
 * @returns {{ only?: string }}
 */
function onlyField(only) {
  return only ? { only } : {};
}

/**
 * The report line naming the selected half; empty for the default run.
 *
 * @param {string|null} only
 * @returns {string}
 */
function halfLine(only) {
  return only ? `half=${only} only — the other half was not run\n` : '';
}

/**
 * `--staged` wins; otherwise `--changed-since` (absent → `HEAD`).
 *
 * @param {string[]} argv
 * @param {boolean} staged
 * @returns {string|null}
 */
function resolveRef(argv, staged) {
  return staged ? null : (parseChangedSinceArg(argv) ?? 'HEAD');
}

/** A half `--only` left out: clean, with no envelope to merge. */
const NOT_RUN = Object.freeze({ exitCode: 0, envelope: null });

/**
 * Run the selected halves serially, not via Promise.all: each runner sizes its
 * own pool to availableParallelism, so overlapping them oversubscribes 2x and
 * stacks two escomplex heaps (>1 GB RSS).
 *
 * @param {{ only: string|null, args: object, runMi: Function, runCrap: Function, stderr: { write: (s: string) => void } }} opts
 * @returns {Promise<{ miResult: {exitCode: number, envelope: object|null}, crapResult: {exitCode: number, envelope: object|null} }>}
 */
async function runHalves({ only, args, runMi, runCrap, stderr }) {
  const miResult = await runHalf({
    only,
    half: 'mi',
    run: () => runGateSafely(runMi, args, 'MI', stderr),
  });
  const crapResult = await runHalf({
    only,
    half: 'crap',
    run: () => runGateSafely(runCrap, args, 'CRAP', stderr),
  });
  return { miResult, crapResult };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeFlag(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : DEFAULT_CYCLOMATIC_FLAG;
}

/**
 * Fold one CRAP violation into its per-file row (mutates `row`).
 *
 * @param {{ worstCrapDelta: number, newOverCeilingMethods: number }} row
 * @param {{ crap?: number, ceiling?: number, baseline?: number, cyclomatic?: number, kind?: string }} v
 * @param {number} flag
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
 * Merge MI and CRAP envelopes into per-file rows: `miDrop` (higher = worse),
 * `worstCrapDelta` (vs baseline, or vs ceiling for new methods), and
 * `newOverCeilingMethods` (new methods with cyclomatic above the flag).
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
    // Advisories ride the merge but never the exit code.
    advisories: advisoriesOf(crapEnvelope),
  };
}

/**
 * @param {{ cyclomaticAdvisories?: unknown } | null | undefined} crapEnvelope
 * @returns {Array<{ file: string, method: string, startLine: number, cyclomatic: number }>}
 */
function advisoriesOf(crapEnvelope) {
  const list = crapEnvelope?.cyclomaticAdvisories;
  return Array.isArray(list) ? list : [];
}

/**
 * @param {Array<object>} advisories
 * @param {{ write: (s: string) => void }} stdout
 * @returns {void}
 */
function writeAdvisories(advisories, stdout) {
  const block = renderAdvisories(advisories);
  if (block) stdout.write(`\n${block}\n`);
}

/**
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
 * Gate diagnostics (emitted instead of verdicts when none would be
 * meaningful). Surfaced verbatim: the gate exits 0, so silence reads as clean.
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
 * 1 on any gate failure or violation (a gate failure counts even with no rows);
 * advisories never affect it.
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
 * Placeholder row on a clean diff keeps the "no drift" signal visible.
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

/**
 * @param {{ rows: Array<{ file: string, miDrop: number, worstCrapDelta: number, newOverCeilingMethods: number }>, totals: { miRegressions: number, crapViolations: number }, cyclomaticFlag?: number }} merged
 * @returns {string}
 */
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
 * A thrown runner degrades to the `{ exitCode: 1, envelope: null }` shape.
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
 * Scope header; names a `MERGE_HEAD` re-base so the narrowed row count reads as
 * deliberate. Merge state is probed here, not read off an envelope's `diffRef`
 * (which every scope kind populates).
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
 * Write the `--json` envelope or the table + diagnostics; reports only.
 *
 * @param {{
 *   json: boolean,
 *   only: string|null,
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
  only,
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
          ...onlyField(only),
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
  stdout.write(halfLine(only));
  stdout.write(stagedScopeLine({ staged, ref, cwd }));
  stdout.write(`${renderTable(merged)}\n`);
  writeAdvisories(merged.advisories, stdout);
  const diagnostics = renderDiagnostics([miResult, crapResult]);
  if (diagnostics) stdout.write(`\n${diagnostics}\n`);
  if (miExit !== 0 || crapExit !== 0) {
    stderr.write(
      `\n[quality:preview] gate exits: mi=${miExit} crap=${crapExit}\n`,
    );
  }
}

/**
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
  const ref = resolveRef(argv, staged);
  const only = parseOnlyArg(argv);
  if (isUnknownHalf(only)) {
    stderr.write(
      `[quality:preview] --only takes mi or crap (got "${only}").\n`,
    );
    return { exitCode: 2, merged: mergeEnvelopes(null, null) };
  }

  const { miResult, crapResult } = await runHalves({
    only,
    args: { cwd, staged, changedSinceRef: ref },
    runMi,
    runCrap,
    stderr,
  });

  const merged = mergeEnvelopes(miResult.envelope, crapResult.envelope, {
    cyclomaticFlag: DEFAULT_CYCLOMATIC_FLAG,
  });

  emitReport({
    json,
    only,
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
