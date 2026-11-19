#!/usr/bin/env node

/**
 * The one place a session title is built. Workflows cite it with an event and
 * apply the printed title through the host (runbooks/session-titles.md); they
 * never compose a title inline.
 *
 * Exit codes: 0 a title (or `apply: false` when disabled), 2 a usage error.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { getDeliveryRouting } from './lib/config/delivery-routing.js';
import { resolveConfig } from './lib/config-resolver.js';

const MAX_TITLE = 48;

/** event → glyph, fixed verb, and the one input it takes (null: none). */
const EVENTS = Object.freeze({
  'plan-seed': { glyph: '○', verb: '', input: 'summary' },
  'plan-ticket': { glyph: '○', verb: 'Planning', input: 'ids' },
  planned: { glyph: '○', verb: 'Planned', input: 'ids' },
  deliver: { glyph: '◐', verb: 'Delivery', input: 'ids' },
  'deliver-prompt': { glyph: '◐', verb: '', input: 'summary' },
  delivered: { glyph: '●', verb: 'Delivered', input: 'ids' },
  blocked: { glyph: '⊗', verb: 'Blocked', input: 'ids' },
  orchestrate: { glyph: '◐', verb: 'Orchestrating', input: null },
  audit: { glyph: '◐', verb: 'Audit', input: 'lens' },
  audited: { glyph: '●', verb: 'Audit', input: 'lens' },
  qa: { glyph: '◐', verb: 'QA', input: 'summary' },
  'qa-done': { glyph: '●', verb: 'QA', input: 'summary' },
});

const INPUTS = ['ids', 'summary', 'lens'];

const HELP = `Usage: node .agents/scripts/session-title.js --event <name> [--ids <id,id,...> | --summary "<text>" | --lens <name>] [--json]

Builds the host session title for a workflow event and prints one JSON object:
{"title": "<string>", "apply": true}, or {"title": null, "apply": false,
"reason": "disabled"} when delivery.routing.sessionTitles is false. How a
title is applied: .agents/docs/runbooks/session-titles.md.

Events (input → title):
${Object.entries(EVENTS)
  .map(
    ([name, { glyph, verb, input }]) =>
      `  ${name.padEnd(15)}${(input ? `--${input}` : '(none)').padEnd(11)}${[glyph, verb, input && `<${input}>`].filter(Boolean).join(' ')}`,
  )
  .join('\n')}

Flags:
  --event    The workflow event (required).
  --ids      Comma-separated ids; a leading # is dropped.
  --summary  Free text; control characters stripped, whitespace collapsed.
  --lens     The audit lens name.
  --json     Accepted for symmetry; output is always JSON.
  --help     Show this message.
`;

class UsageError extends Error {}

/**
 * @param {string} raw
 * @returns {string}
 */
function formatIds(raw) {
  const ids = raw
    .split(',')
    .map((id) => id.trim().replace(/^#/, ''))
    .filter((id) => id !== '');
  if (ids.length === 0) throw new UsageError('--ids needs at least one id');
  const bad = ids.find((id) => !/^\d+$/.test(id));
  if (bad !== undefined) throw new UsageError(`non-numeric id: ${bad}`);
  if (ids.length <= 3) return ids.map((id) => `#${id}`).join(' ');
  const nums = ids.map(Number);
  return `#${Math.min(...nums)}–#${Math.max(...nums)} (${ids.length})`;
}

/**
 * @param {string} raw
 * @param {string} flag
 * @returns {string}
 */
function cleanText(raw, flag) {
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/ +/g, ' ')
    .trim();
  if (text === '') throw new UsageError(`--${flag} is empty`);
  return text;
}

/**
 * Cap the title at MAX_TITLE characters, cutting only the free text.
 *
 * @param {string} prefix glyph plus fixed verb
 * @param {string} text
 * @returns {string}
 */
function fit(prefix, text) {
  if (!text) return prefix;
  const head = `${prefix} `;
  const budget = MAX_TITLE - [...head].length;
  const chars = [...text];
  if (chars.length <= budget) return head + text;
  return `${head}${chars
    .slice(0, budget - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * @param {{ event?: string, ids?: string, summary?: string, lens?: string }} values
 * @returns {string}
 */
function buildTitle(values) {
  const spec = EVENTS[values.event];
  if (!spec) {
    throw new UsageError(
      values.event ? `unknown event: ${values.event}` : '--event is required',
    );
  }
  const given = INPUTS.filter((name) => values[name] !== undefined);
  const expected = spec.input ? [spec.input] : [];
  if (given.join() !== expected.join()) {
    throw new UsageError(
      `${values.event} takes ${spec.input ? `--${spec.input}` : 'no input'}`,
    );
  }
  const prefix = [spec.glyph, spec.verb].filter(Boolean).join(' ');
  if (!spec.input) return prefix;
  const raw = values[spec.input];
  const text =
    spec.input === 'ids' ? formatIds(raw) : cleanText(raw, spec.input);
  return fit(prefix, text);
}

/**
 * @param {{ argv?: string[] }} [args]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   stdout?: { write: (s: string) => unknown },
 *   stderr?: { write: (s: string) => unknown },
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function runSessionTitle(
  { argv = process.argv.slice(2) } = {},
  {
    resolveConfigImpl = resolveConfig,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  let title;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        event: { type: 'string' },
        ids: { type: 'string' },
        summary: { type: 'string' },
        lens: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    title = buildTitle(values);
  } catch (err) {
    stderr.write(`[session-title] ${err.message}\n\n${HELP}`);
    return 2;
  }
  const enabled = getDeliveryRouting(resolveConfigImpl()).sessionTitles;
  const result = enabled
    ? { title, apply: true }
    : { title: null, apply: false, reason: 'disabled' };
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

runAsCli(import.meta.url, () => runSessionTitle(), {
  source: 'session-title',
  usage: HELP,
  propagateExitCode: true,
});
