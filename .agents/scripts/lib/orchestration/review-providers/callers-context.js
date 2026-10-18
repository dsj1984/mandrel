/**
 * review-providers/callers-context.js — the out-of-diff caller context the
 * model bug review is handed at depth `deep`. A diff cannot show an untouched
 * caller broken by a renamed field or a changed signature, so this module
 * pulls the symbols a diff defines or removes and finds, by a word-boundary
 * `git grep` at the reviewed branch tip, the lines outside the changed files
 * that reference them.
 *
 * Deterministic and tool-free on purpose: the reviewer runs with no tools
 * from an empty temp dir, so its callers arrive as prompt text. Every cap
 * that drops context is reported back so the provider can record it as a
 * degradation — an unreviewed slice must never read as a reviewed one.
 */

import { normalizeDepth } from './review-depth.js';

/** Depths whose prompt carries the `<callers>` block; widen after a measured review-time check. */
const CALLER_CONTEXT_DEPTHS = Object.freeze(['deep']);
const CALLERS_INSTRUCTION =
  'The <callers> block lists lines outside the diff that reference symbols ' +
  'the diff changes; a caller the change breaks is a finding.';

const CALLER_CAPS = Object.freeze({
  maxSymbols: 20,
  maxLinesPerSymbol: 25,
  maxChars: 30_000,
});

const IDENT = '[A-Za-z_$][\\w$]*';
const DECLARATION_PATTERNS = Object.freeze([
  new RegExp(`\\bfunction\\s*\\*?\\s*(${IDENT})`, 'g'),
  new RegExp(`\\bclass\\s+(${IDENT})`, 'g'),
  new RegExp(`\\bexport\\s+(?:const|let|var)\\s+(${IDENT})`, 'g'),
]);
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const NEW_FILE_HEADER = /^\+\+\+ b\/(.+)$/;

/**
 * Exported names from an `export { A, B as C }` list body (`C`, not `B`).
 *
 * @param {string} list
 * @returns {string[]}
 */
function exportListNames(list) {
  const ident = new RegExp(`^${IDENT}$`);
  return list
    .split(',')
    .map(
      (entry) =>
        entry
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? '',
    )
    .filter((name) => ident.test(name) && name !== 'default');
}

/**
 * @param {string} line - a changed line with its `+`/`-` marker stripped.
 * @returns {string[]}
 */
function symbolsOnLine(line) {
  const out = [];
  for (const pattern of DECLARATION_PATTERNS) {
    for (const match of line.matchAll(pattern)) out.push(match[1]);
  }
  for (const match of line.matchAll(EXPORT_LIST)) {
    out.push(...exportListNames(match[1]));
  }
  return out;
}

/**
 * Walk the diff once: changed-line symbols (hunk bodies only, so the
 * `+++`/`---` headers never contribute) and the `+++ b/` file paths.
 *
 * @param {string} diff
 * @returns {{ found: Set<string>, files: string[] }}
 */
function scanDiff(diff) {
  const found = new Set();
  const files = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      const header = NEW_FILE_HEADER.exec(line);
      if (header && !files.includes(header[1])) files.push(header[1]);
      if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      for (const name of symbolsOnLine(line.slice(1))) found.add(name);
    }
  }
  return { found, files };
}

/**
 * Symbols the diff defines or removes, longest first (short names grep
 * noisily), capped at `maxSymbols`; the overflow is returned as `dropped`.
 *
 * @param {string} diff
 * @param {number} [maxSymbols]
 * @returns {{ symbols: string[], dropped: string[], files: string[] }}
 */
function extractChangedSymbols(diff, maxSymbols = CALLER_CAPS.maxSymbols) {
  const { found, files } = scanDiff(diff);
  const ranked = [...found].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  return {
    symbols: ranked.slice(0, maxSymbols),
    dropped: ranked.slice(maxSymbols),
    files,
  };
}

/**
 * The `git grep` argv for one symbol: fixed-string, word-boundary, at
 * `headRef`, with every changed file excluded from the pathspec.
 *
 * @param {string} symbol
 * @param {string} headRef
 * @param {string[]} files
 * @returns {string[]}
 */
function callerGrepArgs(symbol, headRef, files) {
  return [
    'grep',
    '-n',
    '-w',
    '-F',
    '-e',
    symbol,
    headRef,
    '--',
    '.',
    ...files.map((file) => `:(exclude)${file}`),
  ];
}

/**
 * `<headRef>:<path>:<line>:<text>` → `path:line: text`.
 *
 * @param {string} raw
 * @param {string} headRef
 * @returns {string|null}
 */
function formatHit(raw, headRef) {
  const prefix = `${headRef}:`;
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const match = /^(.*?):(\d+):(.*)$/.exec(rest);
  return match ? `${match[1]}:${match[2]}: ${match[3].trim()}` : null;
}

/**
 * @param {{ status: number, stdout: string }} result
 * @param {string} headRef
 * @returns {string[]|null} null when the lookup itself failed.
 */
function readHits(result, headRef) {
  if (result.status === 1) return [];
  if (result.status !== 0) return null;
  return result.stdout
    .split('\n')
    .map((raw) => formatHit(raw, headRef))
    .filter((hit) => hit !== null);
}

/**
 * Look up each symbol and render the sections, applying the per-symbol and
 * total caps.
 *
 * @param {{ symbols: string[], files: string[], headRef: string, cwd: string, gitSpawnFn: Function, caps: typeof CALLER_CAPS }} args
 * @returns {{ sections: string[], dropped: string[] }}
 */
function lookUpCallers({ symbols, files, headRef, cwd, gitSpawnFn, caps }) {
  const sections = [];
  const dropped = [];
  let used = 0;
  for (const symbol of symbols) {
    const hits = readHits(
      gitSpawnFn(cwd, ...callerGrepArgs(symbol, headRef, files)),
      headRef,
    );
    if (hits === null) {
      dropped.push(`${symbol} (lookup failed)`);
      continue;
    }
    if (hits.length === 0) continue;
    const kept = hits.slice(0, caps.maxLinesPerSymbol);
    const section = `## ${symbol}\n${kept.join('\n')}\n`;
    if (used + section.length > caps.maxChars) {
      dropped.push(`${symbol} (total cap)`);
      continue;
    }
    if (hits.length > kept.length) {
      dropped.push(`${symbol} (${hits.length - kept.length} lines over cap)`);
    }
    sections.push(section);
    used += section.length;
  }
  return { sections, dropped };
}

/**
 * Build the body of the `<callers>` block for a diff, plus every symbol (or
 * part of one) a cap or a failed lookup left unchecked.
 *
 * @param {{
 *   diff: string,
 *   headRef: string,
 *   cwd: string,
 *   gitSpawnFn: (cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string },
 *   caps?: typeof CALLER_CAPS,
 * }} args
 * @returns {{ body: string, dropped: string[] }}
 */
function buildCallersContext({
  diff,
  headRef,
  cwd,
  gitSpawnFn,
  caps = CALLER_CAPS,
}) {
  const extracted = extractChangedSymbols(diff, caps.maxSymbols);
  const { sections, dropped } = lookUpCallers({
    symbols: extracted.symbols,
    files: extracted.files,
    headRef,
    cwd,
    gitSpawnFn,
    caps,
  });
  const body =
    sections.length > 0
      ? sections.join('\n')
      : '(no references to changed symbols outside the changed files)\n';
  return {
    body,
    dropped: [
      ...extracted.dropped.map((symbol) => `${symbol} (symbol cap)`),
      ...dropped,
    ],
  };
}

/**
 * The prompt section the provider appends after the diff: the instruction
 * sentence and the `<callers>` block at a caller-context depth, '' below it;
 * `reason` names what a cap or failed lookup left unchecked, else null.
 *
 * @param {{
 *   diff: string,
 *   input: { headRef: string, depth?: unknown },
 *   cwd: string,
 *   gitSpawnFn: (cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string },
 *   caps?: typeof CALLER_CAPS,
 * }} args - `caps` overrides the 20 / 25 / 30,000 caps (tests).
 * @returns {{ text: string, reason: string|null }}
 */
export function buildCallersSection({
  diff,
  input,
  cwd,
  gitSpawnFn,
  caps = CALLER_CAPS,
}) {
  if (!CALLER_CONTEXT_DEPTHS.includes(normalizeDepth(input.depth))) {
    return { text: '', reason: null };
  }
  const { body, dropped } = buildCallersContext({
    diff,
    headRef: input.headRef,
    cwd,
    gitSpawnFn,
    caps,
  });
  return {
    text: `\n${CALLERS_INSTRUCTION}\n\n<callers>\n${body}</callers>\n`,
    reason:
      dropped.length > 0
        ? `callers block incomplete; not checked: ${dropped.join(', ')}`
        : null,
  };
}
