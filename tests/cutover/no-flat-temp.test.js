/**
 * Cutover smoke test — flat `temp/<artifact>-epic-<id>.<ext>` path absence.
 *
 * Asserts that no source file under `.agents/scripts/` writes to a flat
 * per-Epic temp path. Per Tech Spec #1032 (`tempRoot rationalization`,
 * AC13), every Epic-scoped artifact moves under `temp/epic-<id>/`. The
 * helper `lib/config/temp-paths.js` is the single canonical writer and
 * consumes this regex as its grep target.
 *
 * Fail-closed: any string literal in source matching the flat-temp regex
 * fails the suite, unless it appears on the explicit allowlist below.
 *
 * Allowlist conventions:
 *   - JSDoc / inline-comment references that *describe* the retired
 *     pattern (e.g. inside `temp-paths.js` or `plan-phase-cleanup.js`)
 *     are tolerated by exempting their files entirely.
 *   - Stray prose strings (CHANGELOG fixtures, doc-template literals)
 *     can be added to LITERAL_ALLOWLIST as exact substrings.
 *
 * The allowlist is an *exception* mechanism, not a default — leave it
 * empty unless a CI failure forces a deliberate carve-out.
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
// Allowlist — files whose flat-temp matches are documented references, not
// live writers. Keep this list minimal and document each entry inline.
// ---------------------------------------------------------------------------
const FILE_ALLOWLIST = new Set(
  [
    // The path-helper module's JSDoc describes the retired pattern as the
    // module's own grep target. Live writers route through its exports.
    '.agents/scripts/lib/config/temp-paths.js',
    // The plan-phase cleanup module documents which legacy paths it used
    // to reap as part of the migration narrative.
    '.agents/scripts/lib/plan-phase-cleanup.js',
  ].map((p) => p.split('/').join(path.sep)),
);

// Per-line literal allowlist — exact substring matches on a hit's `line`
// field exempt that single occurrence. Use sparingly.
const LITERAL_ALLOWLIST = [];

// ---------------------------------------------------------------------------
// File walker
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
// Scan — flat-temp regex per Task #1069 spec
// ---------------------------------------------------------------------------
const FLAT_TEMP_RE = /temp\/[^/]*-epic-[\w-]+\.(md|json|ndjson)/;

function scan(files) {
  const hits = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (FILE_ALLOWLIST.has(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!FLAT_TEMP_RE.test(line)) continue;
      if (LITERAL_ALLOWLIST.some((needle) => line.includes(needle))) continue;
      hits.push({ file: rel, line: line.trim(), lineNumber: i + 1 });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('cutover: no flat `temp/<artifact>-epic-<id>` paths', () => {
  const files = walkJsFiles(SCRIPTS_DIR);

  it('finds at least one .js file under .agents/scripts/ to scan', () => {
    assert.ok(
      files.length > 0,
      `Expected to find .js files under ${SCRIPTS_DIR}`,
    );
  });

  it('no source writes to a flat `temp/<artifact>-epic-<id>.<ext>` path', () => {
    const hits = scan(files);
    assert.equal(
      hits.length,
      0,
      `Found ${hits.length} flat-temp path reference(s). Use \`lib/config/temp-paths.js\` (epicTempDir / storyTempDir / signalsFile / ...) instead:\n${hits
        .map((h) => `  ${h.file}:${h.lineNumber}: ${h.line}`)
        .join('\n')}`,
    );
  });
});
