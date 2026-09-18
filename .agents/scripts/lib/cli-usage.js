/**
 * The one `--help` implementation for top-level scripts, so a flag contract
 * lives with its code, not in workflow prose.
 *
 * `--help`/`-h` is a query: non-empty stdout, exit 0, no side effects.
 * stdout (not `Logger`) so it survives `AGENT_LOG_LEVEL=silent`. `runAsCli`
 * short-circuits before `main`, so "no side effects" holds structurally.
 *
 * ## Usage
 *
 *   runAsCli(import.meta.url, main, {
 *     source: 'my-script',
 *     usage: {
 *       invocation: 'node .agents/scripts/my-script.js --story <id> [--json]',
 *       summary: 'One line on what the script does.',
 *       flags: [
 *         ['--story <id>', 'GitHub issue number of the Story (required).'],
 *         ['--json', 'Emit the envelope as JSON instead of prose.'],
 *       ],
 *     },
 *   });
 *
 * A pre-rendered string is accepted too, so a script that already shipped a
 * hand-written `HELP` block adopts the shared gate without its observable
 * text changing (`usage: HELP`).
 */

/** Tokens that request help. */
export const HELP_FLAGS = Object.freeze(['--help', '-h']);

/** Left column width for the flag table; longer flags wrap to their own line. */
const FLAG_COLUMN = 22;

/**
 * Did the caller ask for help? Scans up to the `--` end-of-flags separator so
 * a positional literally named `--help` after `--` is not mistaken for a
 * request.
 *
 * @param {string[]} argv Argument vector without the node/script entries.
 * @returns {boolean}
 */
export function wantsHelp(argv = []) {
  if (!Array.isArray(argv)) return false;
  for (const token of argv) {
    if (token === '--') return false;
    if (HELP_FLAGS.includes(token)) return true;
  }
  return false;
}

/**
 * Normalize one flag entry into `{ flag, description }`. Accepts a
 * `[flag, description]` pair or an object, so call sites can use whichever
 * reads better next to their option table.
 *
 * @param {[string, string]|{flag: string, description?: string}} entry
 * @returns {{ flag: string, description: string }}
 */
function normalizeFlag(entry) {
  if (Array.isArray(entry)) {
    return {
      flag: String(entry[0] ?? ''),
      description: String(entry[1] ?? ''),
    };
  }
  return {
    flag: String(entry?.flag ?? ''),
    description: String(entry?.description ?? ''),
  };
}

/**
 * Render one `  --flag   description` row, wrapping onto a second line when
 * the flag itself is wider than the column.
 *
 * @param {{ flag: string, description: string }} row
 * @returns {string}
 */
function renderFlagRow({ flag, description }) {
  if (!description) return `  ${flag}`;
  if (flag.length >= FLAG_COLUMN) {
    return `  ${flag}\n  ${' '.repeat(FLAG_COLUMN)}${description}`;
  }
  return `  ${flag.padEnd(FLAG_COLUMN)}${description}`;
}

/**
 * Append the `--help` row unless the spec already documents it, so every
 * rendered block is self-describing without each call site repeating it.
 *
 * @param {Array<{ flag: string, description: string }>} rows
 * @returns {Array<{ flag: string, description: string }>}
 */
function withHelpRow(rows) {
  const documented = rows.some((r) => r.flag.split(/[\s,]/)[0] === '--help');
  if (documented) return rows;
  return [...rows, { flag: '--help', description: 'Show this message.' }];
}

/**
 * Render a usage spec into the text `--help` prints.
 *
 * @param {{
 *   invocation: string,
 *   summary?: string,
 *   flags?: Array<[string, string]|{flag: string, description?: string}>,
 *   notes?: string[],
 * }} spec
 * @returns {string} Text block, newline-terminated.
 */
export function formatUsage(spec) {
  const rows = withHelpRow((spec?.flags ?? []).map(normalizeFlag));
  const blocks = [`Usage: ${spec?.invocation ?? ''}`.trim()];
  if (spec?.summary) blocks.push(spec.summary);
  blocks.push(['Flags:', ...rows.map(renderFlagRow)].join('\n'));
  for (const note of spec?.notes ?? []) blocks.push(note);
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Coerce either accepted `usage` shape — a spec object or a pre-rendered
 * string — into the text to print.
 *
 * @param {object|string} usage
 * @returns {string}
 */
export function renderUsage(usage) {
  if (typeof usage === 'string') {
    return usage.endsWith('\n') ? usage : `${usage}\n`;
  }
  return formatUsage(usage);
}

/**
 * Answer a help request. Returns `true` when help was requested (and printed),
 * `false` when the caller should carry on with its normal path.
 *
 * Never throws on a missing/blank `usage`: a script whose spec renders empty
 * still owes the contract non-empty stdout, so a minimal line is emitted
 * rather than a silent exit that reads as a broken CLI.
 *
 * @param {string[]} argv
 * @param {object|string} usage
 * @param {{ write: (s: string) => void }} [out] Defaults to `process.stdout`.
 * @returns {boolean}
 */
export function respondToHelp(argv, usage, out = process.stdout) {
  if (!wantsHelp(argv)) return false;
  const text = renderUsage(usage ?? '');
  out.write(text.trim().length > 0 ? text : 'Usage: (no flags documented)\n');
  return true;
}
