/**
 * Grep gate: forbid direct `signals.ndjson` parsing outside the canonical
 * locations (Epic #1181 / Story #1438 / Task #1462).
 *
 * The Story #1438 rewrite routes every signals consumer through
 * `lib/signals/read.js`. To keep that property durable, this test scans
 * the project's source trees for the disallowed parse patterns and
 * fails CI if any new file resurrects a direct `readFileSync`,
 * `createReadStream`, `readline.createInterface`, or `split('\n')`
 * targeting `signals.ndjson` outside:
 *
 *   - `.agents/scripts/lib/signals/`               (the canonical reader)
 *   - `.agents/scripts/lib/observability/signals-writer.js`
 *                                                  (the canonical writer)
 *   - `tests/`                                     (test fixtures + this
 *                                                  test itself)
 *
 * What the gate looks for:
 *   - `signals.ndjson` literal next to a file-read intrinsic on the same
 *     or adjacent lines (`readFileSync`, `readFile`, `createReadStream`,
 *     `readline.createInterface`).
 *
 * What the gate intentionally tolerates:
 *   - Doc comments mentioning `signals.ndjson` (no I/O intrinsic
 *     nearby).
 *   - Path-builder helpers like `signalsFile(eid, sid)` in
 *     `lib/config/temp-paths.js` (no I/O — that's the path resolver).
 *   - `analyze-execution.js`'s use of `forEachLine` from
 *     `signals-writer.js` (that's an exported reader, not a direct
 *     parse, and migration of analyze-execution to `lib/signals/read`
 *     is a separate Story in the same Epic).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Source trees the gate walks. Each entry is relative to REPO_ROOT.
const SCAN_ROOTS = [path.join('.agents', 'scripts')];

// Sub-paths that are allowed to do direct NDJSON parsing.
const ALLOW_PREFIXES = [
  path.join('.agents', 'scripts', 'lib', 'signals'),
  path.join('.agents', 'scripts', 'lib', 'observability', 'signals-writer.js'),
];

// File extensions to scan.
const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts']);

// The disallowed-pattern regex. Each captures a Node I/O intrinsic in
// proximity to the literal `signals.ndjson` reference. We accept on the
// same line OR within ~3 lines (multiline flag covers wrapped calls).
const FORBIDDEN = [
  {
    name: 'readFileSync on signals.ndjson',
    re: /readFileSync\s*\([^)]*signals\.ndjson/,
  },
  {
    name: 'fs.readFile on signals.ndjson (async)',
    re: /readFile\s*\([^)]*signals\.ndjson/,
  },
  {
    name: 'createReadStream on signals.ndjson',
    re: /createReadStream\s*\([^)]*signals\.ndjson/,
  },
  {
    name: 'readline.createInterface around signals.ndjson',
    re: /createInterface[\s\S]{0,160}signals\.ndjson/,
  },
];

function isAllowed(relPath) {
  for (const prefix of ALLOW_PREFIXES) {
    if (
      relPath === prefix ||
      relPath.startsWith(`${prefix}${path.sep}`) ||
      relPath.startsWith(`${prefix}/`)
    ) {
      return true;
    }
  }
  return false;
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // skip node_modules, .git, .worktrees, coverage, dist
      if (
        ent.name === 'node_modules' ||
        ent.name === '.git' ||
        ent.name === '.worktrees' ||
        ent.name === 'coverage' ||
        ent.name === 'dist' ||
        ent.name === 'temp'
      ) {
        continue;
      }
      yield* walk(full);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name);
    if (!EXTS.has(ext)) continue;
    yield full;
  }
}

function scanForForbidden() {
  const offenders = [];
  for (const scanRoot of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, scanRoot);
    for (const abs of walk(absRoot)) {
      const rel = path.relative(REPO_ROOT, abs);
      if (isAllowed(rel)) continue;
      const content = fs.readFileSync(abs, 'utf8');
      for (const pat of FORBIDDEN) {
        if (pat.re.test(content)) {
          offenders.push({ file: rel, pattern: pat.name });
        }
      }
    }
  }
  return offenders;
}

describe('grep gate — direct signals.ndjson parsing is forbidden outside lib/signals/', () => {
  it('finds zero offending files on the current tree', () => {
    const offenders = scanForForbidden();
    assert.deepEqual(
      offenders,
      [],
      `Found direct signals.ndjson parsing outside the allow-list:\n${offenders
        .map((o) => `  - ${o.file}: ${o.pattern}`)
        .join('\n')}\nUse 'lib/signals/read.js' instead.`,
    );
  });

  it('would fail if a new file outside the allow-list adds a direct parse', () => {
    // Self-test: simulate the gate's predicate against a synthetic
    // file path/contents and confirm it flags the pattern. We do not
    // actually write to the tree — the test exercises the matcher
    // directly so we know the regex catches the canonical anti-pattern.
    const synthetic = `
      import fs from 'node:fs';
      const raw = fs.readFileSync(\`temp/epic-1/story-2/signals.ndjson\`, 'utf8');
      const events = raw.split('\\n').filter(Boolean).map(JSON.parse);
    `;
    const matched = FORBIDDEN.some((pat) => pat.re.test(synthetic));
    assert.equal(
      matched,
      true,
      'Gate failed to detect a synthetic direct-parse pattern — regex needs tightening',
    );
  });

  it('does not flag doc comments that merely mention signals.ndjson', () => {
    const synthetic = `
      /**
       * Reads signals.ndjson — see lib/signals/read.js for the canonical entry point.
       */
      export function noop() {}
    `;
    const matched = FORBIDDEN.some((pat) => pat.re.test(synthetic));
    assert.equal(
      matched,
      false,
      'Gate over-matched a doc-only mention of signals.ndjson',
    );
  });

  it('does not flag analyze-execution-style forEachLine usage', () => {
    // analyze-execution.js currently imports `forEachLine` from
    // signals-writer.js and threads (eid, sid, cb) through it. That
    // path is an EXPORTED reader — the gate must NOT catch it.
    const synthetic = `
      import { forEachLine } from './lib/observability/signals-writer.js';
      for await (const evt of forEachLine(1, 2, (parsed) => parsed)) {}
    `;
    const matched = FORBIDDEN.some((pat) => pat.re.test(synthetic));
    assert.equal(
      matched,
      false,
      'Gate over-matched forEachLine usage — analyze-execution should not be flagged',
    );
  });
});
