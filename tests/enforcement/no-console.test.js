/**
 * tests/enforcement/no-console.test.js
 *
 * Enforces that scripts under `.agents/scripts/` route human-facing log lines
 * through `Logger.{info,warn,error}` rather than calling `console.{log,warn,error}`
 * directly. Routing all chatter through one logger gives the framework
 * uniform prefixes, level-based filtering (`AGENT_LOG_LEVEL=silent`), and a
 * single seam for tests to silence in CI.
 *
 * Allowlisted exceptions (kept as `console.*` on purpose):
 *
 *   - `lib/Logger.js`            — the `console.*` impl; the very thing
 *                                   every other call has to delegate to.
 *   - `lib/cli-utils.js`         — sanctioned CLI exit wrapper. Mirrors the
 *                                   `process.exit` carve-out in
 *                                   `tests/enforcement/process-exit.test.js`.
 *   - `check-windows-git-perf.js` — explicitly stdlib-only top-level script
 *                                   (see the `cli-opt-out` comment in that
 *                                   file). Importing Logger would violate
 *                                   the "no new dependencies" contract the
 *                                   script documents.
 *   - `lib/orchestration/error-journal.js` — emits `::add-mask::<value>`
 *                                   GitHub Actions workflow commands; the
 *                                   runner only parses these when the
 *                                   directive is the literal first content
 *                                   of a line, so the Logger prefix would
 *                                   defeat masking.
 *
 * Machine-parsable stdout (e.g. the JSON envelopes emitted by
 * `lint-baseline.js` and `check-crap.js --json`) is not an exception to this
 * rule because that path uses `process.stdout.write`, not `console.log`. The
 * test does NOT flag `process.stdout.write` / `process.stderr.write`; those
 * are the correct escape hatch for structured output that downstream tools
 * pipe and parse.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_ROOT = path.join(REPO_ROOT, '.agents', 'scripts');

// Paths are POSIX-style relative to `.agents/scripts/`. New entries MUST be
// accompanied by a justification comment naming the boundary the file
// represents — drift here is the whole reason this test exists.
const ALLOWLIST = new Set([
  // Logger implementation — must route to console.{log,warn,error}.
  'lib/Logger.js',
  // CLI exit / fatal-error wrapper. Sanctioned in process-exit.test.js too.
  'lib/cli-utils.js',
  // Stdlib-only optional perf check; opts out of any framework dependency.
  'check-windows-git-perf.js',
  // Emits ::add-mask:: GitHub Actions workflow commands that must be the
  // literal first content of a stdout line; Logger prefix would break them.
  'lib/orchestration/error-journal.js',
]);

const CONSOLE_RE = /\bconsole\s*\.\s*(?:log|warn|error)\b/;

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Scrub comments and string literals from a JS source while preserving line
 * count, so a line-by-line scan matches real code without tripping on JSDoc
 * mentions like "fall back to console.log" or string literals like
 * `'do not console.warn'`. Same pragma the sibling `process-exit.test.js`
 * uses — quick-and-dirty by design.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
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
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
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

function scanFileForBareConsole(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const cleaned = stripCommentsAndStrings(content);
  const cleanedLines = cleaned.split(/\r?\n/);
  const rawLines = content.split(/\r?\n/);
  const offenses = [];
  for (let i = 0; i < cleanedLines.length; i += 1) {
    if (CONSOLE_RE.test(cleanedLines[i])) {
      offenses.push({ line: i + 1, text: rawLines[i].trim() });
    }
  }
  return offenses;
}

test('ALLOWLIST entries exist on disk', () => {
  for (const rel of ALLOWLIST) {
    const full = path.join(SCRIPTS_ROOT, rel);
    assert.ok(
      fs.existsSync(full),
      `Allowlisted file ${rel} not found at ${full}. Update ALLOWLIST to match the current path.`,
    );
  }
});

test('stripCommentsAndStrings: ignores console.log mentions in line comments', () => {
  const sample = '  // console.log(x) — for reference only';
  assert.strictEqual(CONSOLE_RE.test(stripCommentsAndStrings(sample)), false);
});

test('stripCommentsAndStrings: ignores console.warn inside JSDoc blocks', () => {
  const sample =
    '/**\n * Falls back to console.warn when Logger is unavailable.\n */\nexport function foo() {}';
  assert.strictEqual(CONSOLE_RE.test(stripCommentsAndStrings(sample)), false);
});

test('stripCommentsAndStrings: ignores console.error inside string literals', () => {
  const sample = "  throw new Error('do not call console.error here');";
  assert.strictEqual(CONSOLE_RE.test(stripCommentsAndStrings(sample)), false);
});

test('stripCommentsAndStrings: still flags real console.log / console.warn / console.error calls', () => {
  for (const sample of [
    '  console.log("x");',
    '  console.warn(`y`);',
    '  console.error(z);',
    '  const log = console.log;',
  ]) {
    assert.strictEqual(
      CONSOLE_RE.test(stripCommentsAndStrings(sample)),
      true,
      `expected to flag: ${sample}`,
    );
  }
});

test('scripts under .agents/scripts/ do not call console.{log,warn,error} outside the allowlist', () => {
  const files = listJsFiles(SCRIPTS_ROOT);
  assert.ok(
    files.length > 0,
    `expected at least one .js file under ${SCRIPTS_ROOT}`,
  );
  const failures = [];
  for (const file of files) {
    const rel = path.relative(SCRIPTS_ROOT, file).split(path.sep).join('/');
    if (ALLOWLIST.has(rel)) continue;
    const offenses = scanFileForBareConsole(file);
    if (offenses.length === 0) continue;
    for (const o of offenses) {
      failures.push(`  .agents/scripts/${rel}:${o.line}  ${o.text}`);
    }
  }
  assert.deepStrictEqual(
    failures,
    [],
    `Scripts must route human-facing log output through Logger.{info,warn,error} rather than console.{log,warn,error}.\nFor machine-parsable stdout (JSON envelopes etc.) use process.stdout.write directly.\nIf a new sanctioned boundary is genuinely needed, add it to ALLOWLIST with a justification comment.\n${failures.join('\n')}`,
  );
});

export {
  ALLOWLIST,
  CONSOLE_RE,
  scanFileForBareConsole,
  stripCommentsAndStrings,
};
