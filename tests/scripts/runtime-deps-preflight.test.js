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
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ensureRuntimeDepsInstalled } from '../../.agents/scripts/lib/runtime-deps/ensure-installed.js';
import { loadRuntimeDepsManifest } from '../../.agents/scripts/lib/runtime-deps/manifest.js';
import {
  checkRuntimeDeps,
  detectPackageManager,
  formatMissingDepsMessage,
} from '../../.agents/scripts/lib/runtime-deps/preflight.js';
import {
  extractThirdPartyImports,
  isValidPackageName,
  stripComments,
  toTopLevelPackage,
} from '../../.agents/scripts/lib/runtime-deps/scan-imports.js';

function tmpFile(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-rtdeps-'));
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
    assert.deepEqual(result, { ok: true, missing: [] });
  });

  it('collects the packages that fail to resolve', () => {
    const result = checkRuntimeDeps({
      required: ['ajv', 'minimatch', 'js-yaml'],
      resolve: (s) => {
        if (s === 'minimatch') throw new Error('MODULE_NOT_FOUND');
        return `/resolved/${s}`;
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['minimatch']);
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
    assert.deepEqual(result, { ok: true, missing: [] });
    assert.equal(exited, null);
    assert.equal(written, '');
  });

  it('writes a remediation message and exits 1 on a missing dep', () => {
    let exited = null;
    let written = '';
    ensureRuntimeDepsInstalled({
      requireResolve: (s) => {
        if (s === 'ajv') throw new Error('MODULE_NOT_FOUND');
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
    assert.match(stripComments(src), /https:\/\/example\.com/);
    assert.doesNotMatch(stripComments(src), /trailing comment/);
  });

  it('rejects invalid package names and collapses scopes', () => {
    assert.equal(isValidPackageName('ajv'), true);
    assert.equal(isValidPackageName('@scope/pkg'), true);
    assert.equal(isValidPackageName('Not A Package'), false);
    assert.equal(toTopLevelPackage('ajv/dist/2020.js'), 'ajv');
    assert.equal(toTopLevelPackage('@scope/pkg/sub'), '@scope/pkg');
  });
});
