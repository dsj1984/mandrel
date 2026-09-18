#!/usr/bin/env node

// scripts/check-baseline-scope.js — Story #5012.
//
// Assert that every committed baseline's ROW SET still describes the tree.
//
// `check-baselines.js` answers "did a measured value regress?" and answers it
// well. Nothing answered the prior question: does this baseline still measure
// the right files? A row can point at a file deleted months ago, and an
// in-scope file can carry no row at all, while every gate stays green — a
// ratchet is perfectly capable of being green over almost nothing.
//
// This gate is measurement-free by construction. It runs no scorer, needs no
// coverage artifact and no test run: it walks the directories the gate's own
// config names (`lib/baselines/scope-inventory.js`) and compares that set
// against the committed rows in both directions
// (`lib/baselines/scope-assert.js`). That is what makes it cheap enough to be
// a required check, and what makes its companion —
// `prune-baseline-orphans.js` — a one-command remedy rather than a full
// re-score.
//
// Exit codes:
//   0  no fatal divergence (inherited divergence may still be warned about)
//   1  fatal divergence — attributable to this change set, or strict mode
//   2  the check could not run (unreadable config, unusable repository)

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import '../.agents/scripts/lib/runtime-deps/ensure-installed.js';
import fs from 'node:fs';
import path from 'node:path';
import { _internals as readerInternals } from '../.agents/scripts/lib/baselines/reader.js';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import { getQuality } from '../.agents/scripts/lib/config/quality.js';
import { resolveConfig } from '../.agents/scripts/lib/config-resolver.js';
import { gitSpawn } from '../.agents/scripts/lib/git-utils.js';
import {
  assertScope,
  attributeDivergence,
  resolveStrictness,
} from './lib/baselines/scope-assert.js';
import {
  buildScopeInventory,
  SCOPE_KINDS,
} from './lib/baselines/scope-inventory.js';

const EXIT_PASS = 0;
const EXIT_DIVERGED = 1;
const EXIT_CANNOT_RUN = 2;

/**
 * Files whose edit makes merge-base attribution untrustworthy: once a branch
 * has rewritten the scope rules themselves, "which side of the merge-base
 * introduced this row" is no longer a question the diff can answer.
 */
const SCOPE_CONFIG_PATHS = Object.freeze([
  '.c8rc.cjs',
  '.agentrc.json',
  '.agentrc.local.json',
]);

const HELP = {
  invocation:
    'node scripts/check-baseline-scope.js [--kind <kind>] [--base <ref>] [--strict] [--json]',
  summary:
    "Assert each committed baseline's row set still describes the tree — in-scope files with no row, and rows whose file is gone or out of scope.",
  flags: [
    ['--kind <kind>', 'Check one kind only (repeatable). Default: all.'],
    ['--base <ref>', 'Attribution base ref. Default: origin/<baseBranch>.'],
    ['--strict', 'Treat every divergence as fatal, skipping attribution.'],
    ['--json', 'Emit the report as JSON instead of text.'],
    ['--cwd <dir>', 'Repository root to check. Default: process.cwd().'],
  ],
  notes: [
    'Exit codes:\n  0  no fatal divergence\n  1  fatal divergence\n  2  the check could not run',
    'Remedy for a stale row: node scripts/prune-baseline-orphans.js',
  ],
};

/**
 * Parse argv into an options bag. Unknown flags are a config error rather than
 * a silent no-op — a typo'd `--kinds` must not read as "check everything".
 *
 * @param {string[]} argv
 * @returns {{ kinds: string[], base: string | null, strict: boolean, json: boolean, cwd: string }}
 */
export function parseArgs(argv = []) {
  const out = { kinds: [], base: null, strict: false, json: false, cwd: null };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const value = argv[i + 1];
    i += 1;
    if (arg === '--strict') out.strict = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--kind') {
      out.kinds.push(value);
      i += 1;
    } else if (arg === '--base') {
      out.base = value;
      i += 1;
    } else if (arg === '--cwd') {
      out.cwd = value;
      i += 1;
    } else throw new Error(`unknown flag "${arg}" (try --help)`);
  }
  const unknown = out.kinds.filter((k) => !SCOPE_KINDS.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown --kind ${unknown.join(', ')}; expected one of ${SCOPE_KINDS.join(', ')}`,
    );
  }
  if (out.kinds.length === 0) out.kinds = [...SCOPE_KINDS];
  out.cwd = out.cwd ?? process.cwd();
  return out;
}

/**
 * Resolve the merge base between HEAD and the requested base ref, preferring
 * the remote-tracking ref so a stale local `main` cannot widen attribution.
 *
 * Returns `{ base: null }` when no candidate resolves — the strictness
 * resolver treats that as a reason to fail towards strict, never as a licence
 * to skip.
 *
 * @param {{ cwd: string, baseRef: string }} params
 * @returns {{ base: string | null, aheadOfBase: boolean }}
 */
function resolveMergeBase({ cwd, baseRef }) {
  for (const candidate of [`origin/${baseRef}`, baseRef]) {
    const merged = gitSpawn(cwd, 'merge-base', candidate, 'HEAD');
    if (merged.status !== 0 || merged.stdout.length === 0) continue;
    const head = gitSpawn(cwd, 'rev-parse', 'HEAD');
    return {
      base: merged.stdout,
      aheadOfBase: head.status === 0 && head.stdout !== merged.stdout,
    };
  }
  return { base: null, aheadOfBase: false };
}

/**
 * Enumerate what `<base>..HEAD` did to the tree, split into the two sets
 * attribution needs. A rename contributes its old path to `removed` and its
 * new path to `added`, which is exactly how a rename strands a row.
 *
 * @param {{ cwd: string, base: string | null }} params
 * @returns {{ added: string[], removed: string[], changed: string[] }}
 */
function readChangeSet({ cwd, base }) {
  const empty = { added: [], removed: [], changed: [] };
  if (base === null) return empty;
  const diff = gitSpawn(cwd, 'diff', '--name-status', '-M', `${base}..HEAD`);
  if (diff.status !== 0) return empty;
  const added = [];
  const removed = [];
  const changed = [];
  for (const line of diff.stdout.split('\n').filter(Boolean)) {
    const [code, first, second] = line.split('\t');
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      removed.push(first);
      added.push(second);
      changed.push(first, second);
      continue;
    }
    if (letter === 'A') added.push(first);
    if (letter === 'D') removed.push(first);
    changed.push(first);
  }
  return { added, removed, changed };
}

/**
 * Repo-relative paths of every baseline file in play — the "did this change
 * set edit a baseline?" input to the strictness resolver.
 *
 * @param {{ cwd: string, kinds: string[] }} params
 * @returns {string[]}
 */
function baselinePathsFor({ cwd, kinds }) {
  return kinds.map((kind) =>
    path
      .relative(cwd, readerInternals.resolveBaselinePath(kind, { cwd }))
      .split(path.sep)
      .join('/'),
  );
}

/**
 * Read a baseline's rows, or `null` when the kind ships no baseline in this
 * repository. Deliberately does NOT go through `reader.load`: an envelope too
 * stale to satisfy its schema is exactly the state this gate exists to report,
 * and refusing to read it would turn the report into a crash.
 *
 * @param {{ cwd: string, kind: string }} params
 * @returns {Array<object> | null}
 */
function readRows({ cwd, kind }) {
  const abs = readerInternals.resolveBaselinePath(kind, { cwd });
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return Array.isArray(parsed?.rows) ? parsed.rows : [];
  } catch {
    return null;
  }
}

/**
 * Assess one kind: inventory → both-directions assertion → attribution.
 *
 * @param {object} params
 * @returns {object} One entry of the report's `kinds` array.
 */
function assessKind({ kind, cwd, quality, strict, changeSet }) {
  const rows = readRows({ cwd, kind });
  if (rows === null) {
    return { kind, present: false, skipped: true, reason: 'no baseline file' };
  }
  const inventory = buildScopeInventory({ kind, cwd, quality });
  const found = assertScope({
    inventory,
    rows,
    existsOnDisk: (rel) => fs.existsSync(path.resolve(cwd, rel)),
  });
  if (found.skipped) return { kind, present: true, ...found };
  const attributed = attributeDivergence({
    missing: found.missing,
    extra: found.extra,
    added: changeSet.added,
    removed: changeSet.removed,
    strict,
  });
  return {
    kind,
    present: true,
    skipped: false,
    reason: null,
    inScopeCount: inventory.files.length,
    rowCount: rows.length,
    ...attributed,
  };
}

/**
 * Run the whole assessment and return a report plus its exit code.
 *
 * @param {{ argv?: string[] }} [params]
 * @returns {{ report: object, exitCode: number }}
 */
export function runScopeCheck({ argv = [] } = {}) {
  const opts = parseArgs(argv);
  const cwd = opts.cwd;
  const config = resolveConfig({ cwd });
  const quality = getQuality(config) ?? { gates: {} };
  const baseRef = opts.base ?? config?.project?.baseBranch ?? 'main';
  const { base, aheadOfBase } = resolveMergeBase({ cwd, baseRef });
  const changeSet = readChangeSet({ cwd, base });
  const strictness = opts.strict
    ? { strict: true, reason: 'operator requested --strict' }
    : resolveStrictness({
        base,
        aheadOfBase,
        changedFiles: changeSet.changed,
        baselinePaths: baselinePathsFor({ cwd, kinds: opts.kinds }),
        scopeConfigPaths: SCOPE_CONFIG_PATHS,
      });
  const kinds = opts.kinds.map((kind) =>
    assessKind({ kind, cwd, quality, strict: strictness.strict, changeSet }),
  );
  const fatalCount = kinds.reduce((sum, k) => sum + (k.fatalCount ?? 0), 0);
  const report = {
    schemaVersion: '1',
    base,
    strict: strictness.strict,
    strictReason: strictness.reason,
    fatalCount,
    warningCount: kinds.reduce((sum, k) => sum + (k.warningCount ?? 0), 0),
    kinds,
  };
  return { report, exitCode: fatalCount > 0 ? EXIT_DIVERGED : EXIT_PASS };
}

/**
 * Render one kind's findings as indented text lines.
 *
 * @param {object} entry
 * @returns {string[]}
 */
function renderKind(entry) {
  if (entry.skipped) return [`  - ${entry.kind}: skipped (${entry.reason})`];
  const head =
    `  - ${entry.kind}: ${entry.rowCount} row(s) over ${entry.inScopeCount} ` +
    `in-scope file(s) — ${entry.fatalCount} fatal, ${entry.warningCount} inherited`;
  const lines = [head];
  for (const file of entry.fatal.missing) {
    lines.push(`      ✗ missing row: ${file}`);
  }
  for (const row of entry.fatal.extra) {
    lines.push(`      ✗ stale row (${row.reason}): ${row.path}`);
  }
  return lines;
}

/**
 * Render the whole report as text.
 *
 * @param {object} report
 * @returns {string}
 */
export function formatReport(report) {
  const mode = report.strict ? 'strict' : 'attributed';
  const lines = [
    `[check-baseline-scope] ${report.fatalCount} fatal, ${report.warningCount} inherited ` +
      `(${mode}: ${report.strictReason})`,
    ...report.kinds.flatMap(renderKind),
  ];
  if (report.fatalCount > 0) {
    lines.push(
      '',
      'A baseline no longer describes the tree. Prune provably-inert rows with:',
      '  node scripts/prune-baseline-orphans.js',
      'A missing row means a file was added without being measured — run that',
      "kind's producer (npm run coverage:update / maintainability:update).",
    );
  }
  return lines.join('\n');
}

/**
 * CLI entry point. Returns its exit code rather than calling `process.exit()`,
 * so `runAsCli`'s `propagateExitCode` path settles it through `flushStdio` and
 * an unbounded report is not truncated at a pipe boundary (Story #4783).
 *
 * @returns {Promise<number>}
 */
async function main() {
  let result;
  try {
    result = runScopeCheck({ argv: process.argv.slice(2) });
  } catch (err) {
    const message = err?.message ?? String(err);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: '1', error: message }, null, 2)}\n`,
    );
    return EXIT_CANNOT_RUN;
  }
  const opts = { json: process.argv.includes('--json') };
  process.stdout.write(
    opts.json
      ? `${JSON.stringify(result.report, null, 2)}\n`
      : `${formatReport(result.report)}\n`,
  );
  return result.exitCode;
}

runAsCli(import.meta.url, main, {
  source: 'check-baseline-scope',
  usage: HELP,
  propagateExitCode: true,
});
