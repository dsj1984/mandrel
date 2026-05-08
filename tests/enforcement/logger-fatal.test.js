/**
 * tests/enforcement/logger-fatal.test.js
 *
 * Enforces that every `Logger.fatal(...)` call carries a non-empty message
 * argument. The fatal path prints `[Orchestrator] ❌ <message>` and exits
 * the process; calling it with no arguments or an empty string emits the
 * literal `❌ undefined` (or `❌ ` with nothing after it) and gives the
 * operator zero context for the failure. Always pass a meaningful message.
 *
 * Scope: every `.js` file under `.agents/scripts/`, including CLI top-level
 * scripts and the `lib/` tree. Logger.js itself defines `fatal` and is
 * exempt by virtue of the regex matching only call-sites — the definition
 * (`fatal(message) { ... }`) doesn't match `Logger.fatal(`.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');

// Match `Logger.fatal(` with the call left open so we can inspect the
// arguments separately.
const LOGGER_FATAL_OPEN_RE = /\bLogger\.fatal\s*\(/g;

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
 * Scrub comments and string literals from JS source while preserving line
 * count AND byte offsets. Block comments and strings are replaced with
 * spaces / newlines so a regex scanner can match real code without tripping
 * on JSDoc references to the call pattern.
 *
 * String literal bodies are scrubbed too — if a `Logger.fatal` literally
 * appears inside a quoted message argument, we don't want to confuse it
 * with a call-site. The downside is that we can't see the call's argument
 * via the scrubbed text; we read the argument back from the raw source
 * using a paren-balance walk. Length preservation matters because
 * `scanFileForBadFatal` uses a `match.index` from the cleaned text to
 * seek into the raw text — any drift between the two would land the
 * arg-walker in unrelated code.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (
        i < source.length &&
        !(source[i] === '*' && source[i + 1] === '/')
      ) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === '\n' && quote !== '`') break;
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < source.length) {
        out += ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Read the argument list from a Logger.fatal call site by walking parens
 * from the position **just after** the opening `(`. Returns the raw text
 * of the arg list (between the matching parens). Operates on the raw
 * source so quoted strings stay intact.
 */
function readArgList(source, openParenIndex) {
  let depth = 1;
  let i = openParenIndex + 1;
  let inString = null;
  let buf = '';
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (inString) {
      buf += ch;
      if (ch === '\\') {
        buf += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
    buf += ch;
    i += 1;
  }
  return buf;
}

const EMPTY_STRING_ARG_RE = /^\s*(?:''|""|``)\s*$/;

function classifyFatalCall(argList) {
  const trimmed = argList.trim();
  if (trimmed.length === 0) return 'empty-args';
  if (EMPTY_STRING_ARG_RE.test(trimmed)) return 'empty-string';
  return 'ok';
}

function lineNumberAtIndex(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function scanFileForBadFatal(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const cleaned = stripCommentsAndStrings(raw);
  const offenses = [];
  for (const match of cleaned.matchAll(LOGGER_FATAL_OPEN_RE)) {
    const openParenIndex = match.index + match[0].length - 1;
    const argList = readArgList(raw, openParenIndex);
    const verdict = classifyFatalCall(argList);
    if (verdict === 'ok') continue;
    offenses.push({
      line: lineNumberAtIndex(raw, match.index),
      kind: verdict,
      text: raw
        .slice(match.index, match.index + match[0].length + argList.length + 1)
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }
  return offenses;
}

test('classifyFatalCall: flags zero-argument calls', () => {
  assert.strictEqual(classifyFatalCall(''), 'empty-args');
  assert.strictEqual(classifyFatalCall('   '), 'empty-args');
});

test('classifyFatalCall: flags empty string literals', () => {
  assert.strictEqual(classifyFatalCall("''"), 'empty-string');
  assert.strictEqual(classifyFatalCall('""'), 'empty-string');
  assert.strictEqual(classifyFatalCall('``'), 'empty-string');
  assert.strictEqual(classifyFatalCall('  ""  '), 'empty-string');
});

test('classifyFatalCall: passes meaningful arguments', () => {
  assert.strictEqual(classifyFatalCall("'something'"), 'ok');
  assert.strictEqual(classifyFatalCall('err.message'), 'ok');
  // Build the template-literal sample via concatenation so biome doesn't
  // flag a `${...}` placeholder embedded in a non-template-string literal.
  const tmpl = '`Failed: $' + '{reason}`';
  assert.strictEqual(classifyFatalCall(tmpl), 'ok');
});

test('readArgList: reads a simple argument', () => {
  const src = "Logger.fatal('hello');";
  const open = src.indexOf('(');
  assert.strictEqual(readArgList(src, open), "'hello'");
});

test('readArgList: handles nested parens and template strings', () => {
  // Concatenate the placeholder so biome doesn't flag a `${...}` embedded
  // in a non-template-string literal.
  const arg = '`Failed: $' + '{(a + b)}`';
  const src = `Logger.fatal(${arg});`;
  const open = src.indexOf('(');
  assert.strictEqual(readArgList(src, open), arg);
});

test('readArgList: handles balanced empty argument list', () => {
  const src = 'Logger.fatal();';
  const open = src.indexOf('(');
  assert.strictEqual(readArgList(src, open), '');
});

test('scanFileForBadFatal: ignores Logger.fatal inside JSDoc blocks', (t) => {
  const tmp = path.join(
    REPO_ROOT,
    'tests',
    'enforcement',
    `.tmp-${Date.now()}-fatal-doc.js`,
  );
  fs.writeFileSync(
    tmp,
    '/**\n * Avoid Logger.fatal() with no message — pass a string.\n */\nexport function ok() { Logger.fatal("real"); }\n',
    'utf8',
  );
  t.after(() => fs.rmSync(tmp, { force: true }));
  const offenses = scanFileForBadFatal(tmp);
  assert.deepStrictEqual(offenses, []);
});

test('scanFileForBadFatal: catches a real zero-arg call', (t) => {
  const tmp = path.join(
    REPO_ROOT,
    'tests',
    'enforcement',
    `.tmp-${Date.now()}-fatal-bad.js`,
  );
  fs.writeFileSync(tmp, 'function bad() { Logger.fatal(); }\n', 'utf8');
  t.after(() => fs.rmSync(tmp, { force: true }));
  const offenses = scanFileForBadFatal(tmp);
  assert.strictEqual(offenses.length, 1);
  assert.strictEqual(offenses[0].kind, 'empty-args');
});

test('every Logger.fatal() call across .agents/scripts/ supplies a non-empty message', () => {
  const files = listJsFiles(SCRIPTS_DIR);
  assert.ok(
    files.length > 0,
    `expected at least one .js file under ${SCRIPTS_DIR}`,
  );
  const failures = [];
  for (const file of files) {
    const offenses = scanFileForBadFatal(file);
    if (offenses.length === 0) continue;
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    for (const o of offenses) {
      failures.push(`  ${rel}:${o.line}  [${o.kind}] ${o.text}`);
    }
  }
  assert.deepStrictEqual(
    failures,
    [],
    `Logger.fatal(...) must be called with a non-empty message. Without one the operator sees "❌ undefined" with no context for why the process is exiting.\n${failures.join('\n')}`,
  );
});

export {
  classifyFatalCall,
  LOGGER_FATAL_OPEN_RE,
  readArgList,
  scanFileForBadFatal,
  stripCommentsAndStrings,
};
