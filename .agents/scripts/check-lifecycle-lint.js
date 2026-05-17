#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * check-lifecycle-lint.js — enforce the two Tech Spec lint rules for the
 * lifecycle bus surface that biome's stock ruleset cannot express.
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
 *   the worktree, or write outside `temp/epic-<id>/`); we match by module
 *   specifier suffix to keep the rule simple and stable.
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
  // PR writers
  'epic-deliver-finalize.js',
  'epic-deliver-automerge.js',
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

async function main() {
  // Per-rule discovery.
  const v1 = findPromiseAllViolations(LIFECYCLE_DIR);
  const v2 = findWildcardObserverFirewallViolations(LISTENERS_SUBDIR);
  const all = [
    ...v1.map((v) => ({ rule: 'no-promise-all-listeners', ...v })),
    ...v2.map((v) => ({ rule: 'wildcard-observer-firewall', ...v })),
  ];
  if (all.length === 0) {
    process.stdout.write(
      '[lifecycle-lint] clean: no Promise.all over listeners; no wildcard-firewall breaches.\n',
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
