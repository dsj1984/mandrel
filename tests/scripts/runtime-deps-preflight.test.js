/**
 * runtime-deps-preflight.test — Story #3432
 *
 * Exercises the dependency-presence preflight and its supporting pieces:
 *
 *   1. loadRuntimeDepsManifest — parses the SSOT, throws on missing/malformed.
 *   2. checkRuntimeDeps        — collects unresolvable required packages.
 *   3. detectPackageManager    — lockfile-driven manager detection.
 *   4. formatMissingDepsMessage— actionable remediation string.
 *   5. ensureRuntimeDepsInstalled — no-op on a healthy install; on a missing
 *      dep it writes the remediation message and exits non-zero (the
 *      fail-fast behaviour that replaces a raw ERR_MODULE_NOT_FOUND).
 *   6. scan-imports            — robust third-party import extraction, incl.
 *      comment stripping, scope/subpath collapse, and name validation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  checkRuntimeDeps,
  formatMismatchedDepsMessage,
  isResolvable,
} from '../../.agents/scripts/lib/runtime-deps/dep-resolution.js';
import { ensureRuntimeDepsInstalled } from '../../.agents/scripts/lib/runtime-deps/ensure-installed.js';
import { loadRuntimeDepsManifest } from '../../.agents/scripts/lib/runtime-deps/manifest.js';
import {
  detectPackageManager,
  formatMissingDepsMessage,
} from '../../.agents/scripts/lib/runtime-deps/preflight.js';
import {
  extractThirdPartyImports,
  isValidPackageName,
  toTopLevelPackage,
} from '../../.agents/scripts/lib/runtime-deps/scan-imports.js';
import { stripJsComments } from '../../.agents/scripts/lib/source-text/strip-js-comments.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

function tmpFile(name, body) {
  const dir = makeTempDir('mandrel-rtdeps-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('loadRuntimeDepsManifest', () => {
  it('parses the vendored manifest with required + optional sets', () => {
    const m = loadRuntimeDepsManifest();
    assert.ok(m.required.includes('ajv'));
    assert.ok(m.required.includes('minimatch'));
    assert.ok(m.declared.has('ajv'));
    // optional deps are declared but kept out of the required (preflight) set.
    assert.ok(m.optional.includes('chokidar'));
    assert.ok(!m.required.includes('chokidar'));
    assert.ok(m.declared.has('chokidar'));
  });

  it('throws when the manifest file is missing', () => {
    assert.throws(
      () => loadRuntimeDepsManifest('/no/such/runtime-deps.json'),
      /not found/,
    );
  });

  it('throws when the manifest JSON is malformed', () => {
    const file = tmpFile('runtime-deps.json', '{ not json');
    assert.throws(() => loadRuntimeDepsManifest(file), /not valid JSON/);
  });

  it('throws when the dependencies object is absent', () => {
    const file = tmpFile('runtime-deps.json', '{"optionalDependencies":{}}');
    assert.throws(
      () => loadRuntimeDepsManifest(file),
      /missing a "dependencies"/,
    );
  });
});

describe('checkRuntimeDeps', () => {
  it('is ok when every required package resolves', () => {
    const result = checkRuntimeDeps({
      required: ['ajv', 'minimatch'],
      resolve: (s) => `/resolved/${s}`,
    });
    assert.deepEqual(result, { ok: true, missing: [], mismatched: [] });
  });

  it('collects the packages that fail to resolve', () => {
    // An absent package resolves by neither its bare name nor its manifest
    // subpath, which is what a real `require.resolve` does — the presence
    // probe tries both, so a fake that throws on only one is not "absent".
    const result = checkRuntimeDeps({
      required: ['ajv', 'minimatch', 'js-yaml'],
      resolve: (s) => {
        if (s.startsWith('minimatch')) throw new Error('MODULE_NOT_FOUND');
        return `/resolved/${s}`;
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['minimatch']);
  });

  it('treats a package resolvable only by its manifest subpath as present', () => {
    // `typhonjs-escomplex-commons` and `babel-runtime` ship no `main` and no
    // `exports`, so the bare specifier does not resolve at all. Reporting
    // those as missing would exit the process over an installed package.
    const result = checkRuntimeDeps({
      required: ['babel-runtime'],
      resolve: (s) => {
        if (s === 'babel-runtime') throw new Error('MODULE_NOT_FOUND');
        return `/resolved/${s}`;
      },
    });
    assert.deepEqual(result, { ok: true, missing: [], mismatched: [] });
  });

  it('reports a resolved package whose major is outside the declared range', () => {
    const result = checkRuntimeDeps({
      required: ['@babel/parser'],
      resolve: (s) => `/resolved/${s}`,
      ranges: { '@babel/parser': '^7.29.3' },
      readVersion: () => '8.0.5',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.mismatched, [
      { name: '@babel/parser', required: '^7.29.3', resolved: '8.0.5' },
    ]);
  });

  it('stays silent when the range or the resolved version is unreadable', () => {
    // A conservative miss is a no-op; a false positive blocks a working
    // install, so an unparseable range and an unreadable version both pass.
    // Driven through checkRuntimeDeps because the comparison is module-local.
    const probe = (range, resolved) =>
      checkRuntimeDeps({
        required: ['p'],
        resolve: (s) => `/resolved/${s}`,
        ranges: { p: range },
        readVersion: () => resolved,
      }).mismatched.length;

    assert.equal(probe('*', '8.0.5'), 0, 'unparseable range');
    assert.equal(probe('^7.0.0', null), 0, 'unreadable version');
    assert.equal(probe('^7.0.0', '7.29.3'), 0, 'in-range');
    assert.equal(probe('^7.0.0', '8.0.0'), 1, 'out-of-range major');
  });

  it('probes the bare specifier before the manifest subpath', () => {
    const seen = [];
    isResolvable('some-pkg', (s) => {
      seen.push(s);
      throw new Error('MODULE_NOT_FOUND');
    });
    assert.deepEqual(seen, ['some-pkg', 'some-pkg/package.json']);
  });
});

describe('formatMismatchedDepsMessage', () => {
  it('names the package, both versions, and why pinning is the remedy', () => {
    const msg = formatMismatchedDepsMessage(
      [{ name: '@babel/parser', required: '^7.29.3', resolved: '8.0.5' }],
      { root: '/consumer' },
    );
    assert.match(msg, /version mismatch/);
    assert.match(msg, /@babel\/parser: need \^7\.29\.3, resolved 8\.0\.5/);
    assert.match(msg, /\/consumer/);
    // The remedy is a pin, not an install — the package is already there.
    assert.match(msg, /Pin a/);
    assert.doesNotMatch(msg, /npm install/);
  });
});

describe('detectPackageManager', () => {
  it('prefers pnpm, then yarn, then npm', () => {
    assert.equal(
      detectPackageManager('/r', (p) => p.endsWith('pnpm-lock.yaml')),
      'pnpm',
    );
    assert.equal(
      detectPackageManager('/r', (p) => p.endsWith('yarn.lock')),
      'yarn',
    );
    assert.equal(
      detectPackageManager('/r', () => false),
      'npm',
    );
  });
});

describe('formatMissingDepsMessage', () => {
  it('names the missing packages, root, and install command', () => {
    const msg = formatMissingDepsMessage(['ajv', 'minimatch'], {
      root: '/consumer',
      packageManager: 'pnpm',
    });
    assert.match(msg, /not installed/);
    assert.match(msg, /ajv, minimatch/);
    assert.match(msg, /pnpm install/);
    // The other two arms of installCommand.
    assert.match(
      formatMissingDepsMessage(['ajv'], { root: '/c', packageManager: 'yarn' }),
      /yarn install/,
    );
    assert.match(
      formatMissingDepsMessage(['ajv'], { root: '/c', packageManager: 'npm' }),
      /npm install/,
    );
    assert.match(msg, /\/consumer/);
    assert.match(msg, /runtime-deps\.json/);
  });
});

describe('ensureRuntimeDepsInstalled', () => {
  it('no-ops when all required deps resolve', () => {
    let exited = null;
    let written = '';
    const result = ensureRuntimeDepsInstalled({
      requireResolve: (s) => `/resolved/${s}`,
      cwd: '/consumer',
      stderr: { write: (s) => (written += s) },
      exit: (c) => (exited = c),
      manifest: { required: ['ajv', 'minimatch'] },
    });
    assert.deepEqual(result, { ok: true, missing: [], mismatched: [] });
    assert.equal(exited, null);
    assert.equal(written, '');
  });

  it('writes a remediation message and exits 1 on a missing dep', () => {
    let exited = null;
    let written = '';
    ensureRuntimeDepsInstalled({
      requireResolve: (s) => {
        // Absent by every specifier, bare name and manifest subpath alike —
        // the presence probe tries both.
        if (s.startsWith('ajv')) throw new Error('MODULE_NOT_FOUND');
        return `/resolved/${s}`;
      },
      cwd: '/consumer',
      stderr: { write: (s) => (written += s) },
      exit: (c) => (exited = c),
      manifest: { required: ['ajv', 'minimatch'] },
    });
    assert.equal(exited, 1);
    assert.match(written, /Framework runtime dependencies are not installed/);
    assert.match(written, /ajv/);
  });

  it('reads the resolved version through its own resolver when none is injected', () => {
    // Exercises the default readVersion path — the real resolver against the
    // real tree — which every other case bypasses by injecting one. The tree
    // is healthy here, so the assertion is that it resolves and stays silent.
    let written = '';
    let exited = null;
    const result = ensureRuntimeDepsInstalled({
      cwd: process.cwd(),
      stderr: { write: (s) => (written += s) },
      exit: (c) => (exited = c),
    });
    assert.equal(result.ok, true, written);
    assert.deepEqual(result.mismatched, []);
    assert.equal(exited, null);
    assert.equal(written, '');
  });

  it('stays inert (ok, no exit) when the manifest cannot be loaded', () => {
    let exited = null;
    const result = ensureRuntimeDepsInstalled({
      requireResolve: () => {
        throw new Error('should not be called');
      },
      exit: (c) => (exited = c),
      manifest: null,
    });
    assert.deepEqual(result, { ok: true, missing: [] });
    assert.equal(exited, null);
  });
});

describe('scan-imports extraction', () => {
  it('detects static, side-effect, require, and dynamic-import forms', () => {
    const src = [
      "import ajv from 'ajv';",
      "export { x } from 'ajv-formats';",
      "import 'string-argv';",
      "const y = require('js-yaml');",
      "const z = await import('picomatch');",
    ].join('\n');
    const found = extractThirdPartyImports(src);
    assert.deepEqual([...found].sort(), [
      'ajv',
      'ajv-formats',
      'js-yaml',
      'picomatch',
      'string-argv',
    ]);
  });

  it('ignores builtins, relative, and subpath-imports collapse to top-level', () => {
    const src = [
      "import fs from 'node:fs';",
      "import path from 'path';",
      "import local from './local.js';",
      "import sub from 'ajv/dist/2020.js';",
      "import scoped from '@commitlint/load';",
    ].join('\n');
    const found = extractThirdPartyImports(src);
    assert.deepEqual([...found].sort(), ['@commitlint/load', 'ajv']);
  });

  it('does not register import syntax that appears inside comments', () => {
    const src = [
      "// require('phantom-pkg') is just an example in a comment",
      "/* import x from 'another-phantom'; */",
      "import real from 'minimatch';",
    ].join('\n');
    const found = extractThirdPartyImports(src);
    assert.deepEqual([...found], ['minimatch']);
  });

  it('preserves string literals (URLs with //) while stripping comments', () => {
    const src = "const url = 'https://example.com'; // trailing comment";
    assert.match(stripJsComments(src), /https:\/\/example\.com/);
    assert.doesNotMatch(stripJsComments(src), /trailing comment/);
  });

  it('rejects invalid package names and collapses scopes', () => {
    assert.equal(isValidPackageName('ajv'), true);
    assert.equal(isValidPackageName('@scope/pkg'), true);
    assert.equal(isValidPackageName('Not A Package'), false);
    assert.equal(toTopLevelPackage('ajv/dist/2020.js'), 'ajv');
    assert.equal(toTopLevelPackage('@scope/pkg/sub'), '@scope/pkg');
  });
});
