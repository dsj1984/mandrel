/**
 * Cutover smoke test — friction-comment surface removal.
 *
 * Asserts that no source file under `.agents/scripts/` references the
 * `structured:friction` comment marker or imports from the retired
 * `friction-emitter` module. Per Tech Spec #1032 ("Hard cutover validation"),
 * the per-event friction structured-comment surface is replaced by the
 * `story-perf-summary` / `epic-perf-report` aggregates; reintroducing either
 * grep target signals a regression.
 *
 * The test fails closed: any single file containing either pattern fails
 * the suite with the offending path + line.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, '.agents', 'scripts');

// ---------------------------------------------------------------------------
// File walker (exclude this test file itself + node_modules just in case)
// ---------------------------------------------------------------------------
function walkJsFiles(dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkJsFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Pattern scanner — returns [{ file, line, lineNumber }, ...]
// ---------------------------------------------------------------------------
function scan(files, pattern) {
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i])) {
        hits.push({
          file: path.relative(ROOT, file),
          line: lines[i].trim(),
          lineNumber: i + 1,
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('cutover: no per-event friction comment surface', () => {
  const files = walkJsFiles(SCRIPTS_DIR);

  it('finds at least one .js file under .agents/scripts/ to scan', () => {
    assert.ok(
      files.length > 0,
      `Expected to find .js files under ${SCRIPTS_DIR}`,
    );
  });

  it('no source references the `structured:friction` comment marker', () => {
    // Matches the literal marker used inside HTML comments
    // (`<!-- structured:friction -->`). The cutover replaces this with
    // `structured:story-perf-summary` / `structured:epic-perf-report`.
    const hits = scan(files, /structured:friction\b/);
    assert.equal(
      hits.length,
      0,
      `Found ${hits.length} reference(s) to the retired \`structured:friction\` marker:\n${hits
        .map((h) => `  ${h.file}:${h.lineNumber}: ${h.line}`)
        .join('\n')}`,
    );
  });

  it('no source imports from the retired `friction-emitter` module', () => {
    // Matches `import ... from '...friction-emitter...'` and
    // `require('...friction-emitter...')`. The module is deleted by the
    // cutover; any remaining import is a stale reference that will fail
    // at runtime.
    const hits = scan(files, /friction-emitter/);
    assert.equal(
      hits.length,
      0,
      `Found ${hits.length} reference(s) to the retired \`friction-emitter\` module:\n${hits
        .map((h) => `  ${h.file}:${h.lineNumber}: ${h.line}`)
        .join('\n')}`,
    );
  });
});
