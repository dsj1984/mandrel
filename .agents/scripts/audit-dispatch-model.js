#!/usr/bin/env node
/**
 * audit-dispatch-model.js — post-run observability for the workflow
 * `dispatchModel` → `Agent(model:)` convention (Story #2590, AC #4).
 *
 * The convention is parent-LLM enforced: when a workflow declares
 * `dispatchModel: <hint>` in its frontmatter, the parent agent is
 * supposed to pass `model: <hint>` on every `Agent` tool call it fans
 * out from inside that workflow. There is no runtime injection — the
 * convention only holds if the parent reads the frontmatter and honours
 * it.
 *
 * This script answers "did the convention hold for this Story?" from
 * artifacts a finished run leaves behind:
 *
 *   - `tool-trace-hook.js` writes one trace line per tool call to
 *     `temp/epic-<eid>/story-<sid>/traces.ndjson`. For `tool === 'Agent'`
 *     calls the hook records `details.model` — either the literal model
 *     string the parent emitted, or `null` if the parent forgot.
 *   - This analyzer walks that ledger, tallies Agent calls by emitted
 *     `model` value, and reports the convention coverage.
 *
 * Usage:
 *
 *   node .agents/scripts/audit-dispatch-model.js --epic 1185 --story 2590
 *
 *   # Standalone Story (no Epic): the orchestrator writes traces under
 *   # epic-0 by convention — pass `--epic 0` to read those.
 *   node .agents/scripts/audit-dispatch-model.js --epic 0 --story 2590
 *
 * Exits 0 with the report on stdout. Missing trace file is not a
 * failure — the script reports `missing: true` and exits 0 (a Story may
 * legitimately fan out zero Agent calls).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsCli } from './lib/cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_MODELS = new Set(['haiku', 'sonnet', 'opus']);

function parseArgs(argv) {
  const args = { epic: null, story: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--epic') {
      args.epic = Number.parseInt(argv[++i], 10);
    } else if (a === '--story') {
      args.story = Number.parseInt(argv[++i], 10);
    } else if (a === '--json') {
      args.json = true;
    }
  }
  return args;
}

/**
 * Walk a `traces.ndjson` file and return a summary of Agent calls.
 *
 * @param {string} tracePath
 * @returns {{ agentCalls: number, withModel: number, withoutModel: number, byModel: Record<string, number>, unexpectedValues: string[], missing: boolean }}
 */
export function summarizeTraces(tracePath) {
  const summary = {
    agentCalls: 0,
    withModel: 0,
    withoutModel: 0,
    byModel: { haiku: 0, sonnet: 0, opus: 0 },
    unexpectedValues: [],
    missing: false,
  };

  if (!fs.existsSync(tracePath)) {
    summary.missing = true;
    return summary;
  }

  const raw = fs.readFileSync(tracePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.kind !== 'trace') continue;
    if (parsed?.source?.tool !== 'Agent') continue;

    summary.agentCalls += 1;
    const model = parsed?.details?.model;
    if (typeof model !== 'string') {
      summary.withoutModel += 1;
      continue;
    }
    summary.withModel += 1;
    if (ALLOWED_MODELS.has(model)) {
      summary.byModel[model] += 1;
    } else {
      summary.unexpectedValues.push(model);
    }
  }
  return summary;
}

function formatHuman(summary, { epic, story, tracePath }) {
  const lines = [];
  lines.push(`audit-dispatch-model: epic=${epic} story=${story}`);
  lines.push(`  traces: ${tracePath}`);
  if (summary.missing) {
    lines.push('  status: no traces file (Story emitted zero tool calls?)');
    return lines.join('\n');
  }
  lines.push(`  Agent calls: ${summary.agentCalls}`);
  lines.push(`  with model:  ${summary.withModel}`);
  lines.push(`  no model:    ${summary.withoutModel}`);
  if (summary.withModel > 0) {
    const parts = Object.entries(summary.byModel)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    if (parts) lines.push(`  by model:    ${parts}`);
  }
  if (summary.unexpectedValues.length > 0) {
    const uniq = [...new Set(summary.unexpectedValues)].join(', ');
    lines.push(`  unexpected:  ${uniq}`);
  }
  const coverage =
    summary.agentCalls === 0
      ? 'n/a'
      : `${Math.round((summary.withModel / summary.agentCalls) * 100)}%`;
  lines.push(`  coverage:    ${coverage}`);
  return lines.join('\n');
}

function resolveTracePath(epic, story) {
  // Mirror `temp-paths.js` layout without importing it — keeps this
  // script's dependency surface tiny.
  const repoRoot = path.resolve(__dirname, '..', '..');
  return path.join(
    repoRoot,
    'temp',
    `epic-${epic}`,
    `story-${story}`,
    'traces.ndjson',
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.epic) || args.epic < 0) {
    process.stderr.write('--epic <non-negative integer> is required\n');
    process.exit(2);
  }
  if (!Number.isInteger(args.story) || args.story <= 0) {
    process.stderr.write('--story <positive integer> is required\n');
    process.exit(2);
  }
  const tracePath = resolveTracePath(args.epic, args.story);
  const summary = summarizeTraces(tracePath);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ epic: args.epic, story: args.story, tracePath, ...summary }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${formatHuman(summary, { epic: args.epic, story: args.story, tracePath })}\n`,
    );
  }
}

runAsCli(import.meta.url, async () => main(), {
  source: 'audit-dispatch-model',
});
