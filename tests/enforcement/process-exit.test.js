/**
 * tests/enforcement/process-exit.test.js
 *
 * Enforces that library code under `.agents/scripts/lib/` does not call
 * `process.exit(...)` directly. The two sanctioned wrappers — `cli-utils.js`
 * (the `runAsCli` entry-point harness) and `Logger.js` (the `Logger.fatal`
 * exit path) — are explicitly allowlisted. Any other `process.exit(` in the
 * library tree is a bug: libraries must throw or return non-OK results so
 * callers can react, log, and shape the exit code at the CLI boundary.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIB_DIR = path.join(REPO_ROOT, '.agents', 'scripts', 'lib');

// File paths (relative to LIB_DIR, POSIX-style) that are allowed to call
// `process.exit(...)`. These are the canonical CLI exit wrappers; library
// code should call into them rather than reimplement exit semantics.
const SANCTIONED_WRAPPERS = new Set(['cli-utils.js', 'Logger.js']);

const PROCESS_EXIT_RE = /\bprocess\.exit\s*\(/;

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scrubs comments and string literals from JS source while preserving line
 * count, so a line-by-line scanner can match real code without tripping on
 * jsdoc references or string literals like `'do not process.exit'`.
 *
 * Quick-and-dirty by design — this is a grep test, not a parser. We accept
 * false-negatives (process.exit hidden inside a template-literal expression)
 * over false-positives (jsdoc references).
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    // Block comment — replace body with spaces so line numbers stay aligned.
    if (ch === '/' && next === '*') {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === '*' && source[i + 1] === '/')
      ) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      i += 2;
      continue;
    }
    // Line comment.
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    // String / template literal — collapse body to spaces.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '\n' && quote !== '`') break;
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += ' ';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function scanFileForProcessExit(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const cleaned = stripCommentsAndStrings(content);
  const cleanedLines = cleaned.split(/\r?\n/);
  const rawLines = content.split(/\r?\n/);
  const offenses = [];
  for (let i = 0; i < cleanedLines.length; i += 1) {
    if (PROCESS_EXIT_RE.test(cleanedLines[i])) {
      offenses.push({ line: i + 1, text: rawLines[i].trim() });
    }
  }
  return offenses;
}

test('SANCTIONED_WRAPPERS files exist', () => {
  for (const rel of SANCTIONED_WRAPPERS) {
    const full = path.join(LIB_DIR, rel);
    assert.ok(
      fs.existsSync(full),
      `Sanctioned wrapper ${rel} not found at ${full}. Update SANCTIONED_WRAPPERS to match the current path.`,
    );
  }
});

test('stripCommentsAndStrings: ignores process.exit in line comments', () => {
  const sample = '  // process.exit(1) — for reference only';
  assert.strictEqual(
    PROCESS_EXIT_RE.test(stripCommentsAndStrings(sample)),
    false,
  );
});

test('stripCommentsAndStrings: ignores process.exit inside JSDoc blocks', () => {
  const sample =
    '/**\n * file I/O decisions, or process.exit(). All delegated.\n */\nexport function foo() {}';
  assert.strictEqual(
    PROCESS_EXIT_RE.test(stripCommentsAndStrings(sample)),
    false,
  );
});

test('stripCommentsAndStrings: ignores process.exit inside string literals', () => {
  const sample = "  throw new Error('do not call process.exit(1) here');";
  assert.strictEqual(
    PROCESS_EXIT_RE.test(stripCommentsAndStrings(sample)),
    false,
  );
});

test('stripCommentsAndStrings: still flags real process.exit calls', () => {
  const sample = '  process.exit(1);';
  assert.strictEqual(
    PROCESS_EXIT_RE.test(stripCommentsAndStrings(sample)),
    true,
  );
});

test('library code under .agents/scripts/lib/ does not call process.exit() outside sanctioned wrappers', () => {
  const files = listJsFiles(LIB_DIR);
  assert.ok(
    files.length > 0,
    `expected at least one .js file under ${LIB_DIR}`,
  );
  const failures = [];
  for (const file of files) {
    const rel = path.relative(LIB_DIR, file).split(path.sep).join('/');
    if (SANCTIONED_WRAPPERS.has(rel)) continue;
    const offenses = scanFileForProcessExit(file);
    if (offenses.length === 0) continue;
    for (const o of offenses) {
      failures.push(`  .agents/scripts/lib/${rel}:${o.line}  ${o.text}`);
    }
  }
  assert.deepStrictEqual(
    failures,
    [],
    `Library code must not call process.exit() directly — throw or return a non-OK result and let the CLI wrapper handle exit semantics.\nIf a new sanctioned wrapper is genuinely needed, add it to SANCTIONED_WRAPPERS with a justification comment.\n${failures.join('\n')}`,
  );
});

export {
  PROCESS_EXIT_RE,
  SANCTIONED_WRAPPERS,
  scanFileForProcessExit,
  stripCommentsAndStrings,
};
