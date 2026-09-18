/**
 * Scoped discovery and matching of BDD step definitions for
 * `check-gherkin-corpus.js`. Feature discovery reuses the scenario scanner's
 * `listFeatureFiles` so both agree on what a feature file is.
 *
 * The index is a heuristic source scan (it cannot see runtime-built or
 * wrapped definitions), hence the gate's step-waiver list. An unknown
 * `{custom}` parameter degrades to `(.*)`: over-matching misses a finding,
 * under-matching blocks a delivery with a false one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { listFeatureFiles } from './bdd-scenario-scanner.js';

export { listFeatureFiles };

const STEP_FILE_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
]);

const SKIPPED_DIRECTORIES = Object.freeze(
  new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']),
);

/**
 * Built-in parameter types; `''` is `{}` and the fallback for custom types.
 *
 * @type {Readonly<Record<string, string>>}
 */
const PARAMETER_PATTERNS = Object.freeze({
  '': '(.*)',
  int: '(-?\\d+)',
  float: '(-?\\d*\\.?\\d+)',
  word: '([^\\s]+)',
  string: '("[^"]*"|\'[^\']*\')',
});

/** Groups 2/3: quoted expression; 4/5: regex literal and flags. */
const STEP_CALL_PATTERN =
  /\b(Given|When|Then|And|But|Step|defineStep)\s*\(\s*(?:(['"`])((?:\\.|(?!\2)[^\\])*)\2|\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[])+)\/([dgimsuvy]*))/g;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} segment An alternation-free piece of an expression.
 * @returns {string}
 */
function renderSegment(segment) {
  let out = '';
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === '\\' && i + 1 < segment.length) {
      out += escapeRegExp(segment[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '{') {
      const end = segment.indexOf('}', i);
      if (end !== -1) {
        const name = segment.slice(i + 1, end);
        out += PARAMETER_PATTERNS[name] ?? PARAMETER_PATTERNS[''];
        i = end + 1;
        continue;
      }
    }
    if (ch === '(') {
      const end = segment.indexOf(')', i);
      if (end !== -1) {
        out += `(?:${renderSegment(segment.slice(i + 1, end))})?`;
        i = end + 1;
        continue;
      }
    }
    out += escapeRegExp(ch);
    i += 1;
  }
  return out;
}

/**
 * @param {string} word Split on unescaped `/`.
 * @returns {string[]}
 */
function splitAlternation(word) {
  const parts = [];
  let current = '';
  for (let i = 0; i < word.length; i += 1) {
    const ch = word[i];
    if (ch === '\\' && i + 1 < word.length) {
      current += ch + word[i + 1];
      i += 1;
      continue;
    }
    if (ch === '/') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Alternation is per word, as in the real grammar; whole-string alternation
 * would anchor the wrong alternatives.
 *
 * @param {string} expression
 * @returns {RegExp}
 */
function expressionToRegExp(expression) {
  const tokens = String(expression).split(/(\s+)/);
  const body = tokens
    .map((token) => {
      if (token.length === 0) return '';
      if (/^\s+$/.test(token)) return escapeRegExp(token);
      const alternatives = splitAlternation(token);
      const rendered = alternatives.map(renderSegment);
      return rendered.length > 1 ? `(?:${rendered.join('|')})` : rendered[0];
    })
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * Not `fs-walk.js`: that walker takes one extension, descends into
 * `node_modules`, and rethrows readdir failures, whereas an unreadable scope
 * here must surface as "zero step definitions" (the gate's fail-closed path).
 *
 * @param {string[]} roots
 * @returns {string[]} absolute paths, sorted
 */
export function listStepFiles(roots) {
  const found = [];
  for (const root of roots ?? []) {
    walkStepDir(path.resolve(root), found);
  }
  return found.sort();
}

function walkStepDir(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // A symlink is neither file nor directory to `withFileTypes`; stat it.
    const isDir =
      entry.isDirectory() || (entry.isSymbolicLink() && isDirAt(full));
    if (isDir) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walkStepDir(full, acc);
      continue;
    }
    if (STEP_FILE_EXTENSIONS.includes(path.extname(entry.name))) acc.push(full);
  }
}

function isDirAt(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} source
 * @param {string} file
 * @returns {Array<{ file: string, line: number, source: string, regex: RegExp }>}
 */
function parseStepDefinitions(source, file) {
  const entries = [];
  STEP_CALL_PATTERN.lastIndex = 0;
  let match = STEP_CALL_PATTERN.exec(source);
  while (match !== null) {
    const [, , , quoted, pattern, flags] = match;
    const line = source.slice(0, match.index).split('\n').length;
    const regex = compileMatcher({ quoted, pattern, flags });
    if (regex) entries.push({ file, line, source: quoted ?? pattern, regex });
    match = STEP_CALL_PATTERN.exec(source);
  }
  return entries;
}

/** A malformed pattern yields `null`: its steps surface as unbound, the safe direction. */
function compileMatcher({ quoted, pattern, flags }) {
  if (typeof quoted === 'string') {
    try {
      return expressionToRegExp(quoted);
    } catch {
      return null;
    }
  }
  try {
    // `g`/`y` make `.test()` stateful.
    return new RegExp(pattern, (flags ?? '').replace(/[gy]/g, ''));
  } catch {
    return null;
  }
}

/**
 * @param {{ files: string[], readFile?: (p: string) => string }} params
 * @returns {{ entries: Array<{ file: string, line: number, source: string, regex: RegExp }>, files: string[] }}
 */
export function buildStepIndex({ files, readFile }) {
  const read = readFile ?? ((p) => readFileSync(p, 'utf8'));
  const entries = [];
  for (const file of files ?? []) {
    let source;
    try {
      source = read(file);
    } catch {
      continue;
    }
    entries.push(...parseStepDefinitions(source, file));
  }
  return { entries, files: [...(files ?? [])] };
}

/**
 * @param {{ entries: Array<{ regex: RegExp }> }} index
 * @param {string} text Step text without its keyword.
 * @returns {object | null}
 */
export function matchStep(index, text) {
  for (const entry of index?.entries ?? []) {
    if (entry.regex.test(text)) return entry;
  }
  return null;
}

/** Test-only helpers, bundled so they cost one dead-export row. */
export const __testing = Object.freeze({
  expressionToRegExp,
  parseStepDefinitions,
});
