#!/usr/bin/env node
/**
 * .agents/scripts/quality-preview.js — Per-file MI/CRAP delta preview.
 *
 * Wraps `check-maintainability.js` and `check-crap.js` with `--changed-since
 * HEAD --json` and merges their structured envelopes into a single per-file
 * delta table contributors can read while the diff is still warm. Designed for
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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Parse `--changed-since <ref>` from argv. Defaults to `HEAD` when the flag is
 * present without a value. Returns `null` when the flag is absent so callers
 * can fall through to the gate scripts' own diff defaults.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
export function parseChangedSinceArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--changed-since') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
      return 'HEAD';
    }
  }
  return null;
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
 * Detect `--staged` (pre-commit mode). The flag is forwarded to the underlying
 * `check-maintainability.js` and `check-crap.js` calls so they only score
 * staged changes — used by `.husky/pre-commit` to scope the gate to the
 * about-to-be-committed delta rather than the working tree.
 *
 * The current gate scripts ignore `--staged` (they only support
 * `--changed-since <ref>`), but the flag is forwarded verbatim so that the
 * downstream scripts can grow the option without churn here.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function parseStagedFlag(argv) {
  return argv.includes('--staged');
}

/**
 * Merge an MI envelope (from `check-maintainability.js --json`) and a CRAP
 * envelope (from `check-crap.js --json`) into a per-file delta map. Pure —
 * no I/O, no spawn. Tests pin the math without booting the gates.
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
 * Read & JSON-parse a gate's `--json` envelope from disk. Returns `null`
 * when the file is missing (the gate exited before writing — usually a
 * runtime error) or unparseable.
 *
 * @param {string} filePath
 * @returns {unknown}
 */
function readEnvelope(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Spawn a single gate script with the requested CLI arguments and capture
 * its exit code. The gate's stdout is mirrored to this process's stderr so
 * operators see the underlying gate output even when `--json` is set.
 *
 * Exported as a hook for tests that want to short-circuit the spawn.
 *
 * @param {{ scriptPath: string, args: string[], cwd: string, spawn?: typeof spawnSync }} opts
 * @returns {number}
 */
export function runGate({ scriptPath, args, cwd, spawn = spawnSync }) {
  const result = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) {
    process.stderr.write(
      `[quality:preview] gate spawn failed: ${result.error.message}\n`,
    );
    return 1;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

/**
 * Top-level CLI entry: spawn both gates with `--json <tmp>` + `--changed-since
 * <ref>`, read the envelopes back, merge, render, and exit with the right
 * code. Exposed as `runCli` so tests can drive the full pipeline through an
 * injected spawn stub.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   spawn?: typeof spawnSync,
 *   tmpDir?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   scriptsDir?: string,
 * }} [opts]
 * @returns {{ exitCode: number, merged: ReturnType<typeof mergeEnvelopes> }}
 */
export function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  spawn = spawnSync,
  tmpDir,
  stdout = process.stdout,
  stderr = process.stderr,
  scriptsDir,
} = {}) {
  const ref = parseChangedSinceArg(argv) ?? 'HEAD';
  const json = parseJsonFlag(argv);
  const staged = parseStagedFlag(argv);
  const baseTmp =
    tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'quality-preview-'));
  fs.mkdirSync(baseTmp, { recursive: true });
  const miJson = path.join(baseTmp, 'mi.json');
  const crapJson = path.join(baseTmp, 'crap.json');

  const baseScripts = scriptsDir ?? path.resolve(cwd, '.agents', 'scripts');
  const miScript = path.join(baseScripts, 'check-maintainability.js');
  const crapScript = path.join(baseScripts, 'check-crap.js');

  const sharedArgs = ['--changed-since', ref];
  if (staged) sharedArgs.push('--staged');

  const miExit = runGate({
    scriptPath: miScript,
    args: [...sharedArgs, '--json', miJson],
    cwd,
    spawn,
  });
  const crapExit = runGate({
    scriptPath: crapScript,
    args: [...sharedArgs, '--json', crapJson],
    cwd,
    spawn,
  });

  const miEnvelope = readEnvelope(miJson);
  const crapEnvelope = readEnvelope(crapJson);
  const merged = mergeEnvelopes(miEnvelope, crapEnvelope);

  if (json) {
    stdout.write(
      `${JSON.stringify(
        {
          ref,
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
    stdout.write(`scope=diff ref=${ref}${staged ? ' (staged)' : ''}\n\n`);
    stdout.write(`${renderTable(merged)}\n`);
    if (miExit !== 0 || crapExit !== 0) {
      stderr.write(
        `\n[quality:preview] gate exits: mi=${miExit} crap=${crapExit}\n`,
      );
    }
  }

  return { exitCode: computeExitCode(merged, miExit, crapExit), merged };
}

// cli-opt-out: Windows-aware main-guard with leading-slash drive-letter normalisation; mirrors check-maintainability.js / check-crap.js so the diagnostic surface stays consistent across the gate suite.
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
  const { exitCode } = runCli();
  process.exit(exitCode);
}
