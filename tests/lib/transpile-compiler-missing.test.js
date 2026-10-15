/**
 * In-process compiler-missing paths. A resolver patch refuses `typescript`
 * for every request issued from inside this repo, so a fixture outside it
 * has no compiler anywhere; the patch is installed before any resolution and
 * the per-anchor cache is private to this test process.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function refuseTypescript(request, parent, ...rest) {
  const from = parent?.filename ?? '';
  const wantsTs = request === 'typescript' || request.startsWith('typescript/');
  if (wantsTs && from.startsWith(REPO_ROOT)) {
    const err = new Error(`Cannot find module '${request}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
after(() => {
  Module._resolveFilename = originalResolve;
});

const { scoreFile } = await import(
  '../../.agents/scripts/lib/maintainability-engine.js'
);
const { calculateAll } = await import(
  '../../.agents/scripts/lib/maintainability-utils.js'
);
const { scanAndScore } = await import(
  '../../.agents/scripts/lib/crap-utils.js'
);
const { handleCrapWorkerMessage } = await import(
  '../../.agents/scripts/lib/workers/crap-worker.js'
);
const { CompilerMissingError, prepareSourceForScoring, transpileIfNeeded } =
  await import('../../.agents/scripts/lib/transpile.js');

const root = fs.realpathSync(makeTempDir('ts-compiler-missing-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'app', 'package.json'), '{"name":"app"}');
const tsFile = path.join(root, 'app', 'src', 'a.ts');
fs.writeFileSync(
  tsFile,
  'export function f(n: number): number {\n  return n;\n}\n',
);
const appDir = path.join(root, 'app');

describe('no resolvable compiler (in process)', () => {
  it('transpileIfNeeded and prepareSourceForScoring report it distinctly', () => {
    assert.equal(typeof transpileIfNeeded(tsFile, 'const a = 1;'), 'object');
    assert.deepEqual(prepareSourceForScoring(tsFile), {
      error: 'compiler-missing',
      packageDir: appDir,
    });
  });

  it('scoreFile flags the file with its package, not as a kernel gap', () => {
    const result = scoreFile(tsFile);
    assert.equal(result.compilerMissing, true);
    assert.equal(result.packageDir, appDir);
  });

  it('calculateAll throws one CompilerMissingError', async () => {
    await assert.rejects(calculateAll([tsFile]), (err) => {
      assert.ok(err instanceof CompilerMissingError);
      assert.deepEqual(err.packageDirs, [appDir]);
      return true;
    });
  });

  it('scanAndScore throws instead of dropping the file', async () => {
    await assert.rejects(
      scanAndScore({
        targetDirs: ['app'],
        coverage: null,
        requireCoverage: false,
        cwd: root,
      }),
      (err) => err instanceof CompilerMissingError && /app/.test(err.message),
    );
  });

  it('the CRAP worker replies compilerMissing for the host to fail on', () => {
    const out = handleCrapWorkerMessage(
      {
        item: { abs: tsFile, relPath: 'app/src/a.ts', requireCoverage: false },
      },
      null,
    );
    assert.equal(out.message.result.compilerMissing, true);
    assert.equal(out.message.result.packageDir, appDir);
  });
});
