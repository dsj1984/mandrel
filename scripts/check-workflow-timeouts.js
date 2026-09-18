/**
 * CLI: GitHub Actions job-timeout gate.
 *
 * Story #4936. Every job in this repository inherited GitHub's 360-minute
 * default because not one of the four workflow files set `timeout-minutes`.
 * That is not a theoretical cost: a deadlocked `Windows Smoke` job burned 44
 * minutes of a `windows-latest` runner, and — because the run stayed
 * `in_progress` — GitHub withheld the logs of the *required* check that had
 * already failed on the same run, so the real merge blocker could not be
 * diagnosed until the run was cancelled by hand. An unbounded job costs
 * runner time and diagnosability at once.
 *
 * A ceiling only helps if it is bounded on both ends, so this gate fails on
 * two shapes:
 *
 *   - a job with no `timeout-minutes` at all (unbounded, 360-minute default);
 *   - a job whose `timeout-minutes` exceeds `MAX_TIMEOUT_MINUTES`, i.e. a
 *     number generous enough to be useless as a deadlock detector.
 *
 * `MIN_TIMEOUT_MINUTES` is the floor a value must clear to be plausible
 * headroom over a job that takes a couple of minutes today; below it, a
 * transient slow runner reds the build for no defect.
 *
 * Contract:
 *   - Scans the workflows directory (default `.github/workflows`, override
 *     with `--dir <path>`), parsing each `*.yml` / `*.yaml` with js-yaml and
 *     enumerating every `jobs.<id>` key.
 *   - Prints `<file> job <id> — <reason>` per violation, then a one-line
 *     summary even on a clean scan so the "ok" signal is visible in CI.
 *   - With `--json`: writes a structured envelope to stdout and skips the
 *     human summary.
 *   - Exit codes: 0 = every job bounded in range; 1 = at least one violation.
 *     A missing / empty workflows directory exits 0 (nothing to gate).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';

/**
 * Inclusive bounds every job's `timeout-minutes` must sit within.
 *
 * The ceiling is the load-bearing half — it is what turns a deadlock into a
 * bounded loss instead of a six-hour one. The floor keeps a well-meaning
 * `timeout-minutes: 2` from reddening the build on a slow runner.
 */
export const MIN_TIMEOUT_MINUTES = 10;
export const MAX_TIMEOUT_MINUTES = 30;

/**
 * Enumerate workflow files (`*.yml` / `*.yaml`) directly under `dir`.
 * Returns absolute paths sorted for deterministic output. A missing directory
 * yields an empty list.
 *
 * @param {string} dir Absolute workflows directory.
 * @param {typeof fs} [fsLike]
 * @returns {string[]}
 */
export function listWorkflowFiles(dir, fsLike = fs) {
  let entries;
  try {
    entries = fsLike.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Read the `jobs` mapping out of one workflow document.
 *
 * The single parse point for both the violation scan and the job count, so
 * the two can never disagree about what a workflow's job set is.
 *
 * @param {string} text The file contents.
 * @param {(s: string) => unknown} parse YAML parser; injected in tests.
 * @returns {{ jobs: Record<string, unknown> | null, error: Error | null }}
 */
function readJobs(text, parse) {
  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    return { jobs: null, error: err };
  }
  const jobs = doc && typeof doc === 'object' ? doc.jobs : null;
  return {
    jobs: jobs && typeof jobs === 'object' ? jobs : null,
    error: null,
  };
}

/**
 * Judge one job body's `timeout-minutes`, returning the violation shape or
 * `null` when the job is bounded in range.
 *
 * Reusable-workflow calls (`jobs.<id>.uses:`) are exempt: `timeout-minutes`
 * is not a valid key on a job that delegates to another workflow — the
 * callee's own jobs carry their timeouts, and setting one here is a schema
 * error rather than a fix.
 *
 * @param {unknown} body The `jobs.<id>` value.
 * @returns {{ timeout: number | null, reason: string } | null}
 */
function judgeJobTimeout(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.uses === 'string') return null;

  const timeout = body['timeout-minutes'];
  if (timeout === undefined || timeout === null) {
    return {
      timeout: null,
      reason: `no timeout-minutes — the job inherits GitHub's 360-minute default`,
    };
  }
  if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
    return {
      timeout: null,
      reason: `timeout-minutes is not a number (${JSON.stringify(timeout)})`,
    };
  }
  if (timeout > MAX_TIMEOUT_MINUTES) {
    return {
      timeout,
      reason: `timeout-minutes ${timeout} exceeds the ${MAX_TIMEOUT_MINUTES}-minute ceiling`,
    };
  }
  if (timeout < MIN_TIMEOUT_MINUTES) {
    return {
      timeout,
      reason: `timeout-minutes ${timeout} is below the ${MIN_TIMEOUT_MINUTES}-minute floor`,
    };
  }
  return null;
}

/**
 * Pure helper: enumerate every `jobs.<id>` key in one workflow document and
 * return the violations.
 *
 * An unparseable document is itself a violation: a workflow whose jobs cannot
 * be enumerated cannot be certified as bounded, and failing open would let
 * the very drift this gate exists to catch through.
 *
 * @param {string} file Relative file label used in violation rows.
 * @param {string} text The file contents.
 * @param {(s: string) => unknown} [parse] YAML parser; injected in tests.
 * @returns {Array<{ file: string, job: string, timeout: number | null, reason: string }>}
 */
export function scanWorkflowText(file, text, parse = yaml.load) {
  const { jobs, error } = readJobs(text, parse);
  if (error) {
    return [
      {
        file,
        job: '(document)',
        timeout: null,
        reason: `workflow could not be parsed as YAML: ${error.message}`,
      },
    ];
  }
  if (!jobs) return [];

  const violations = [];
  for (const [job, body] of Object.entries(jobs)) {
    const verdict = judgeJobTimeout(body);
    if (verdict) violations.push({ file, job, ...verdict });
  }
  return violations;
}

/**
 * Pure helper: render the human-readable report. One line per violation
 * followed by a one-line summary carrying a `(gate fail)` / `(ok)` marker.
 *
 * @param {Array<{ file: string, job: string, timeout: number | null, reason: string }>} violations
 * @param {number} jobsScanned
 * @returns {string}
 */
export function renderReport(violations, jobsScanned) {
  const lines = violations.map((v) => `${v.file} job ${v.job} — ${v.reason}`);
  const tag = violations.length > 0 ? '(gate fail)' : '(ok)';
  lines.push(
    `[workflow-timeouts] jobs=${jobsScanned} violations=${violations.length} ${tag}`,
  );
  return lines.join('\n');
}

/**
 * Count every `jobs.<id>` key in a parsed workflow document, including the
 * reusable-workflow calls the violation scan exempts — the summary reports
 * how many jobs were enumerated, not how many were eligible.
 *
 * @param {string} text
 * @param {(s: string) => unknown} [parse]
 * @returns {number}
 */
export function countJobs(text, parse = yaml.load) {
  const { jobs } = readJobs(text, parse);
  return jobs ? Object.keys(jobs).length : 0;
}

/**
 * Top-level CLI entry. Exported so tests can drive the full pipeline against
 * a fixture workflows directory without touching the repo's real workflows.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} exit code: 0 = every job bounded; 1 = violation
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const dirIdx = argv.indexOf('--dir');
  const dir =
    dirIdx !== -1 && argv[dirIdx + 1] && !argv[dirIdx + 1].startsWith('--')
      ? argv[dirIdx + 1]
      : null;
  const json = argv.includes('--json');
  const resolvedDir = path.resolve(
    cwd,
    dir ?? path.join('.github', 'workflows'),
  );

  const files = listWorkflowFiles(resolvedDir);
  const violations = [];
  let jobsScanned = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const label = path.relative(cwd, file);
    jobsScanned += countJobs(text);
    violations.push(...scanWorkflowText(label, text));
  }

  const exitCode = violations.length > 0 ? 1 : 0;

  if (json) {
    stdout.write(
      `${JSON.stringify(
        {
          kind: 'workflow-timeouts-report',
          dir: resolvedDir,
          filesScanned: files.length,
          jobsScanned,
          minTimeoutMinutes: MIN_TIMEOUT_MINUTES,
          maxTimeoutMinutes: MAX_TIMEOUT_MINUTES,
          violations,
          exitCode,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (files.length === 0) {
      stderr.write(
        `[workflow-timeouts] ⚠ no workflow files found under ${resolvedDir}\n`,
      );
    }
    stdout.write(`${renderReport(violations, jobsScanned)}\n`);
  }

  return exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'workflow-timeouts',
  propagateExitCode: true,
  errorPrefix: '[workflow-timeouts] ❌ Fatal error',
});
