import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanAndScore } from '../.agents/scripts/lib/crap-utils.js';

/**
 * Acceptance criterion (Story #829, 5.29.0): when scoring a `.tsx`
 * source whose coverage entry is keyed on the original `.tsx` path,
 * CRAP must resolve coverage correctly at the FILE-PATH level. The
 * transpile is in-memory only — vitest's `coverage-final.json` keys on
 * the source file, never the transpiled output, so the original path is
 * what the lookup must use.
 *
 * Note on line numbers: `ts.transpileModule` does NOT preserve line
 * numbers verbatim. JSX runtime imports add a line at the top of TSX
 * output, and interface elision shifts subsequent code in plain TS. So
 * escomplex's per-method `lineStart` will not generally match the
 * source line number recorded in the coverage entry. The per-method
 * lookup absorbs the drift via `compareCrap`'s line-drift fallback
 * (same file + method, nearest startLine wins). For this test we lay
 * the coverage entry at the TRANSPILED line number escomplex actually
 * reports, so we can verify the end-to-end path resolves a non-null
 * coverage value.
 */

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crap_tsx_'));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

const TSX_SOURCE = `interface Props { name: string; count: number; }

export function Greeting({ name, count }: Props): JSX.Element {
  if (count > 0) {
    return <div className="hi">Hello {name} ({count})</div>;
  }
  if (count < 0) {
    return <div className="oops">Negative {name}</div>;
  }
  return <div>Hello {name}</div>;
}
`;

/**
 * Build a coverage-final.json entry whose statements map covers the body
 * of `Greeting` (declared at line 3 in TSX_SOURCE). The entry uses the
 * absolute file path as its key field — vitest writes absolute paths in
 * `coverage-final.json` by default; the loader/resolver normalises by
 * suffix match.
 */
function coverageEntryForGreeting(absPath, methodStartLine) {
  const total = 8;
  const covered = total; // 100% coverage so coverage > 0 → non-null
  const statementMap = {};
  const s = {};
  for (let i = 0; i < total; i += 1) {
    statementMap[String(i)] = {
      start: { line: methodStartLine + 1 + i, column: 0 },
      end: { line: methodStartLine + 1 + i, column: 10 },
    };
    s[String(i)] = i < covered ? 1 : 0;
  }
  return {
    [absPath]: {
      path: absPath,
      fnMap: {
        0: {
          name: 'Greeting',
          decl: { start: { line: methodStartLine, column: 0 } },
          loc: {
            start: { line: methodStartLine, column: 0 },
            end: { line: methodStartLine + total + 2, column: 1 },
          },
          line: methodStartLine,
        },
      },
      f: { 0: 1 },
      statementMap,
      s,
      branchMap: {},
      b: {},
    },
  };
}

test('scanAndScore — TSX source resolves coverage keyed on original .tsx path', async () => {
  const dir = mkTmp();
  try {
    const tsxPath = path.join(dir, 'Greeting.tsx');
    fs.writeFileSync(tsxPath, TSX_SOURCE);

    // After ts.transpileModule with JsxEmit.ReactJSX, Greeting moves
    // from source line 3 to transpiled line 2 (the runtime import is
    // injected at line 1). Lay the coverage entry at line 2 so the
    // per-method lookup actually matches what escomplex reports.
    const coverage = coverageEntryForGreeting(tsxPath, 2);

    const result = await scanAndScore({
      targetDirs: [dir],
      coverage,
      requireCoverage: true,
      cwd: dir,
    });

    // The file-path lookup hit even though the entry key is the
    // absolute .tsx path — proves no key mismatch from the transpile.
    assert.strictEqual(result.skippedFilesNoCoverage, 0);
    // Greeting function is scored.
    assert.ok(
      result.rows.length >= 1,
      `expected ≥1 row; got ${result.rows.length}`,
    );
    // The path stored in the row is the original .tsx path (POSIX).
    for (const row of result.rows) {
      assert.match(row.file, /\.tsx$/, 'rows must use original TSX path');
      assert.notStrictEqual(
        row.coverage,
        null,
        'coverage must resolve via TSX key',
      );
      assert.ok(row.coverage >= 0 && row.coverage <= 1);
    }
  } finally {
    rmTmp(dir);
  }
});

test('scanAndScore — TSX source without coverage entry is skipped under requireCoverage=true', async () => {
  const dir = mkTmp();
  try {
    const tsxPath = path.join(dir, 'NoCov.tsx');
    fs.writeFileSync(tsxPath, TSX_SOURCE);

    // Coverage map deliberately empty — verifies the file path filter
    // and skip path treat .tsx the same as .js.
    const result = await scanAndScore({
      targetDirs: [dir],
      coverage: {},
      requireCoverage: true,
      cwd: dir,
    });
    assert.strictEqual(result.skippedFilesNoCoverage, 1);
    assert.strictEqual(result.rows.length, 0);
  } finally {
    rmTmp(dir);
  }
});
