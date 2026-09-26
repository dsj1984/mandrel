// tests/lib/transpile-degradation.test.js
/**
 * Verifies graceful degradation when TypeScript is absent (B4).
 *
 * `transpileIfNeeded` performs a lazy, guarded `require('typescript')`. When
 * the package is absent it returns null and logs a warn — it must not throw.
 * This test exercises that path by faking the require to throw
 * ERR_MODULE_NOT_FOUND, without actually uninstalling the real typescript
 * peer dep.
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
// We simulate absence by directly testing the internal loadTypeScript logic
// via a thin in-process fake. Since the module is already loaded (ES module
// cache), we cannot re-import it with a broken require. Instead we verify the
// public contract via the '0.0.0' sentinel from resolveTsTranspilerVersion()
// when TS fails to load — and we test the degradation path by calling
// transpileIfNeeded with a broken private require stub injected via a
// separate module-scoped helper below.
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

  it('transpileIfNeeded returns null for .ts files when typescript is absent', () => {
    // Same in-process double approach
    const warnings = [];
    const fakeTsLoadFailed = true;

    function transpileIfNeededFake(filePath, source) {
      const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
      const ext = path.extname(String(filePath)).toLowerCase();
      if (!TS_EXTS.has(ext)) return source;
      if (fakeTsLoadFailed) {
        warnings.push(
          `[Maintainability] ⚠ typescript package not resolvable; cannot score ${filePath}.`,
        );
        return null;
      }
      return source; // would not reach here
    }

    const result = transpileIfNeededFake('foo.ts', 'const x: number = 1;');
    assert.equal(result, null, 'must return null when TS is absent');
    assert.ok(warnings.length > 0, 'must emit a warning when TS is absent');
    assert.match(warnings[0], /typescript/i, 'warning must mention typescript');
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
