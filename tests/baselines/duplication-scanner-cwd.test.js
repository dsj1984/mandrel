/**
 * jscpd 4 globs against process.cwd(), not its `cwd` option. Real jscpd over
 * two divergent trees pins that a scan reads the `cwd` tree only.
 */

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildDuplicationRows,
  collectVisitedFiles,
  readLineCount,
  resolveDetectClones,
  scanDuplication,
} from '../../.agents/scripts/lib/baselines/duplication-scanner.js';
import { jscpdFormatsFor } from '../../.agents/scripts/lib/source-extensions.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

function clonedSource(count, salt = '') {
  return Array.from(
    { length: count },
    (_, i) =>
      `export function compute${salt}${i}(alpha, beta) {\n` +
      `  const total = alpha * beta + ${i};\n` +
      '  if (total > 100) { return total - alpha; }\n' +
      `  return total + beta * ${i};\n` +
      '}\n',
  ).join('\n');
}

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

const toPosix = (p) => p.split(path.sep).join('/');

describe('scanDuplication — cwd differs from process.cwd() (Story #5636)', () => {
  const originalCwd = process.cwd();
  let scanTree;
  let procTree;

  beforeEach(() => {
    scanTree = realpathSync(makeTempDir('mandrel-dup-scan-'));
    procTree = realpathSync(makeTempDir('mandrel-dup-proc-'));
    writeTree(scanTree, {
      'src/a.js': clonedSource(6),
      'src/b.js': `${clonedSource(6)}\nexport const tail = 1;\n`,
      'src/__tests__/t.js': clonedSource(6),
    });
    writeTree(procTree, {
      'src/a.js': `${clonedSource(3, 'P')}\n${'// pad\n'.repeat(40)}`,
      'src/b.js': 'export const lonely = 1;\n',
      'src/x.js': clonedSource(6, 'X'),
      'src/y.js': clonedSource(6, 'X'),
      'src/__tests__/t.js': clonedSource(6),
    });
    process.chdir(procTree);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(scanTree, { recursive: true, force: true });
    rmSync(procTree, { recursive: true, force: true });
  });

  function scan(ignoreGlobs) {
    return scanDuplication({
      targetDirs: ['src'],
      cwd: scanTree,
      ignoreGlobs,
      detect: resolveDetectClones(),
    });
  }

  it('AC-1: clones and line counts come from the cwd tree only', async () => {
    const rows = await scan(['src/**/__tests__/**']);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    assert.deepEqual(Object.keys(byPath).sort(), ['src/a.js', 'src/b.js']);
    assert.equal(
      byPath['src/a.js'].totalLines,
      readLineCount(path.join(scanTree, 'src/a.js')),
    );
    assert.equal(
      byPath['src/b.js'].totalLines,
      readLineCount(path.join(scanTree, 'src/b.js')),
    );
    assert.ok(byPath['src/a.js'].duplicatedLines > 0);
  });

  it('AC-2: a repo-relative ignore glob still excludes its files', async () => {
    const unignored = (await scan([])).map((r) => r.path).sort();
    assert.ok(unignored.includes('src/__tests__/t.js'));
    const ignored = (await scan(['src/**/__tests__/**'])).map((r) => r.path);
    assert.equal(ignored.includes('src/__tests__/t.js'), false);
  });

  it('AC-2: absolute and **/-prefixed ignore globs behave as before', async () => {
    const absGlob = `${toPosix(scanTree)}/src/__tests__/**`;
    for (const glob of [absGlob, '**/__tests__/**']) {
      const rows = (await scan([glob])).map((r) => r.path).sort();
      assert.deepEqual(rows, ['src/a.js', 'src/b.js'], glob);
    }
  });

  it('AC-2: relative globs are anchored at cwd; others pass through', async () => {
    const seen = [];
    await scanDuplication({
      targetDirs: ['src'],
      cwd: scanTree,
      ignoreGlobs: ['src/**/__tests__/**', '**/gen/**', '/abs/**'],
      detect: async (opts) => {
        seen.push(opts);
        return [];
      },
    });
    assert.deepEqual(seen[0].path, [`${toPosix(scanTree)}/src`]);
    assert.deepEqual(seen[0].ignore, [
      `${toPosix(scanTree)}/src/**/__tests__/**`,
      '**/gen/**',
      '/abs/**',
    ]);
  });

  it('hands jscpd the formats derived from the scorable list (Story #5738)', async () => {
    const seen = [];
    await scanDuplication({
      targetDirs: ['src'],
      cwd: scanTree,
      detect: async (opts) => {
        seen.push(opts);
        return [];
      },
    });
    assert.deepEqual(seen[0].format, jscpdFormatsFor());
    assert.deepEqual(seen[0].format, [
      'javascript',
      'jsx',
      'typescript',
      'tsx',
    ]);
  });

  it('AC-3: when cwd === process.cwd(), rows match the relative-path scan', async () => {
    process.chdir(scanTree);
    const cwd = process.cwd();
    const ignore = ['src/**/__tests__/**'];
    const detect = resolveDetectClones();
    const rows = await scanDuplication({
      targetDirs: ['src'],
      cwd,
      ignoreGlobs: ignore,
      detect,
    });
    // The pre-#5636 call shape: relative dirs and globs handed to jscpd as-is.
    const clones = await detect({
      path: ['src'],
      cwd,
      silent: true,
      gitignore: false,
      reporters: [],
      format: jscpdFormatsFor(),
      minTokens: 50,
      ignore,
    });
    const counts = new Map(
      collectVisitedFiles(clones, cwd).map((rel) => [
        rel,
        readLineCount(path.resolve(cwd, rel)),
      ]),
    );
    assert.deepEqual(rows, buildDuplicationRows(clones, counts, cwd));
  });
});
