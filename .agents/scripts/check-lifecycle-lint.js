#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * check-lifecycle-lint.js — enforce the three Tech Spec lint rules for
 * the lifecycle bus surface that biome's stock ruleset cannot express.
 *
 * Rule 1 — "No Promise.all over listener arrays".
 *   Files under `.agents/scripts/lib/orchestration/lifecycle/**` (the bus
 *   + listeners surface) MUST NOT contain `Promise.all(`. The bus is a
 *   strictly sequential mediator; parallelizing listeners breaks
 *   repeatability and idempotency by definition. Tests under
 *   `tests/lifecycle/**` are exempt — fixtures that prove the rule
 *   bites need to carry the pattern.
 *
 * Rule 2 — "Wildcard-observer firewall".
 *   Any module under `.agents/scripts/lib/orchestration/lifecycle/listeners/**`
 *   that calls `bus.on('*', …)` MUST NOT import a side-effecting module.
 *   The static blocklist is small (the modules that mutate GitHub state,
 *   the worktree, or write outside `temp/run-<id>/`); we match by module
 *   specifier suffix to keep the rule simple and stable.
 *
 * Rule 3 — "Auto-merge lockout" (Story #2253 / Task #2255, Epic #2172
 *   review High-1).
 *   String literals containing the substring `gh pr merge` MUST NOT
 *   appear in any file under `.agents/scripts/**` EXCEPT
 *   `.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js`
 *   (Wave 7, Story #2256). The original safety hole was an
 *   unconditional `gh pr merge <pr> --auto --squash --delete-branch`
 *   call in `epic-deliver-finalize.js` that armed GitHub's native
 *   auto-merge BEFORE the framework's automerge predicate evaluated
 *   blocker / review state; the lockout backstops the deletion so a
 *   future refactor cannot quietly re-add it outside the armer.
 *
 *   The rule scans STRING LITERALS only (single-quoted, double-quoted,
 *   or back-ticked) — comments are exempt because the deletion site
 *   needs prose explaining what was removed and why.
 *
 *   The exempt path is matched by suffix so it bites even before the
 *   armer file lands (Wave 7); pre-existence is not required.
 *
 * Exit codes:
 *   0 — clean.
 *   1 — at least one violation; offending file + line printed to stderr.
 *
 * This script ships as part of `npm run lint`. It is intentionally
 * Node-only (no ESLint dependency) because the repo's lint surface is
 * biome + markdownlint; a custom rule fits cleanly alongside.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsCli } from './lib/cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const LIFECYCLE_DIR = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'lib',
  'orchestration',
  'lifecycle',
);
const LISTENERS_SUBDIR = path.join(LIFECYCLE_DIR, 'listeners');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');

/**
 * Files exempt from the merge-lockout rule. The path is matched by
 * suffix against the absolute file path so the entry bites even before
 * the file lands (Wave 7, Story #2256 / Task 8-3 adds
 * `automerge-armer.js`; the rule still has to be in place beforehand
 * so the lockout is enforced from the moment the deletion ships).
 *
 * Maintainers: do NOT widen this list without an architectural review
 * — every additional exempt path is a new place an unauthorized
 * auto-merge call could re-enter the codebase.
 */
const MERGE_LOCKOUT_ALLOWED_SUFFIXES = Object.freeze([
  // v2 Story close path — the sole production code path authorized to
  // call `gh pr merge` after the Epic AutomergeArmer listener was removed.
  path.join(
    'lib',
    'orchestration',
    'single-story-close',
    'phases',
    'auto-merge.js',
  ),
]);

/**
 * Files exempt from the merge-lockout rule because they ARE the rule
 * (fixtures + the lint runner itself necessarily carry the literal so
 * they can match against it). Maintainers: do NOT add production code
 * here — see `MERGE_LOCKOUT_ALLOWED_SUFFIXES`.
 */
const MERGE_LOCKOUT_INFRASTRUCTURE_SUFFIXES = Object.freeze([
  // The lint script itself (this file).
  path.join('.agents', 'scripts', 'check-lifecycle-lint.js'),
]);

/**
 * Static blocklist of modules that mutate state under orchestration.
 * Matched by `import … from '<spec>'` specifier suffix so both
 * relative and package imports are caught. The list is small by
 * intent — wildcard observers should not need ANY of these.
 *
 * Maintainers: when a future module joins the "mutates real state"
 * club, add it here. The lint rule is the wildcard-firewall contract;
 * the listeners SHOULD NOT bypass it.
 */
const STATE_MUTATING_MODULES = Object.freeze([
  // GitHub state writers
  'update-ticket-state.js',
  'post-structured-comment.js',
  'lib/orchestration/ticketing/state.js',
  'lib/orchestration/ticketing/bulk.js',
  // git / worktree mutators
  'lib/git-utils.js',
  'lib/orchestration/worktree-manager.js',
  // notification writers
  'notify.js',
]);

/**
 * Walk a directory tree synchronously, yielding absolute paths of files
 * matching `.js`. The lifecycle surface is small (< 50 files in the
 * worst case); a streaming walker is unnecessary.
 */
function* walkJs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJs(p);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      yield p;
    }
  }
}

/**
 * Rule 1 enforcement. Returns an array of `{ file, line, hint }`
 * violations. Inline disable comments (`// lint-lifecycle-disable`) on
 * the same line opt out — but reviewers should require justification.
 */
export function findPromiseAllViolations(
  rootDir,
  { read = readFileSync } = {},
) {
  const violations = [];
  for (const file of walkJs(rootDir)) {
    const text = read(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // skip lines explicitly opting out
      if (line.includes('lint-lifecycle-disable')) continue;
      if (/\bPromise\.all\s*\(/.test(line)) {
        violations.push({
          file,
          line: i + 1,
          hint: 'Promise.all over listener arrays breaks bus repeatability. Listeners must run sequentially with await.',
        });
      }
    }
  }
  return violations;
}

/**
 * Rule 2 enforcement. Returns violations for any file under
 * `listenersDir` that BOTH (a) registers a wildcard observer
 * (`bus.on('*', …)`) AND (b) imports a state-mutating module.
 *
 * Files that don't register a wildcard observer are not gated; files
 * that wildcard-observe but only import safe modules are not gated.
 */
export function findWildcardObserverFirewallViolations(
  listenersDir,
  { read = readFileSync, blocklist = STATE_MUTATING_MODULES } = {},
) {
  const violations = [];
  for (const file of walkJs(listenersDir)) {
    const text = read(file, 'utf8');
    const hasWildcard = /\bbus\s*\.\s*on\s*\(\s*['"`]\*['"`]/.test(text);
    if (!hasWildcard) continue;
    // Extract imported module specifiers — robust enough for ES module
    // imports without parsing the full AST.
    // `matchAll` returns an iterator of regex match arrays; using it
    // sidesteps the assignment-in-`while` pattern biome flags as
    // confusing.
    for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      for (const banned of blocklist) {
        if (spec === banned || spec.endsWith(`/${banned}`)) {
          violations.push({
            file,
            spec,
            hint: `Wildcard observers must not import state-mutating modules. Saw '${spec}'.`,
          });
          break;
        }
      }
    }
  }
  return violations;
}

/**
 * Strip block (`/* … *​/`) and line (`// …`) comments from a source
 * string. Pure — exported for tests so the comment-stripping contract
 * is explicit. Defends against the corner case where the literal
 * `'gh pr merge'` appears INSIDE a justification comment at the
 * deletion site (Story #2253 deliberately leaves a prose explanation
 * referencing the removed CLI call).
 *
 * The implementation is a tiny state machine rather than a regex so it
 * correctly handles the (legal) case of a string literal containing
 * `//` or `/​*` characters.
 *
 * @param {string} src
 * @returns {string} source with comments replaced by spaces (line
 *   numbers preserved so violations report the original line).
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    // line comment
    if (ch === '/' && nx === '/') {
      while (i < n && src[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    // block comment
    if (ch === '/' && nx === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        // preserve newlines so line numbers in violation reports stay
        // aligned with the original file.
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2; // skip closing */
      continue;
    }
    // string literal — copy through unchanged (we WANT to keep these
    // so Rule 3 can flag them).
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = src[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Rule 3 enforcement (Story #2253 / Task #2255, Epic #2172 review
 * High-1). Returns an array of `{ file, line, hint }` violations for
 * any file under `rootDir` (recursively) whose source — with comments
 * stripped — contains a string literal carrying the substring
 * `gh pr merge`. The allow-list (`automerge-armer.js`) and the
 * infrastructure list (the lint script + fixtures it owns) are
 * matched by absolute-path suffix.
 *
 * Exposed for unit tests so the lockout contract can be exercised
 * against synthetic fixture trees without polluting the live source.
 */
export function findMergeLockoutViolations(
  rootDir,
  {
    read = readFileSync,
    allowSuffixes = MERGE_LOCKOUT_ALLOWED_SUFFIXES,
    infrastructureSuffixes = MERGE_LOCKOUT_INFRASTRUCTURE_SUFFIXES,
  } = {},
) {
  const violations = [];
  // The literal we forbid. Kept in a constant so we can refer to it in
  // the violation `hint` without the literal appearing as a string in
  // arbitrary positions. The space matters — `gh-pr-merge` is not the
  // CLI, only the space-delimited form is.
  const FORBIDDEN = 'gh pr merge';
  const lineRe = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  for (const file of walkJs(rootDir)) {
    // Skip the armer (intentional carrier) and the lint infrastructure.
    const allExempt = [...allowSuffixes, ...infrastructureSuffixes];
    if (allExempt.some((suffix) => file.endsWith(suffix))) continue;

    const raw = read(file, 'utf8');
    const rawLines = raw.split('\n');
    const stripped = stripComments(raw);
    const lines = stripped.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Honour the opt-out marker; it lives in a comment (and is
      // therefore stripped above), so consult the RAW line for the
      // marker check. Kept consistent with Rule 1.
      const rawLine = rawLines[i] ?? '';
      if (rawLine.includes('lint-lifecycle-disable')) continue;
      // Find every string literal on the (comment-stripped) line and
      // inspect its body.
      lineRe.lastIndex = 0;
      let match = lineRe.exec(line);
      while (match !== null) {
        const literalBody = match[2];
        if (literalBody.includes(FORBIDDEN)) {
          violations.push({
            file,
            line: i + 1,
            hint: `String literal containing '${FORBIDDEN}' is forbidden outside single-story-close/phases/auto-merge.js. Auto-merge enablement must flow through the Story close path.`,
          });
          break; // one violation per line is enough
        }
        match = lineRe.exec(line);
      }
    }
  }
  return violations;
}

async function main() {
  // Per-rule discovery.
  const v1 = findPromiseAllViolations(LIFECYCLE_DIR);
  const v2 = findWildcardObserverFirewallViolations(LISTENERS_SUBDIR);
  const v3 = findMergeLockoutViolations(SCRIPTS_DIR);
  const all = [
    ...v1.map((v) => ({ rule: 'no-promise-all-listeners', ...v })),
    ...v2.map((v) => ({ rule: 'wildcard-observer-firewall', ...v })),
    ...v3.map((v) => ({ rule: 'merge-lockout', ...v })),
  ];
  if (all.length === 0) {
    process.stdout.write(
      '[lifecycle-lint] clean: no Promise.all over listeners; no wildcard-firewall breaches; no merge-lockout violations.\n',
    );
    return 0;
  }
  for (const v of all) {
    const loc = v.line ? `${v.file}:${v.line}` : v.file;
    process.stderr.write(`[lifecycle-lint][${v.rule}] ${loc}\n  ${v.hint}\n`);
  }
  return 1;
}

await runAsCli(import.meta.url, main, {
  source: 'check-lifecycle-lint',
  propagateExitCode: true,
});
