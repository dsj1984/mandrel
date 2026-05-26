#!/usr/bin/env node

/**
 * diagnose.js — `/diagnose` CLI runner.
 *
 * Thin reader over the checks registry (`lib/checks/index.js`). Assembles
 * state for the requested scope, runs every check declared on that scope
 * with `autoFix: false`, and renders the findings as either a fixed-width
 * table (default) or single-line JSON (`--json`).
 *
 * Distinct from `diagnose-friction.js`: that script wraps a shell command
 * with telemetry capture and writes per-Story friction signals; this one
 * is a stateless read of the registry, with no side effects beyond stdout
 * and an exit code.
 *
 * Usage:
 *   node .agents/scripts/diagnose.js [--scope <scope>] [--fail-on-blocker] [--json]
 *
 * Flags:
 *   --scope <s>          Filter checks by scope. Defaults to `diagnose`.
 *                        Pass `all` to run every registered check regardless
 *                        of scope. Any other value is forwarded to the
 *                        runner verbatim — checks whose `scope[]` includes
 *                        that string fire.
 *   --fail-on-blocker    Exit 2 when at least one finding has
 *                        severity === 'blocker'. Without this flag the
 *                        runner always exits 0 even if blockers are
 *                        present; `/diagnose` is by default an advisory
 *                        read.
 *   --json               Emit a single line of JSON to stdout shaped as
 *                        `{ scope, findings: [...] }`. Suppresses the
 *                        human table and any auxiliary log lines on
 *                        stdout. Errors still go to stderr.
 *
 * Exit codes:
 *   0  — no blockers, OR `--fail-on-blocker` not set.
 *   2  — `--fail-on-blocker` set AND at least one blocker finding.
 *   1  — internal error (registry load failure, etc.). The runner never
 *        crashes on a missing check directory — that returns the empty
 *        findings set with exit 0.
 */

import { runChecks } from './lib/checks/index.js';
import { assembleState } from './lib/checks/state.js';
import { parseStandardCliArgs } from './lib/cli/standard-args.js';
import { runAsCli } from './lib/cli-utils.js';

const DEFAULT_SCOPE = 'diagnose';

/**
 * Parse the CLI argv slice (i.e. argv without the leading node/script
 * elements). Exported for direct unit testing — keeps the parse pure so
 * tests can drive it without spawning a subprocess.
 *
 * @param {string[]} argv
 * @returns {{ scope: string, failOnBlocker: boolean, json: boolean }}
 */
export function parseArgs(argv) {
  // `--help` / `-h` and `--scope <value>` require diagnose-specific error
  // semantics ('HELP' sentinel for validateDiagnoseArgs; "requires a
  // value" message for missing value). Pre-scan for those before
  // delegating the rest to the shared parser.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') throw new Error('HELP');
    if (a === '--scope') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--scope requires a value');
      }
      // Skip the value token so the shared parser doesn't see a stray
      // positional, but leave it in `argv` for parseStandardCliArgs to
      // consume.
      i++;
    }
  }
  try {
    const { values } = parseStandardCliArgs({
      argv,
      extras: {
        scope: { type: 'string', default: DEFAULT_SCOPE },
        'fail-on-blocker': { type: 'boolean', alias: 'failOnBlocker' },
      },
    });
    return {
      scope: values.scope,
      failOnBlocker: values.failOnBlocker,
      json: values.json,
    };
  } catch (err) {
    if (err && err.code === 'UNKNOWN_FLAG') {
      // Preserve the legacy `unknown argument: --foo` phrasing so
      // operator-visible error text stays stable.
      throw new Error(`unknown argument: --${err.flag}`);
    }
    throw err;
  }
}

/**
 * Render a list of findings as a fixed-width plain-text table. The column
 * order is the same one the README documents and the tests pin:
 * `id`, `severity`, `scope`, `summary`, `fix command`.
 *
 * An empty findings list renders as a single-line `(no findings)` marker
 * underneath the column header, so the output shape is stable across the
 * clean-state and dirty-state cases — operators see the same columns
 * either way.
 *
 * @param {Array<import('./lib/checks/index.js').Finding>} findings
 * @returns {string}
 */
export function renderTable(findings) {
  const headers = ['id', 'severity', 'scope', 'summary', 'fix command'];
  const rows = findings.map((f) => [
    String(f.id ?? ''),
    String(f.severity ?? ''),
    String(f.scope ?? ''),
    String(f.summary ?? ''),
    String(f.fixCommand ?? ''),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const formatRow = (cells) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const lines = [formatRow(headers)];
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  if (rows.length === 0) {
    lines.push('(no findings)');
  } else {
    for (const r of rows) lines.push(formatRow(r));
  }
  return lines.join('\n');
}

/**
 * Programmatic entry point. Exported so tests can call it directly and
 * inspect the return shape without spawning a subprocess.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]   Defaults to `process.argv.slice(2)`.
 * @param {string} [opts.cwd]      Defaults to `process.cwd()`.
 * @param {(line: string) => void} [opts.stdout]
 *   Defaults to a `process.stdout.write` wrapper that appends a newline.
 * @param {Array<import('./lib/checks/index.js').Check>} [opts.registry]
 *   Optional pre-loaded registry — tests pass fixture checks. When omitted
 *   the runner discovers checks from the default `lib/checks/` directory.
 * @param {string} [opts.dir]      Override the discovery dir for the
 *   default registry path. Forwarded to `loadRegistry()`.
 * @returns {Promise<{ exitCode: number, findings: object[], scope: string }>}
 */
export async function runDiagnose({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = (line) => process.stdout.write(`${line}\n`),
  registry,
  dir,
} = {}) {
  const { scope, failOnBlocker, json } = parseArgs(argv);
  // `all` is an alias for "every scope" — the underlying runner treats an
  // undefined scope the same way. Mapping it here keeps the CLI surface
  // honest (operators reading --help see the word, not a JS quirk).
  const runnerScope = scope === 'all' ? undefined : scope;
  // assembleState's scope projection is keyed by the scope name. If the
  // operator passes an unknown scope the state assembler falls back to an
  // empty key list, which is fine — checks that needed env/git state will
  // simply report missing. We pass `diagnose` as a sensible default for
  // the `all` case so the broad-surface checks have their state available.
  const stateScope = runnerScope ?? DEFAULT_SCOPE;
  const state = assembleState({ scope: stateScope, cwd });
  const { findings } = await runChecks({
    scope: runnerScope,
    autoFix: false,
    state,
    registry,
    dir,
  });
  const hasBlocker = findings.some((f) => f.severity === 'blocker');
  const exitCode = failOnBlocker && hasBlocker ? 2 : 0;
  if (json) {
    stdout(JSON.stringify({ scope, findings }));
  } else {
    stdout(renderTable(findings));
  }
  return { exitCode, findings, scope };
}

/**
 * Classify a caught error from `runDiagnose` into a side-effect-free
 * response envelope. Returns one of:
 *
 *   - `{ kind: 'help', text }`  — user passed `--help` / `-h`.
 *   - `{ kind: 'error', text, exitCode }` — every other thrown shape.
 *
 * Extracted from `main` so the CLI's terminal branch (which `main`
 * exercises) stays straight-line and so the help-vs-error guard cascade
 * is testable without spawning the CLI or stubbing `process.exit`. The
 * caller owns the actual stdout/stderr write and exit.
 *
 * @param {unknown} err
 * @returns {{kind: 'help', text: string} | {kind: 'error', text: string, exitCode: number}}
 */
export function validateDiagnoseArgs(err) {
  if (err && err.message === 'HELP') {
    return {
      kind: 'help',
      text: [
        'Usage: diagnose [--scope <scope>] [--fail-on-blocker] [--json]',
        '',
        'Options:',
        '  --scope <s>         Filter checks by scope (default: diagnose).',
        '                      Use `all` to run every registered check.',
        '  --fail-on-blocker   Exit 2 when at least one finding is a blocker.',
        '  --json              Emit findings as a single line of JSON.',
        '',
      ].join('\n'),
    };
  }
  const message = err?.message ? err.message : String(err);
  return { kind: 'error', text: `[diagnose] ${message}\n`, exitCode: 1 };
}

async function main() {
  try {
    const { exitCode } = await runDiagnose();
    if (exitCode !== 0) process.exit(exitCode);
    return;
  } catch (err) {
    const response = validateDiagnoseArgs(err);
    if (response.kind === 'help') {
      process.stdout.write(response.text);
      return;
    }
    process.stderr.write(response.text);
    process.exit(response.exitCode);
  }
}

runAsCli(import.meta.url, main, { source: 'diagnose' });
