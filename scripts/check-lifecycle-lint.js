#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * check-lifecycle-lint.js — enforce the lifecycle lint rules that biome's
 * stock ruleset cannot express.
 *
 * Rule 1 — "No Promise.all over the lifecycle surface".
 *   Files under `.agents/scripts/lib/orchestration/lifecycle/**` MUST NOT
 *   contain `Promise.all(`. The surface is the append-only ledger writer, and
 *   record ordering is the whole point of an append-only trail: a parallel
 *   write interleaves records and breaks the ordering a reader relies on.
 *   Tests under `tests/lifecycle/**` are exempt — fixtures that prove the rule
 *   bites need to carry the pattern.
 *
 *   (Story #5024 narrowed the rationale. It was "the bus is a strictly
 *   sequential mediator; parallelizing listeners breaks repeatability", which
 *   stopped being the reason when the bus was deleted. The rule still guards a
 *   real property of what remains.)
 *
 *   The old Rule 2 — "wildcard-observer firewall", gating any module under
 *   `lifecycle/listeners/**` that called `bus.on('*', …)` — was deleted by
 *   Story #5024 along with the bus. Both halves of its predicate became
 *   unsatisfiable in the same commit (the directory is gone and there is no
 *   `bus` to call `.on` on), so it returned zero violations by construction
 *   rather than by verification: a gate that cannot fire, of exactly the class
 *   Story #5004 retired `check-gherkin-placeholders.js` for.
 *
 * Rule 3 — "Auto-merge lockout" (Story #2253 / Task #2255, Epic #2172
 *   review High-1).
 *   String literals containing the substring `gh pr merge` MUST NOT
 *   appear in any file under `.agents/scripts/**` EXCEPT
 *   `lib/orchestration/single-story-close/phases/auto-merge.js` — the v2
 *   close path that replaced the Epic-era `AutomergeArmer` listener the rule
 *   was originally written against. The original safety hole was an
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
 * Scan root:
 *   --root <dir>  Scan <dir> instead of this checkout. Both surfaces are
 *                 derived from it, so one flag moves the whole scan.
 *                 Defaults to the repository this script ships in, which is
 *                 what `npm run lint` gets by passing nothing.
 *
 *   The seam exists for tests (Story #5052). The CLI test that proves a
 *   violation is *caught* has to plant one, and it used to plant into the
 *   live `.agents/` tree — which `tests/e2e/sync-prune.integration.test.js`
 *   copies with the real binary, so the two raced: the sync either lost the
 *   file between enumeration and `copyfile` (ENOENT) or copied it once and
 *   pruned it on the second pass, tripping an idempotence assertion. Pointing
 *   the planting test at a temp root keeps what that test was written for —
 *   discovery is still the CLI's own walk, not an injected file list — while
 *   leaving the shared tree untouched. Mirrors the `--root` seam
 *   `check-test-temp-hygiene.js` already ships for the same reason.
 *
 * Exit codes:
 *   0 — clean.
 *   1 — at least one violation; offending file + line printed to stderr.
 *
 * This script ships as part of `npm run lint`. It is intentionally
 * Node-only (no ESLint dependency) because the repo's lint surface is
 * biome + markdownlint; a custom rule fits cleanly alongside.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import { stripJsComments } from '../.agents/scripts/lib/source-text/strip-js-comments.js';
import { walkFilesByExtension } from './lib/fs-walk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Rule 1's scan surface for a given repository root. */
function lifecycleDirFor(root) {
  return path.join(
    root,
    '.agents',
    'scripts',
    'lib',
    'orchestration',
    'lifecycle',
  );
}

/** Rule 3's scan surface for a given repository root. */
function scriptsDirFor(root) {
  return path.join(root, '.agents', 'scripts');
}

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
  path.join('scripts', 'check-lifecycle-lint.js'),
]);

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
  for (const file of walkFilesByExtension(rootDir, '.js')) {
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
          hint: 'Promise.all on the lifecycle surface interleaves ledger writes. The ledger is append-only; writes must stay sequential.',
        });
      }
    }
  }
  return violations;
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
  for (const file of walkFilesByExtension(rootDir, '.js')) {
    // Skip the armer (intentional carrier) and the lint infrastructure.
    const allExempt = [...allowSuffixes, ...infrastructureSuffixes];
    if (allExempt.some((suffix) => file.endsWith(suffix))) continue;

    const raw = read(file, 'utf8');
    const rawLines = raw.split('\n');
    const stripped = stripJsComments(raw);
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

/**
 * Parse the argument vector. The only option is the scan root; anything
 * else is ignored so an extra flag can never silently narrow the scan.
 *
 * @param {string[]} argv Arguments without the node/script entries.
 * @returns {{ root: string }}
 */
function parseArgv(argv) {
  let root = REPO_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      i += 1;
      root = path.resolve(String(argv[i] ?? '.'));
    }
  }
  return { root };
}

async function main() {
  const { root } = parseArgv(process.argv.slice(2));
  // Per-rule discovery. Both rules' exemptions match by absolute-path
  // SUFFIX, which is what lets an injected root keep the same allow-list
  // semantics as the live tree — do not re-anchor them to `root`.
  const v1 = findPromiseAllViolations(lifecycleDirFor(root));
  const v3 = findMergeLockoutViolations(scriptsDirFor(root));
  const all = [
    ...v1.map((v) => ({ rule: 'no-promise-all-lifecycle', ...v })),
    ...v3.map((v) => ({ rule: 'merge-lockout', ...v })),
  ];
  if (all.length === 0) {
    process.stdout.write(
      '[lifecycle-lint] clean: no Promise.all on the lifecycle surface; no merge-lockout violations.\n',
    );
    return 0;
  }
  for (const v of all) {
    // Both finders always stamp a 1-based `line`, so there is no file-only
    // fallback to render — the ternary that used to guard this was an
    // unreachable branch (Story #5024).
    process.stderr.write(
      `[lifecycle-lint][${v.rule}] ${v.file}:${v.line}\n  ${v.hint}\n`,
    );
  }
  return 1;
}

await runAsCli(import.meta.url, main, {
  source: 'check-lifecycle-lint',
  propagateExitCode: true,
  usage: {
    invocation: 'node scripts/check-lifecycle-lint.js [--root <dir>]',
    summary:
      'Enforce the two lifecycle lint rules biome cannot express: no Promise.all on the append-only lifecycle surface, and the auto-merge lockout on string literals under .agents/scripts/.',
    flags: [
      [
        '--root <dir>',
        'Repository root to scan (default: the checkout this script ships in). Both rule surfaces derive from it; used by tests so a planted violation never touches the shared tree.',
      ],
    ],
    notes: [
      'Ships as part of `npm run lint`, which invokes it with no arguments.',
      'Exit codes:\n  0  clean\n  1  at least one violation; offending file and line printed to stderr',
    ],
  },
});
