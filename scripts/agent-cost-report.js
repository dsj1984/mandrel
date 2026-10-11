#!/usr/bin/env node

/**
 * Agent cost report (Story #5607): per-session and per-subagent effort,
 * model, tokens and wall time, read from the transcripts Claude Code already
 * writes under `~/.claude/projects/<slug>/`. Mandrel has no per-spawn cost
 * telemetry of its own; this gives delegation-layer changes a measured
 * before/after. Writes `report.json` (rows + summary) and `summary.md` under
 * `temp/agent-cost/` (gitignored). Dev tooling only — not shipped.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import { readProjectDir } from './lib/agent-cost/read-transcripts.js';
import {
  filterRows,
  parseBound,
  renderSummaryMarkdown,
  summarize,
} from './lib/agent-cost/summarize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORKTREE_SEGMENT = `${path.sep}.worktrees${path.sep}`;

/**
 * The main checkout's root: a Story worktree lives at
 * `<main>/.worktrees/story-<id>/`, and Claude Code keys transcripts by the
 * directory a session started in, which is the main checkout.
 *
 * @param {string} root
 * @returns {string}
 */
export function mainCheckoutOf(root) {
  const at = root.indexOf(WORKTREE_SEGMENT);
  return at === -1 ? root : root.slice(0, at);
}

/**
 * Claude Code's projects dir for a checkout: its absolute path with every
 * `/` and `.` replaced by `-`.
 *
 * @param {string} checkoutRoot
 * @param {string} homeDir
 * @returns {string}
 */
export function defaultProjectDir(checkoutRoot, homeDir) {
  const slug = checkoutRoot.replace(/[\\/.:]/g, '-');
  return path.join(homeDir, '.claude', 'projects', slug);
}

/**
 * @param {string[]} argv
 */
function parseReportArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'project-dir': { type: 'string', multiple: true },
      since: { type: 'string' },
      until: { type: 'string' },
      'agent-type': { type: 'string' },
      skill: { type: 'string' },
      'out-dir': { type: 'string' },
    },
    strict: true,
  });
  return values;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {string} [opts.root]     checkout the default dirs derive from
 * @param {string} [opts.homeDir]
 * @param {typeof fs} [opts.fs]
 * @param {{ write: (s: string) => unknown }} [opts.stdout]
 * @param {{ write: (s: string) => unknown }} [opts.stderr]
 * @returns {{ exitCode: number, reportPath?: string, summaryPath?: string }}
 */
export function runAgentCostReport({
  argv = process.argv.slice(2),
  root = ROOT,
  homeDir = os.homedir(),
  fs: fsLike = fs,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const values = parseReportArgv(argv);
  const projectDirs = (
    values['project-dir'] ?? [defaultProjectDir(mainCheckoutOf(root), homeDir)]
  ).map((dir) => path.resolve(dir));
  const missing = projectDirs.find((dir) => !fsLike.existsSync(dir));
  if (missing) {
    stderr.write(`[agent-cost-report] project dir not found: ${missing}\n`);
    return { exitCode: 1 };
  }

  const sinceMs = parseBound(values.since, 'since');
  const untilMs = parseBound(values.until, 'until');
  let rows = [];
  let skippedLines = 0;
  for (const dir of projectDirs) {
    const read = readProjectDir(dir, { fs: fsLike, sinceMs });
    rows = rows.concat(read.rows);
    skippedLines += read.skippedLines;
  }
  rows = filterRows(rows, {
    sinceMs,
    untilMs,
    agentType: values['agent-type'],
    skill: values.skill,
  });

  const filters = {
    since: values.since,
    until: values.until,
    agentType: values['agent-type'],
    skill: values.skill,
  };
  const summary = summarize(rows);
  const outDir = path.resolve(
    values['out-dir'] ?? path.join(root, 'temp', 'agent-cost'),
  );
  fsLike.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'report.json');
  const summaryPath = path.join(outDir, 'summary.md');
  fsLike.writeFileSync(
    reportPath,
    `${JSON.stringify({ projectDirs, filters, skippedLines, summary, rows }, null, 2)}\n`,
    'utf8',
  );
  fsLike.writeFileSync(
    summaryPath,
    renderSummaryMarkdown(summary, { projectDirs, filters, skippedLines }),
    'utf8',
  );
  stdout.write(`${summaryPath}\n`);
  return { exitCode: 0, reportPath, summaryPath };
}

runAsCli(import.meta.url, async () => runAgentCostReport().exitCode, {
  source: 'agent-cost-report',
  propagateExitCode: true,
  usage: {
    invocation:
      'node scripts/agent-cost-report.js [--project-dir <dir>]... [--since <ISO date>] [--until <ISO date>] [--agent-type <t>] [--skill <s>] [--out-dir <dir>]',
    summary:
      'Per-session and per-subagent effort, model, tokens and wall time from Claude Code transcripts; writes report.json and summary.md.',
    flags: [
      [
        '--project-dir <dir>',
        'Claude Code projects dir to read (repeatable). Default: ~/.claude/projects/<main-checkout slug>.',
      ],
      ['--since <ISO date>', 'Keep rows that started at or after this time.'],
      [
        '--until <ISO date>',
        'Keep rows that started at or before this time (a bare date covers the whole day).',
      ],
      [
        '--agent-type <t>',
        'Keep rows of this agentType (main, story-worker, …).',
      ],
      ['--skill <s>', 'Keep rows whose most frequent attributionSkill is <s>.'],
      ['--out-dir <dir>', 'Output directory. Default: temp/agent-cost/.'],
    ],
  },
});
