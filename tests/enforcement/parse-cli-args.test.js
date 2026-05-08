/**
 * tests/enforcement/parse-cli-args.test.js
 *
 * Enforces the CLI-args migration: top-level scripts under `.agents/scripts/`
 * must NOT export a function named `parseCliArgs`. The canonical surface for
 * declarative CLI parsing is `defineFlags` in `lib/cli-args.js` (built on
 * `node:util#parseArgs`). Each migrated script renames its parser to
 * `parseArgv` (or removes the export entirely) so the historical name no
 * longer survives as a divergent hand-rolled walker.
 *
 * Scope:
 *   - `.agents/scripts/**\/*.js` — every file under the orchestrator script
 *     tree, including subdirectories (`lib/audit-suite/cli.js` was one of the
 *     migrated sites). The lone allowed exception is `lib/cli-args.js`
 *     itself, which mentions `parseCliArgs` only in its docstring.
 *
 * What is forbidden:
 *   - `export function parseCliArgs(...)` (named function export)
 *   - `export const parseCliArgs = ...` / `export let parseCliArgs = ...`
 *   - `export { parseCliArgs }` / `export { foo as parseCliArgs }`
 *   - Re-exports: `export { parseCliArgs } from './...'`
 *
 * What is allowed:
 *   - Internal-only `function parseCliArgs(...)` declarations in non-listed
 *     scripts (they are private; the migration target was the *exports*).
 *   - Plain string mentions in comments / docstrings.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');

const PATTERNS = [
  // export function parseCliArgs(...)
  /\bexport\s+(?:async\s+)?function\s+parseCliArgs\b/,
  // export const|let|var parseCliArgs = ...
  /\bexport\s+(?:const|let|var)\s+parseCliArgs\b/,
  // export { ..., parseCliArgs, ... }  /  export { foo as parseCliArgs }
  /\bexport\s*\{[^}]*\bparseCliArgs\b[^}]*\}/,
];

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJs(p));
    } else if (entry.isFile() && p.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

function findOffenders(content) {
  const matches = [];
  for (const re of PATTERNS) {
    const m = content.match(re);
    if (m) matches.push(m[0]);
  }
  return matches;
}

test('PATTERNS detect a real `export function parseCliArgs` declaration', () => {
  const sample = 'export function parseCliArgs(argv) { return argv; }';
  assert.equal(findOffenders(sample).length, 1);
});

test('PATTERNS detect `export { parseCliArgs }` re-exports', () => {
  const sample = "export { parseCliArgs } from './cli.js';";
  assert.equal(findOffenders(sample).length, 1);
});

test('PATTERNS ignore comment / docstring mentions of parseCliArgs', () => {
  const sample = `
    // Replaces the hand-rolled parseCliArgs walkers.
    /** parseCliArgs is the historical name. */
  `;
  assert.equal(findOffenders(sample).length, 0);
});

test('PATTERNS ignore internal (non-exported) function parseCliArgs', () => {
  const sample = 'function parseCliArgs(argv) { return argv; }';
  assert.equal(findOffenders(sample).length, 0);
});

test('no top-level script under .agents/scripts/ exports parseCliArgs', () => {
  const files = walkJs(SCRIPTS_DIR);
  assert.ok(files.length > 0, `expected .js files under ${SCRIPTS_DIR}`);

  const offenders = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const matches = findOffenders(content);
    if (matches.length > 0) {
      offenders.push({ file: path.relative(REPO_ROOT, file), matches });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Migrate the listed exports to parseArgv (or remove the export). ` +
      `Use defineFlags in lib/cli-args.js instead of hand-rolling argv walkers. ` +
      `Offenders:\n${offenders
        .map((o) => `  - ${o.file}\n      ${o.matches.join('\n      ')}`)
        .join('\n')}`,
  );
});
