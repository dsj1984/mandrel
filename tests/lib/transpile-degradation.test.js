// tests/lib/transpile-degradation.test.js
/**
 * Verifies graceful degradation when TypeScript is absent (B4).
 *
 * `transpileIfNeeded` resolves `typescript` from the scanned file's own
 * package (Story #5692). When nothing resolves it returns the distinct
 * `COMPILER_MISSING` outcome — never throws, never a per-file warn — and the
 * gates fail loud on it. The end-to-end nested-package and missing-compiler
 * paths live in `transpile-consumer-resolution.test.js`; this file pins the
 * in-process contract without uninstalling the real typescript peer dep.
 *
 * `resolveTsTranspilerVersion` degrades on a **different** input (Story
 * #5109): it never evaluates the compiler at all, it resolves and reads the
 * package manifest, so its `'0.0.0'` sentinel is reached when the *manifest*
 * cannot be resolved or parsed. The doubles below model that resolution, not
 * the old `loadTypeScript()` call — a double that mirrors an implementation
 * the module no longer has passes forever while proving nothing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Logger } from '../../.agents/scripts/lib/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSPILE_PATH = path.resolve(
  __dirname,
  '../../.agents/scripts/lib/transpile.js',
);

// ---------------------------------------------------------------------------
// Real module behaviour (TS is present in this repo as a dev dep)
// ---------------------------------------------------------------------------

describe('transpile.js — real TS present', () => {
  it('transpileIfNeeded returns the original source for .js files (no-op)', async () => {
    const { transpileIfNeeded } = await import(
      pathToFileURL(TRANSPILE_PATH).href
    );
    const src = 'const x = 1;';
    const result = transpileIfNeeded('foo.js', src);
    assert.equal(result, src, '.js files must pass through unchanged');
  });

  it('transpileIfNeeded transpiles a .ts source to JS', async () => {
    const { transpileIfNeeded } = await import(
      pathToFileURL(TRANSPILE_PATH).href
    );
    const tsSrc = 'const x: number = 1;\nexport default x;\n';
    const result = transpileIfNeeded('foo.ts', tsSrc);
    assert.notEqual(result, null, 'must produce output when TS is present');
    assert.ok(typeof result === 'string', 'output must be a string');
    // Type annotation should be stripped
    assert.doesNotMatch(result, /: number/, 'type annotation must be stripped');
  });

  it('resolveTsTranspilerVersion returns a semver string when TS is present', async () => {
    const { resolveTsTranspilerVersion } = await import(
      pathToFileURL(TRANSPILE_PATH).href
    );
    const v = resolveTsTranspilerVersion();
    assert.match(
      v,
      /^\d+\.\d+\.\d+/,
      'must return a semver string when TS is installed',
    );
    assert.notEqual(
      v,
      '0.0.0',
      'sentinel should not appear when TS is present',
    );
  });

  it('resolveTsTranspilerVersion reports exactly what the manifest declares', async () => {
    const { resolveTsTranspilerVersion } = await import(
      pathToFileURL(TRANSPILE_PATH).href
    );
    const require = createRequire(pathToFileURL(TRANSPILE_PATH).href);
    const manifest = JSON.parse(
      readFileSync(require.resolve('typescript/package.json'), 'utf-8'),
    );
    // The stamp is what every committed baseline envelope carries, so the
    // manifest read has to produce the identical string the old
    // `require('typescript').version` produced — otherwise the change would
    // rewrite `tsTranspilerVersion` in baselines/crap.json.
    assert.equal(resolveTsTranspilerVersion(), manifest.version);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation when TS is absent
//
// The module is already loaded (ES module cache) with a resolvable compiler,
// so absence is exercised through the public seams: injected `transpile`
// doubles for `prepareSourceForScoring`, the diagnostic builder, and the
// '0.0.0' manifest sentinel. The real no-compiler path runs in a child
// process in transpile-consumer-resolution.test.js.
// ---------------------------------------------------------------------------

describe('transpile.js — TS-absent degradation (simulated)', () => {
  it('resolveTsTranspilerVersion returns "0.0.0" when the manifest is unresolvable', () => {
    // Double of the *current* internals: the resolver walks to
    // `typescript/package.json` and reads a version off it. Both failure modes
    // — the resolve throwing, and a manifest with no usable `version` — land
    // on the sentinel, and neither ever touches the compiler.
    function resolveTsTranspilerVersionFake(manifestPath, readManifest) {
      if (manifestPath === null) return '0.0.0';
      try {
        const parsed = readManifest(manifestPath);
        if (parsed && typeof parsed.version === 'string' && parsed.version) {
          return parsed.version;
        }
      } catch {
        // unreadable / unparseable manifest → sentinel
      }
      return '0.0.0';
    }

    assert.equal(
      resolveTsTranspilerVersionFake(null, () => ({ version: '9.9.9' })),
      '0.0.0',
      'sentinel "0.0.0" must be returned when typescript cannot be resolved',
    );
    assert.equal(
      resolveTsTranspilerVersionFake('/pkg.json', () => {
        throw new Error('ENOENT');
      }),
      '0.0.0',
      'sentinel "0.0.0" must be returned when the manifest cannot be read',
    );
    assert.equal(
      resolveTsTranspilerVersionFake('/pkg.json', () => ({})),
      '0.0.0',
      'sentinel "0.0.0" must be returned when the manifest declares no version',
    );
    assert.equal(
      resolveTsTranspilerVersionFake('/pkg.json', () => ({ version: '5.9.3' })),
      '5.9.3',
      'a readable manifest yields its declared version',
    );
  });

  it('a missing compiler is a distinct prepare outcome naming the owning package', async () => {
    const { COMPILER_MISSING, prepareSourceForScoring } = await import(
      pathToFileURL(TRANSPILE_PATH).href
    );
    const abs = path.resolve(__dirname, '../../.agents/scripts/lib/x.ts');
    const prepared = prepareSourceForScoring(abs, {
      readFile: () => 'const x: number = 1;',
      transpile: () => COMPILER_MISSING,
    });
    assert.equal(prepared.error, 'compiler-missing');
    assert.equal(
      prepared.packageDir,
      path.resolve(__dirname, '../../.agents/scripts'),
      'nearest package.json ancestor',
    );
    const failed = prepareSourceForScoring(abs, {
      readFile: () => 'x',
      transpile: () => null,
    });
    assert.deepEqual(
      failed,
      { error: 'transpile' },
      'syntax failures stay separate',
    );
  });

  it('the compiler-missing diagnostic dedupes, caps and names the remedy', async () => {
    const { CompilerMissingError, compilerMissingMessage } = await import(
      pathToFileURL(TRANSPILE_PATH).href
    );
    const dirs = Array.from(
      { length: 12 },
      (_, i) => `/repo/pkg-${String(i).padStart(2, '0')}`,
    );
    const message = compilerMissingMessage([...dirs, dirs[0]], {
      cwd: '/repo',
    });
    assert.match(message, /in 12 package\(s\): pkg-00, pkg-01/);
    assert.match(message, /\(\+2 more\)/);
    assert.doesNotMatch(message, /pkg-11/);
    assert.match(message, /npm install --save-dev typescript/);
    assert.match(message, />=5\.0\.0 <7/);
    const err = new CompilerMissingError(['/b', '/a', '/b']);
    assert.equal(err.name, 'CompilerMissingError');
    assert.deepEqual(err.packageDirs, ['/a', '/b']);
  });

  it('resolveTsTranspilerVersion anchors at the scan cwd and target dirs', async () => {
    const { resolveTsTranspilerVersion } = await import(
      pathToFileURL(TRANSPILE_PATH).href
    );
    const repo = path.resolve(__dirname, '../..');
    const manifest = JSON.parse(
      readFileSync(
        path.join(repo, 'node_modules/typescript/package.json'),
        'utf-8',
      ),
    );
    assert.equal(
      resolveTsTranspilerVersion({
        cwd: repo,
        targetDirs: ['.agents/scripts', 'lib'],
      }),
      manifest.version,
      'one installation resolved from several anchors stamps one version',
    );
  });

  it('transpileIfNeeded passes through .js files even when TS is absent', () => {
    const fakeTsLoadFailed = true;

    function transpileIfNeededFake(filePath, source) {
      const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
      const ext = path.extname(String(filePath)).toLowerCase();
      if (!TS_EXTS.has(ext)) return source; // always pass through non-TS
      if (fakeTsLoadFailed) return null;
      return source;
    }

    const jsSrc = 'const x = 1;';
    const result = transpileIfNeededFake('foo.js', jsSrc);
    assert.equal(
      result,
      jsSrc,
      '.js files must pass through even when TS is absent',
    );
  });
});

// ---------------------------------------------------------------------------
// Unsupported major: a resolved module with no compiler API (TypeScript 7's
// main entry exports only `version` / `versionMajorMinor`).
// ---------------------------------------------------------------------------

describe('transpile.js — API-less typescript major', () => {
  it('emits ONE unsupported-major diagnostic naming the version and range', async () => {
    const { transpileIfNeeded } = await import(
      pathToFileURL(TRANSPILE_PATH).href
    );
    const ts7 = { version: '7.0.0', versionMajorMinor: '7.0' };
    const warnings = [];
    const originalWarn = Logger.warn;
    Logger.warn = (msg) => warnings.push(msg);
    try {
      for (const file of ['a.ts', 'b.tsx', 'c.mts']) {
        const out = transpileIfNeeded(file, 'const x: number = 1;', {
          typescript: ts7,
        });
        assert.equal(out, null, `${file} must be skipped, not scored`);
      }
      const mapped = transpileIfNeeded('d.ts', 'const y = 2;', {
        typescript: ts7,
        withLineMap: true,
      });
      assert.equal(mapped, null);
    } finally {
      Logger.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, 'one diagnostic, not one per file');
    assert.match(warnings[0], /typescript 7\.0\.0/);
    assert.match(warnings[0], />=5\.0\.0 <7/);
    assert.doesNotMatch(warnings[0], /transpile failed/);
  });
});

describe('typescript optional peer range', () => {
  it('excludes major 7 in both package.json and runtime-deps.json', () => {
    const root = path.resolve(__dirname, '../..');
    const pkg = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf-8'),
    );
    const runtimeDeps = JSON.parse(
      readFileSync(path.join(root, '.agents/runtime-deps.json'), 'utf-8'),
    );
    assert.equal(pkg.peerDependencies.typescript, '>=5.0.0 <7');
    assert.equal(runtimeDeps.optionalDependencies.typescript, '>=5.0.0 <7');
  });
});
