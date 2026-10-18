/**
 * review-providers/callers-context.js — the `<callers>` block for a `deep`
 * review: lines outside the changed files that reference symbols the diff
 * defines or removes, by `git grep` at the head ref. Every cap that drops
 * context is reported so the provider records a degradation.
 */

import { normalizeDepth } from './review-depth.js';

/** Widen after a measured review-time check. */
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
  new RegExp(`\\bfunction\\b\\s*\\*?\\s*(${IDENT})`, 'g'),
  new RegExp(`\\bclass\\s+(${IDENT})`, 'g'),
  new RegExp(`\\bexport\\s+(?:const|let|var)\\s+(${IDENT})`, 'g'),
]);
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const NEW_FILE_HEADER = /^\+\+\+ b\/(.+)$/;
/** Comment prose ("the function returns…") declares nothing. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** `export { A, B as C }` exports `A` and `C`. */
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

/** Hunk bodies only, so `+++`/`---` headers never contribute. */
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
    for (const name of symbolsOnLine(changedCode(line))) found.add(name);
  }
  return { found, files };
}

/** The code of a `+`/`-` hunk line; `''` for context and comment-only lines. */
function changedCode(line) {
  const body = line.slice(1);
  if (!/^[+-]/.test(line) || COMMENT_LINE.test(body)) return '';
  return body;
}

/** Longest first: short names grep noisily. */
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

function formatHit(raw, headRef) {
  const prefix = `${headRef}:`;
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const match = /^(.*?):(\d+):(.*)$/.exec(rest);
  return match ? `${match[1]}:${match[2]}: ${match[3].trim()}` : null;
}

function readHits(result, headRef) {
  if (result.status === 1) return [];
  if (result.status !== 0) return null;
  return result.stdout
    .split('\n')
    .map((raw) => formatHit(raw, headRef))
    .filter((hit) => hit !== null);
}

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
 * The instruction plus `<callers>` block at `deep` ('' below it), and a
 * degradation `reason` when a cap or lookup left a symbol unchecked.
 * `caps` overrides the 20 / 25 / 30,000 limits (tests).
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
