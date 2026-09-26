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
 *     envelope — the funnel the refresh service drives on the CLI's behalf.
 *   - The CLI source stays a thin wrapper (no inline jscpd parsing).
 *
 * Story #4944 re-pointed the CLI-wrapper block: the CLI no longer calls the
 * writer itself. It dispatches `refreshBaseline({ kind: 'duplication' })`
 * like its three siblings, so the invariants asserted here mirror
 * `update-maintainability-baseline.test.js` — including the negative one
 * that the CLI must NOT reach for `writer.write` / `writeFile` /
 * `buildWriterScopeArgs` directly.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rollupOfRows } from '../../.agents/scripts/lib/audit-baselines/rollup.js';
import {
  buildDuplicationRows,
  collectVisitedFiles,
  relativisePath,
  resolveDetectClones,
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

  it('never widens an inverted clone side (end.line < start.line) into a span', () => {
    // Shape observed from real jscpd 4 output: one side of the pair reports
    // start 341 / end 161 while its partner spans 7 lines. Widening to
    // [161, 341] recorded 181 phantom lines; the inverted side counts nothing.
    const clones = [
      clone('scripts/scope.js', 341, 161, 'lib/other.js', 47, 53),
      clone('scripts/scope.js', 89, 95, 'lib/other.js', 10, 16),
    ];
    const counts = new Map([
      ['scripts/scope.js', 362],
      ['lib/other.js', 100],
    ]);
    const rows = buildDuplicationRows(clones, counts, REPO_ROOT);
    const scope = rows.find((r) => r.path === 'scripts/scope.js');
    const other = rows.find((r) => r.path === 'lib/other.js');
    assert.equal(scope.duplicatedLines, 7, 'only the well-formed 89-95 side');
    assert.equal(other.duplicatedLines, 14, 'both partner sides still count');
  });
});

describe('duplication-scanner.resolveDetectClones()', () => {
  it('names the resolved version and the supported major when detectClones is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jscpd-v5-'));
    try {
      const manifest = path.join(dir, 'package.json');
      writeFileSync(
        manifest,
        JSON.stringify({ name: 'jscpd', version: '5.0.2' }),
      );
      const fakeRequire = Object.assign(() => ({ version: '5.0.2' }), {
        resolve: () => manifest,
      });
      assert.throws(
        () => resolveDetectClones(fakeRequire),
        (err) => {
          assert.match(err.message, /jscpd 5\.0\.2/);
          assert.match(err.message, /\^4/);
          assert.doesNotMatch(err.message, /npm install'/);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns detectClones from a supported jscpd', () => {
    const detectClones = async () => [];
    const fakeRequire = Object.assign(() => ({ detectClones }), {
      resolve: () => {
        throw new Error('unused');
      },
    });
    assert.equal(resolveDetectClones(fakeRequire), detectClones);
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
    // No committed rollup (Story #5400): readers derive it from the rows.
    assert.equal(Object.hasOwn(envelope, 'rollup'), false);
    const rollup = rollupOfRows('duplication', envelope.rows);
    assert.equal(rollup.duplicatedLines, 20);
    assert.equal(rollup.totalLines, 200);
    assert.equal(rollup.percentage, 10);
    // Rows are canonicalised + sorted.
    assert.deepEqual(
      envelope.rows.map((r) => r.path),
      ['src/a.js', 'src/b.js'],
    );
  });
});

describe('update-duplication-baseline — thin CLI wrapper (Story #4944)', () => {
  const source = readFileSync(CLI_PATH, 'utf8');

  it('AC: routes persistence through refreshBaseline()', () => {
    assert.match(
      source,
      /import\s*\{[^}]*refreshBaseline[^}]*\}\s*from\s*['"][^'"]*refresh-service\.js['"]/,
      'CLI must import refreshBaseline from the refresh service',
    );
    assert.match(
      source,
      /refreshBaseline\(/,
      'CLI must call refreshBaseline()',
    );
  });

  it('AC: dispatches the duplication kind to the service', () => {
    assert.match(
      source,
      /kind:\s*['"]duplication['"]/,
      "CLI must pass kind: 'duplication' to the service",
    );
  });

  it('AC: parses --diff-scope via the shared CLI helper', () => {
    assert.match(
      source,
      /parseDiffScopeFlag/,
      'CLI must parse --diff-scope using the shared diff-scope-cli helper',
    );
  });

  it('AC: parses --full-scope explicitly (boolean opt-out flag)', () => {
    assert.match(
      source,
      /argv\.includes\(\s*['"]--full-scope['"]\s*\)/,
      'CLI must inspect argv for --full-scope',
    );
  });

  it('AC: --full-scope branches set fullScope=true on refreshBaseline opts', () => {
    assert.match(
      source,
      /if\s*\(\s*fullScope\s*\)\s*\{\s*refreshOpts\.fullScope\s*=\s*true\s*;/,
      'CLI must set refreshOpts.fullScope=true only when --full-scope is supplied',
    );
  });

  it('AC: no flag → no unconditional fullScope assignment (diff-scoped default)', () => {
    // The USAGE summary promises a diff-scoped default. An unconditional
    // `refreshOpts.fullScope = true` would silently restore the pre-#4944
    // full-rewrite behaviour while the help text kept claiming otherwise —
    // exactly the doc/behaviour split this Story closed.
    const fullScopeAssignments = [
      ...source.matchAll(/refreshOpts\.fullScope\s*=\s*true/g),
    ];
    assert.equal(
      fullScopeAssignments.length,
      1,
      `Expected exactly one refreshOpts.fullScope=true assignment (the --full-scope branch), found ${fullScopeAssignments.length}`,
    );
  });

  it('AC: --diff-scope <ref> surfaces the ref as baseRef on refreshBaseline opts', () => {
    assert.match(
      source,
      /refreshOpts\.baseRef\s*=\s*diffScopeRef\b/,
      'CLI must pass the --diff-scope ref through as baseRef',
    );
  });

  it('AC: --diff-scope and --full-scope are mutually exclusive (CLI rejects both)', () => {
    assert.match(
      source,
      /fullScope\s*&&\s*diffScopeRef\s*!==\s*null/,
      'CLI must reject the combination of --diff-scope and --full-scope',
    );
  });

  it('AC: retains the --baseline <path> override', () => {
    assert.match(
      source,
      /'--baseline'/,
      'CLI must still honour --baseline <path> (its one non-shared flag)',
    );
  });

  it('AC: does NOT call kind-internal envelope writers directly', () => {
    // refresh-service is the only legitimate caller of writer.write /
    // writer.writeFile / the legacy scope-args helper. Story #4944 removed
    // the last of them from this CLI.
    const forbidden = [
      /\bwrite\s*\(\s*\{\s*kind:/, // writer.write({ kind: ... })
      /\bwriteFile\s*\(/,
      /\bsaveBaseline\s*\(/,
      /\bbuildWriterScopeArgs\s*\(/, // legacy scope-args helper
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        source,
        pattern,
        `CLI must not call ${pattern.source} directly — go through refreshBaseline()`,
      );
    }
  });

  it('does not re-implement jscpd clone parsing inline', () => {
    assert.doesNotMatch(source, /duplicationA|duplicationB/);
  });
});
