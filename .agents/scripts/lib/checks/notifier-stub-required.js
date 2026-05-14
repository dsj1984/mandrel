/**
 * notifier-stub-required — refuse-and-print check.
 *
 * Detects test files that construct a Notifier or NotificationHook without
 * stubbing both `cwd` and `fetchImpl`. Any test path that builds a
 * Notifier/NotificationHook with the real cwd + the real fetch can POST
 * to the production Slack webhook the moment its scenario runs. The
 * canonical defense is to stub both fields in every test construction.
 *
 * Scope: 'epic-deliver', 'story-close', 'retro'. The check runs at every
 * preflight surface and surfaces at retro for sprint-level audit. There
 * is no `fix()` — a test author edits each offending file by hand;
 * auto-rewriting test source would be out of bounds for the
 * local-bounded-reversible AutoCorrect rule.
 *
 * Implementation note: the check walks the `tests/` tree directly rather
 * than asking state.js for projections. The current SCOPE_KEYS map does
 * not declare a `fs.testsTree` projection, and adding one would couple
 * unrelated checks to a tree-walk every run. Until a future story
 * factors test-scanning into state.js, the walk is local to this module
 * and bounded by the README rule that checks must not maintain
 * module-level mutable state — the walk is per-call.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TESTS_DIR_DEFAULT = 'tests';

/**
 * Path segments under the tests root whose contents are exempt from the
 * scan. `lib/checks/` is the unit-test tree for the lib/checks/ modules
 * — those test files exist to exercise the checks and frequently embed
 * literal `new Notifier(...)` substrings inside fixture strings as test
 * data. Scanning them is a guaranteed false-positive surface; nothing
 * inside the check-registry test tree is a real production-pattern
 * Notifier construction.
 *
 * Stored as a path-fragment array (forward slashes; normalized to the
 * platform separator at compare time) so the exclusion is robust on
 * both POSIX and Windows.
 */
const EXEMPT_PATH_FRAGMENTS = ['lib/checks'];

/**
 * The pattern that constructs a Notifier or NotificationHook. We require
 * the call to pass an object literal with both `cwd` and `fetchImpl`
 * keys on the same line (or within the same constructor call).
 */
const CONSTRUCTOR_RE = /\bnew\s+(Notifier|NotificationHook)\s*\(/g;

/**
 * Returns true when `relPath` (a tests-rooted relative path with `/`
 * separators) lives under one of the exempt subtrees.
 */
function isExemptPath(relPath) {
  for (const frag of EXEMPT_PATH_FRAGMENTS) {
    if (relPath === frag) return true;
    if (relPath.startsWith(`${frag}/`)) return true;
  }
  return false;
}

/**
 * Walk a directory recursively, yielding absolute file paths that end in
 * `.js`, `.mjs`, or `.cjs`. Skips `node_modules` and `.worktrees`.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walkJsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.worktrees') {
        continue;
      }
      out.push(...walkJsFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Inspect a single Notifier/NotificationHook constructor call site. We
 * read a small window of source after the `new Notifier(` token, up to
 * the matching closing paren (depth-tracked, ignoring quoted strings and
 * comments at a very superficial level — test fixtures don't contain
 * pathological constructor arguments).
 *
 * Returns the set of stub keys observed in the constructor argument
 * (only `cwd` and `fetchImpl` are tracked). A missing key in the
 * returned set is what makes a finding.
 *
 * @param {string} src     Full file source.
 * @param {number} startIdx Index of the constructor name (e.g. 'Notifier').
 * @returns {{ keys: Set<string>, endIdx: number }}
 */
function readConstructorArgs(src, startIdx) {
  const open = src.indexOf('(', startIdx);
  if (open === -1) return { keys: new Set(), endIdx: startIdx };
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) break;
    i++;
  }
  const argSrc = src.slice(open + 1, i);
  const keys = new Set();
  if (/\bcwd\s*:/.test(argSrc)) keys.add('cwd');
  if (/\bfetchImpl\s*:/.test(argSrc)) keys.add('fetchImpl');
  return { keys, endIdx: i };
}

/**
 * Run the detection. Returns an array of `{ file, line, missing }`
 * offences. Each line that has a constructor missing one or both stubs
 * is one entry — multiple offences per file are collapsed into one
 * detail line block.
 *
 * @param {string} rootDir
 * @returns {Array<{ file: string, line: number, missing: string[] }>}
 */
function findOffences(rootDir) {
  const offences = [];
  const files = walkJsFiles(rootDir);
  for (const file of files) {
    const relForExempt = path.relative(rootDir, file).replace(/\\/g, '/');
    if (isExemptPath(relForExempt)) continue;
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!/\bnew\s+(Notifier|NotificationHook)\b/.test(src)) continue;
    // Reset regex state per file (RegExp objects are stateful with /g).
    const re = new RegExp(CONSTRUCTOR_RE.source, 'g');
    for (let match = re.exec(src); match !== null; match = re.exec(src)) {
      const { keys } = readConstructorArgs(src, match.index);
      const missing = [];
      if (!keys.has('cwd')) missing.push('cwd');
      if (!keys.has('fetchImpl')) missing.push('fetchImpl');
      if (missing.length === 0) continue;
      // Convert char index → 1-based line number.
      const upTo = src.slice(0, match.index);
      const line = upTo.split(/\r?\n/).length;
      offences.push({
        file: path.relative(rootDir, file).replace(/\\/g, '/'),
        line,
        missing,
      });
    }
  }
  return offences;
}

const FIX_COMMAND = [
  '# Stub both cwd and fetchImpl when constructing Notifier / NotificationHook:',
  "new Notifier({ cwd: '/tmp/stub', fetchImpl: async () => new Response('ok') })",
].join('\n');

export default {
  id: 'notifier-stub-required',
  severity: 'blocker',
  scope: ['epic-deliver', 'story-close', 'retro'],
  autoCorrect: 'refuse-and-print',

  detect(state) {
    // Allow tests to inject a custom root via state.scanRoot; production
    // callers default to <cwd>/tests. We deliberately do NOT pull this
    // off state.fs.* — see the file header on why test-tree scanning
    // remains local to this check until state.js grows a projection.
    const cwd = state?.cwd ?? process.cwd();
    const root = state?.scanRoot ?? path.join(cwd, TESTS_DIR_DEFAULT);
    const offences = findOffences(root);
    if (offences.length === 0) return null;
    const detail = offences
      .map((o) => `${o.file}:${o.line} — missing { ${o.missing.join(', ')} }`)
      .join('\n');
    return {
      id: 'notifier-stub-required',
      severity: 'blocker',
      scope: state?.scope ?? 'story-close',
      summary: `${offences.length} test construction(s) of Notifier/NotificationHook missing cwd + fetchImpl stubs`,
      detail,
      fixCommand: FIX_COMMAND,
      autoCorrectable: false,
    };
  },
};
