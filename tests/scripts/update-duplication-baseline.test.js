/**
 * update-duplication-baseline.test.js — Story #3664.
 *
 * Covers the duplication refresh CLI's parse→envelope path with the
 * scanner mocked:
 *   - The pure `buildDuplicationRows` folds jscpd clone pairs + per-file
 *     line counts into canonical rows (union of overlapping clone lines,
 *     both sides of each pair contribute).
 *   - `scanDuplication` walks `targetDirs` through an injected `detect`
 *     seam (no real jscpd) and an injected `readLineCount` seam (no disk),
 *     then projects rows.
 *   - The scanned rows flow through the shared writer (`write({ kind:
 *     'duplication' })`) and produce a schema-valid, kernel-stamped
 *     envelope — the same funnel the CLI uses.
 *   - The CLI source stays a thin wrapper over the scanner + shared writer
 *     (no inline jscpd parsing).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildDuplicationRows,
  collectVisitedFiles,
  relativisePath,
  scanDuplication,
} from '../../.agents/scripts/lib/baselines/duplication-scanner.js';
import { write } from '../../.agents/scripts/lib/baselines/writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'update-duplication-baseline.js',
);

function clone(fileA, startA, endA, fileB, startB, endB) {
  return {
    format: 'javascript',
    duplicationA: {
      sourceId: fileA,
      start: { line: startA },
      end: { line: endA },
    },
    duplicationB: {
      sourceId: fileB,
      start: { line: startB },
      end: { line: endB },
    },
  };
}

describe('duplication-scanner.buildDuplicationRows() (pure)', () => {
  it('unions overlapping clone line ranges on a single file', () => {
    const clones = [
      clone('src/a.js', 1, 5, 'src/b.js', 10, 14),
      // Overlaps lines 4-8 on src/a.js — line 4,5 must count once.
      clone('src/a.js', 4, 8, 'src/c.js', 1, 5),
    ];
    const counts = new Map([
      ['src/a.js', 100],
      ['src/b.js', 100],
      ['src/c.js', 100],
    ]);
    const rows = buildDuplicationRows(clones, counts, REPO_ROOT);
    const a = rows.find((r) => r.path === 'src/a.js');
    // Lines 1..8 unioned = 8 duplicated lines (not 5 + 5 = 10).
    assert.equal(a.duplicatedLines, 8);
    assert.equal(a.totalLines, 100);
    assert.equal(a.percentage, 8);
  });

  it('credits both sides of every clone pair', () => {
    const clones = [clone('src/a.js', 1, 3, 'src/b.js', 20, 22)];
    const counts = new Map([
      ['src/a.js', 50],
      ['src/b.js', 50],
    ]);
    const rows = buildDuplicationRows(clones, counts, REPO_ROOT);
    assert.equal(rows.find((r) => r.path === 'src/a.js').duplicatedLines, 3);
    assert.equal(rows.find((r) => r.path === 'src/b.js').duplicatedLines, 3);
  });

  it('records a 0% row for a visited-but-clean file', () => {
    const counts = new Map([['src/clean.js', 80]]);
    const rows = buildDuplicationRows([], counts, REPO_ROOT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].duplicatedLines, 0);
    assert.equal(rows[0].percentage, 0);
  });

  it('guards against a zero total-line denominator', () => {
    const clones = [clone('src/a.js', 1, 3, 'src/b.js', 1, 3)];
    const counts = new Map([['src/a.js', 0]]);
    const rows = buildDuplicationRows(clones, counts, REPO_ROOT);
    const a = rows.find((r) => r.path === 'src/a.js');
    assert.equal(a.percentage, 0);
  });
});

describe('duplication-scanner.relativisePath() (pure)', () => {
  it('relativises an absolute sourceId against cwd', () => {
    const abs = path.join(REPO_ROOT, 'src', 'a.js');
    assert.equal(relativisePath(abs, REPO_ROOT), 'src/a.js');
  });
  it('leaves an already-relative POSIX path untouched', () => {
    assert.equal(relativisePath('src/a.js', REPO_ROOT), 'src/a.js');
  });
});

describe('duplication-scanner.collectVisitedFiles() (pure)', () => {
  it('dedupes + sorts files across both clone sides', () => {
    const clones = [
      clone('src/b.js', 1, 2, 'src/a.js', 1, 2),
      clone('src/a.js', 5, 6, 'src/c.js', 1, 2),
    ];
    assert.deepEqual(collectVisitedFiles(clones, REPO_ROOT), [
      'src/a.js',
      'src/b.js',
      'src/c.js',
    ]);
  });
});

describe('scanDuplication() — injected detect + readLineCount seams', () => {
  it('parses mocked clones into canonical rows (no real jscpd, no disk)', async () => {
    const detectCalls = [];
    const detect = async (opts) => {
      detectCalls.push(opts);
      return [clone('src/a.js', 1, 10, 'src/b.js', 1, 10)];
    };
    const readLineCount = () => 100;
    const rows = await scanDuplication({
      targetDirs: ['src'],
      cwd: REPO_ROOT,
      detect,
      readLineCount,
    });
    // detect received the configured target dirs + a silent/no-reporter scan.
    assert.deepEqual(detectCalls[0].path, ['src']);
    assert.equal(detectCalls[0].silent, true);
    assert.deepEqual(detectCalls[0].reporters, []);
    const a = rows.find((r) => r.path === 'src/a.js');
    assert.equal(a.duplicatedLines, 10);
    assert.equal(a.totalLines, 100);
    assert.equal(a.percentage, 10);
  });

  it('rejects a non-function detect seam', async () => {
    await assert.rejects(
      () => scanDuplication({ targetDirs: ['src'], detect: null }),
      /detect must be a function/,
    );
  });
});

describe('duplication refresh — scanner rows flow through the shared writer', () => {
  it('produces a schema-valid, kernel-stamped envelope', async () => {
    const detect = async () => [clone('src/a.js', 1, 10, 'src/b.js', 1, 10)];
    const readLineCount = () => 100;
    const rows = await scanDuplication({
      targetDirs: ['src'],
      cwd: REPO_ROOT,
      detect,
      readLineCount,
    });
    // Same funnel the CLI uses: write({ kind: 'duplication', rows }).
    const envelope = write({ kind: 'duplication', rows });
    assert.equal(
      envelope.$schema,
      '.agents/schemas/baselines/duplication.schema.json',
    );
    assert.match(envelope.kernelVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(Object.hasOwn(envelope.rollup, '*'));
    assert.equal(envelope.rollup['*'].duplicatedLines, 20);
    assert.equal(envelope.rollup['*'].totalLines, 200);
    assert.equal(envelope.rollup['*'].percentage, 10);
    // Rows are canonicalised + sorted.
    assert.deepEqual(
      envelope.rows.map((r) => r.path),
      ['src/a.js', 'src/b.js'],
    );
  });
});

describe('update-duplication-baseline — thin CLI wrapper', () => {
  const source = readFileSync(CLI_PATH, 'utf8');

  it('imports scanDuplication from the scanner module', () => {
    assert.match(
      source,
      /import\s*\{[^}]*scanDuplication[^}]*\}\s*from\s*['"][^'"]*duplication-scanner\.js['"]/,
    );
  });

  it('routes persistence through the shared writer', () => {
    assert.match(source, /from\s*['"][^'"]*baselines\/writer\.js['"]/);
    assert.match(source, /write\(\{[\s\S]*kind:\s*'duplication'/);
  });

  it('does not re-implement jscpd clone parsing inline', () => {
    assert.doesNotMatch(source, /duplicationA|duplicationB/);
  });
});
