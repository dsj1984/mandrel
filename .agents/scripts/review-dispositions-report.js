#!/usr/bin/env node

/**
 * review-dispositions-report.js — summarize the local review-dispositions
 * ledger: per provider and per severity, the count and rate of each
 * disposition, plus the precision and false-blocker proxies. Read-only;
 * exits 0 on an empty or absent ledger.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import {
  DISPOSITIONS,
  readDispositions,
  summarizeDispositions,
} from './lib/observability/review-dispositions.js';

const USAGE = {
  invocation:
    'node .agents/scripts/review-dispositions-report.js [--since <YYYY-MM-DD>] [--json]',
  summary:
    'Summarize the review-dispositions ledger (<tempRoot>/review-dispositions.ndjson): count and rate of each disposition per provider and per severity, with precision ((fixed-on-branch + open-at-merge) / all) and false-blocker ((overridden + refuted-by-verifier + downgraded-ungrounded) / criticals) proxies.',
  flags: [
    ['--since <YYYY-MM-DD>', 'Only records written on or after this date.'],
    ['--json', 'Emit the summary as JSON instead of a table.'],
  ],
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {number|null} r */
const pct = (r) => (r === null ? '-' : `${(r * 100).toFixed(1)}%`);

/** @param {string} label @param {Record<string, object>} groups */
function renderTable(label, groups) {
  const header = [label, 'total', ...DISPOSITIONS, 'precision', 'false-blk'];
  const rows = Object.entries(groups).map(([key, t]) => [
    key,
    String(t.total),
    ...DISPOSITIONS.map((d) => `${t.counts[d]} (${pct(t.rates[d])})`),
    pct(t.precision),
    pct(t.falseBlocker),
  ]);
  return alignRows([header, ...rows]).join('\n');
}

/** @param {string[][]} rows @returns {string[]} space-padded columns. */
function alignRows(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd(),
  );
}

/**
 * @param {string[]} [argv]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   stdout?: { write: (s: string) => void },
 *   cwd?: string,
 * }} [deps]
 * @returns {Promise<object|null>} the summary, or null when nothing recorded.
 */
export async function runReviewDispositionsReport(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    resolveConfigImpl = resolveConfig,
    stdout = process.stdout,
    cwd = process.cwd(),
  } = deps;
  const { values } = parseArgs({
    args: argv,
    options: { since: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (values.since !== undefined && !DATE.test(values.since)) {
    throw new Error(
      `review-dispositions-report: --since must be YYYY-MM-DD (got "${values.since}").`,
    );
  }
  const config = resolveConfigImpl({ cwd });
  const records = await readDispositions({
    config,
    since: values.since ?? null,
  });
  if (records.length === 0) {
    stdout.write('[review-dispositions-report] no dispositions recorded.\n');
    return null;
  }
  const summary = summarizeDispositions(records);
  if (values.json) {
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
  stdout.write(
    [
      renderTable('provider', summary.byProvider),
      '',
      renderTable('severity', summary.bySeverity),
      '',
      renderTable('all', { all: summary.overall }),
      '',
    ].join('\n'),
  );
  return summary;
}

async function main() {
  await runReviewDispositionsReport();
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'review-dispositions-report',
  propagateExitCode: true,
  errorPrefix: '[review-dispositions-report] ❌ Fatal error',
  usage: USAGE,
});
