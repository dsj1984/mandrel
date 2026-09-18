#!/usr/bin/env node

/**
 * update-dead-exports-baseline.js — the producer behind the dead-export
 * ratchet (Story #5011).
 *
 * `check-dead-exports.js` has shipped since Story #1852 with no way to write
 * the baseline it ratchets against. Every seed and every refresh was therefore
 * a hand-edit: run the checker with `--json`, copy `currentRows` out of the
 * report, re-sort them, and preserve `$schema` / `kernelVersion` / `mode` by
 * hand. That is the gap this CLI closes — dead-exports now sits beside its four
 * `update-*-baseline.js` siblings instead of being the one baseline an operator
 * had to author in a text editor.
 *
 * **Fail closed, unlike the checker.** `check-dead-exports.js` treats a knip
 * spawn or parse failure as advisory (exit 0 + a stderr warning) because it
 * still holds a committed snapshot to compare against — a broken knip install
 * must not redden CI on its own. The producer has no such fallback: the file it
 * is about to write *is* the snapshot. An empty row set persisted from a failed
 * run would silently grandfather every dead export in the repository and blind
 * the ratchet permanently. So this CLI exits non-zero and writes **nothing**
 * whenever knip cannot run, its report cannot be parsed, or the knip version
 * cannot be resolved. That asymmetry with the checker is deliberate.
 *
 * **Envelope, not the shared writer.** Dead-exports does not route through
 * `lib/baselines/writer.js`: that writer admits only the kinds registered in
 * `lib/baselines/envelope.js` and requires a `*` rollup row, while dead-exports
 * is an out-of-band ratchet kind (`lib/audit-baselines/kinds.js`) that carries
 * no rollup. This CLI writes exactly the shape the checker already reads and
 * both committed baselines already carry:
 *
 *   { $schema, kernelVersion, generatedAt, [mode], rows: [{ file, symbol }] }
 *
 * `kernelVersion` is knip's own installed version — knip is the scorer, so a
 * knip upgrade is what invalidates the rows. `mode` is stamped on the
 * `--production` pass only, matching the committed production baseline.
 *
 * Rows are de-duplicated and sorted by `(file, symbol)` with the same
 * comparator `check-dead-exports.js` uses for its diff output, so a re-run
 * against an unchanged tree differs only in `generatedAt` and review sees real
 * movement rather than reordering noise.
 *
 * The pass is selected with `--production`, and the baseline/label/mode triple
 * comes from `lib/dead-exports-mode.js` — the same resolver the checker uses.
 * Resolving that pairing independently here is precisely how a producer would
 * end up writing production rows over the default baseline.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import {
  extractRowsFromKnip,
  readKnipOutput,
  runKnip,
} from '../.agents/scripts/lib/dead-exports-knip.js';
import { resolveDeadExportsMode } from '../.agents/scripts/lib/dead-exports-mode.js';

/** `$schema` ref stamped into every dead-export baseline envelope. */
export const DEAD_EXPORTS_SCHEMA_REF =
  'https://mandrel.dev/baselines/dead-exports.schema.json';

/**
 * Parse argv for `--production`, `--baseline <path>` and `--knip-output
 * <path>`. `--knip-output` is the test seam: it feeds a pre-captured knip JSON
 * report instead of spawning knip, and mirrors the checker's flag of the same
 * name so a captured report drives both sides of the ratchet.
 *
 * @param {string[]} argv
 * @returns {{ baselinePath: string | null, knipOutputPath: string | null, production: boolean }}
 */
export function parseArgv(argv = []) {
  const out = { baselinePath: null, knipOutputPath: null, production: false };
  const valueFlags = {
    '--baseline': 'baselinePath',
    '--knip-output': 'knipOutputPath',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--production') {
      out.production = true;
      continue;
    }
    const field = valueFlags[arg];
    const next = argv[i + 1];
    if (field && next && !next.startsWith('--')) {
      out[field] = next;
      i += 1;
    }
  }
  return out;
}

/**
 * Resolve the knip version to stamp as `kernelVersion`, read from the
 * installed package rather than recalled. Returns `null` when knip is not
 * installed or its manifest is unreadable — the caller treats that as a
 * fail-closed condition, because an unstamped baseline cannot signal to a
 * later run that the scorer moved underneath it.
 *
 * @param {{ cwd?: string, readFileImpl?: typeof fs.readFileSync }} [opts]
 * @returns {string | null}
 */
export function resolveKnipKernelVersion({
  cwd = process.cwd(),
  readFileImpl = fs.readFileSync,
} = {}) {
  try {
    const manifest = path.resolve(cwd, 'node_modules', 'knip', 'package.json');
    const version = JSON.parse(readFileImpl(manifest, 'utf-8'))?.version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * De-duplicate and sort `{ file, symbol }` rows into the committed order.
 *
 * Identity is `(file, symbol)` — the same identity `diffRows` in
 * `check-dead-exports.js` uses — so two knip issue records naming the same
 * dead file collapse to one row. The comparator is that checker's comparator,
 * which is why re-sorting an already-committed baseline is a no-op.
 *
 * @param {Array<{ file?: unknown, symbol?: unknown }>} rows
 * @returns {Array<{ file: string, symbol: string }>}
 */
export function normalizeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows ?? []) {
    if (typeof row?.file !== 'string' || typeof row?.symbol !== 'string')
      continue;
    const key = `${row.file}\0${row.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: row.file, symbol: row.symbol });
  }
  return out.sort(
    (a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
  );
}

/**
 * Assemble the baseline envelope. `mode` is stamped on the production pass
 * only: the default baseline has never carried the key, and adding it would
 * churn the committed file for no signal.
 *
 * @param {{ kernelVersion: string, mode: string, rows: Array<object>, generatedAt: string }} args
 * @returns {object}
 */
export function buildEnvelope({ kernelVersion, mode, rows, generatedAt }) {
  const envelope = {
    $schema: DEAD_EXPORTS_SCHEMA_REF,
    kernelVersion,
    generatedAt,
  };
  if (mode === 'production') envelope.mode = mode;
  envelope.rows = rows;
  return envelope;
}

/**
 * Obtain a knip report, either from the `--knip-output` seam or by spawning
 * knip for the requested pass. Never throws; a failure is reported as
 * `{ ok: false, error }` so the caller can fail closed without a try/catch.
 *
 * @param {{
 *   cwd: string,
 *   production: boolean,
 *   knipOutputPath: string | null,
 *   runKnipImpl: typeof runKnip,
 *   readKnipOutputImpl: typeof readKnipOutput,
 * }} args
 * @returns {{ ok: true, envelope: unknown } | { ok: false, error: string }}
 */
export function collectKnipReport({
  cwd,
  production,
  knipOutputPath,
  runKnipImpl,
  readKnipOutputImpl,
}) {
  if (knipOutputPath) {
    const envelope = readKnipOutputImpl(path.resolve(cwd, knipOutputPath));
    return envelope == null
      ? { ok: false, error: `could not read knip report at ${knipOutputPath}` }
      : { ok: true, envelope };
  }
  return runKnipImpl({ cwd, production });
}

/**
 * Reject a report the extractor cannot read. `extractRowsFromKnip` is total —
 * it answers `[]` for any shape it does not recognise — which is the right
 * posture for an advisory checker and the wrong one for a producer: an
 * unrecognised report and a genuinely clean repository would persist the same
 * empty row set. Returns an error string, or `null` when the report is usable.
 *
 * @param {unknown} envelope
 * @returns {string | null}
 */
export function describeUnusableReport(envelope) {
  if (!envelope || typeof envelope !== 'object')
    return 'knip report is not a JSON object';
  if (!Array.isArray(envelope.issues))
    return 'knip report carries no `issues` array';
  return null;
}

/**
 * Top-level CLI entry, exported so tests drive the whole pipeline through
 * injected hooks without spawning knip or touching a committed baseline.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   runKnipImpl?: typeof runKnip,
 *   readKnipOutputImpl?: typeof readKnipOutput,
 *   readFileImpl?: typeof fs.readFileSync,
 *   writeFileImpl?: typeof fs.writeFileSync,
 *   renameImpl?: typeof fs.renameSync,
 *   now?: () => string,
 * }} [opts]
 * @returns {Promise<number>} 0 on a written baseline; 1 on any fail-closed path.
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  runKnipImpl = runKnip,
  readKnipOutputImpl = readKnipOutput,
  readFileImpl = fs.readFileSync,
  writeFileImpl = fs.writeFileSync,
  renameImpl = fs.renameSync,
  now = () => new Date().toISOString(),
} = {}) {
  const { baselinePath, knipOutputPath, production } = parseArgv(argv);
  const { mode, label, baseline } = resolveDeadExportsMode(production);
  const target = path.resolve(cwd, baselinePath ?? baseline);

  const kernelVersion = resolveKnipKernelVersion({ cwd, readFileImpl });
  if (!kernelVersion) {
    stderr.write(
      `[${label}] ❌ cannot resolve knip's version from node_modules/knip/package.json — refusing to write ${target}\n`,
    );
    return 1;
  }

  const report = collectKnipReport({
    cwd,
    production,
    knipOutputPath,
    runKnipImpl,
    readKnipOutputImpl,
  });
  const failure = report.ok
    ? describeUnusableReport(report.envelope)
    : report.error;
  if (failure) {
    stderr.write(
      `[${label}] ❌ ${failure} — refusing to write ${target} (an empty baseline would grandfather every dead export)\n`,
    );
    return 1;
  }

  const rows = normalizeRows(extractRowsFromKnip(report.envelope));
  const envelope = buildEnvelope({
    kernelVersion,
    mode,
    rows,
    generatedAt: now(),
  });
  // Write-then-rename, matching `lib/baselines/writer.js`: a crash or a full
  // disk mid-write must not leave a truncated envelope behind. An unparseable
  // baseline reads as empty to `check-dead-exports.js`, which would report
  // every pre-existing row as newly added.
  const tmpTarget = `${target}.tmp`;
  writeFileImpl(tmpTarget, `${JSON.stringify(envelope, null, 2)}\n`, 'utf-8');
  renameImpl(tmpTarget, target);
  stdout.write(
    `[${label}] ✅ wrote ${rows.length} row(s) to ${target} (kernelVersion=${kernelVersion}).\n`,
  );
  return 0;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'dead-exports-baseline',
  propagateExitCode: true,
  errorPrefix: '[dead-exports-baseline] ❌ Fatal error',
  usage: {
    invocation:
      'node scripts/update-dead-exports-baseline.js [--production] [--baseline <path>] [--knip-output <path>]',
    summary:
      'Scan → write one dead-export baseline. Regenerates the rows `check-dead-exports.js` ratchets against, so the snapshot is produced rather than hand-edited.',
    flags: [
      [
        '--production',
        'Write the production-pass baseline (baselines/dead-exports-production.json) instead of the default one.',
      ],
      ['--baseline <path>', 'Write to this path instead of the mode default.'],
      [
        '--knip-output <path>',
        'Read a saved knip JSON report instead of running knip.',
      ],
    ],
    notes: [
      'Fails closed: when knip cannot run or its report cannot be parsed, the CLI exits 1 and writes nothing — the checker is advisory on that failure, the producer must not be.',
      'There is no scope flag: knip scores the whole graph, so a diff-scoped refresh is not expressible. Run `npm run dead-exports:update` to refresh both passes.',
      'Exit codes:\n  0  baseline written\n  1  knip unavailable, unparseable, or version unresolvable',
    ],
  },
});
