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
 * Story #1394 (Epic #1386) flipped the default scope of both gates to
 * diff-against-`main`, so passing `--changed-since HEAD` here mirrors what the
 * pre-commit hook actually wants: the delta the operator is about to commit.
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
 *     scoring above the `c=8` ceiling (matches the column header
 *     "new-method count over c=8" in the AC). The CRAP envelope's
 *     `cyclomatic` field is the per-method `c` reading.
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
 * @returns {{
 *   rows: Array<{
 *     file: string,
 *     miDrop: number,
 *     worstCrapDelta: number,
 *     newOverCeilingMethods: number,
 *   }>,
 *   totals: { miRegressions: number, crapViolations: number },
 * }}
 */
export function mergeEnvelopes(miEnvelope, crapEnvelope) {
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
    const row = ensure(v.file);
    const crap = Number(v.crap ?? 0);
    if (v.kind === 'new') {
      const ceiling = Number(v.ceiling ?? 0);
      const delta = crap - ceiling;
      if (Number.isFinite(delta) && delta > row.worstCrapDelta) {
        row.worstCrapDelta = delta;
      }
      const cyclomatic = Number(v.cyclomatic ?? 0);
      if (Number.isFinite(cyclomatic) && cyclomatic > 8) {
        row.newOverCeilingMethods += 1;
      }
    } else {
      const baseline = Number(v.baseline ?? 0);
      const delta = crap - baseline;
      if (Number.isFinite(delta) && delta > row.worstCrapDelta) {
        row.worstCrapDelta = delta;
      }
    }
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
  };
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
 * Render the per-file delta table. Header columns match the AC verbatim:
 *   "file", "MI delta", "worst CRAP delta", "new-method count over c=8".
 *
 * Pure — accepts pre-computed merge rows and returns a multi-line string. The
 * table renders even on a clean diff so operators see the "no drift" signal.
 *
 * @param {{ rows: Array<{ file: string, miDrop: number, worstCrapDelta: number, newOverCeilingMethods: number }>, totals: { miRegressions: number, crapViolations: number } }} merged
 * @returns {string}
 */
export function renderTable(merged) {
  const header = [
    'file',
    'MI delta',
    'worst CRAP delta',
    'new-method count over c=8',
  ];
  const lines = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  if (merged.rows.length === 0) {
    lines.push('| _(no per-file regressions)_ | — | — | — |');
  } else {
    for (const row of merged.rows) {
      lines.push(
        `| ${row.file} | -${row.miDrop.toFixed(2)} | +${row.worstCrapDelta.toFixed(2)} | ${row.newOverCeilingMethods} |`,
      );
    }
  }
  lines.push('');
  lines.push(
    `Totals: MI regressions=${merged.totals.miRegressions} · CRAP violations=${merged.totals.crapViolations}`,
  );
  return lines.join('\n');
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

  const [miResult, crapResult] = await Promise.all([
    runMi({ cwd, staged, changedSinceRef: ref }).catch((err) => {
      stderr.write(
        `[quality:preview] MI runner failed: ${err?.message ?? err}\n`,
      );
      return { exitCode: 1, envelope: null };
    }),
    runCrap({ cwd, staged, changedSinceRef: ref }).catch((err) => {
      stderr.write(
        `[quality:preview] CRAP runner failed: ${err?.message ?? err}\n`,
      );
      return { exitCode: 1, envelope: null };
    }),
  ]);
  const miExit = miResult.exitCode;
  const crapExit = crapResult.exitCode;
  const miEnvelope = miResult.envelope;
  const crapEnvelope = crapResult.envelope;
  const merged = mergeEnvelopes(miEnvelope, crapEnvelope);

  if (json) {
    stdout.write(
      `${JSON.stringify(
        {
          ref: staged ? null : ref,
          staged,
          mi: { exit: miExit, envelope: miEnvelope },
          crap: { exit: crapExit, envelope: crapEnvelope },
          merged,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    stdout.write('\n--- quality:preview ---\n');
    stdout.write(
      staged
        ? 'scope=staged (git diff --cached)\n\n'
        : `scope=diff ref=${ref}\n\n`,
    );
    stdout.write(`${renderTable(merged)}\n`);
    if (miExit !== 0 || crapExit !== 0) {
      stderr.write(
        `\n[quality:preview] gate exits: mi=${miExit} crap=${crapExit}\n`,
      );
    }
  }

  return { exitCode: computeExitCode(merged, miExit, crapExit), merged };
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

if (isDirect) {
  runCli().then(({ exitCode }) => {
    process.exit(exitCode);
  });
}
