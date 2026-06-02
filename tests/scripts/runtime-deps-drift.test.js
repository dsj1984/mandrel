/**
 * runtime-deps-drift.test — Story #3432
 *
 * Asserts the framework's vendored runtime-dependency manifest
 * (`.agents/runtime-deps.json`) stays honest against the actual third-party
 * imports under `.agents/scripts/**`:
 *
 *   1. Every third-party package imported by the framework scripts is
 *      declared in the manifest (the import-vs-manifest drift guard). If a
 *      new import is added without declaring it — or a declaration is
 *      removed while the import remains — this test fails.
 *   2. The manifest covers (at least) the eight required runtime packages
 *      named in the Story, and `minimatch` specifically is declared (the
 *      historical gap this Story closes).
 *   3. A negative control proves the drift comparison actually fails when a
 *      declaration is removed — i.e. the test is not vacuously green.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRuntimeDepsManifest } from '../../.agents/scripts/lib/runtime-deps/manifest.js';
import { scanThirdPartyImports } from '../../.agents/scripts/lib/runtime-deps/scan-imports.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');

// The required runtime packages the Story enumerates explicitly.
const REQUIRED_NAMED = [
  'ajv',
  'ajv-formats',
  'js-yaml',
  'minimatch',
  'picomatch',
  'string-argv',
  'typescript',
  'typhonjs-escomplex',
];

describe('runtime-deps drift', () => {
  it('declares every third-party import under .agents/scripts/**', () => {
    const { declared } = loadRuntimeDepsManifest();
    const { packages, byPackage } = scanThirdPartyImports(SCRIPTS_DIR);

    const undeclared = [...packages]
      .filter((pkg) => !declared.has(pkg))
      .map((pkg) => `${pkg} (imported by ${byPackage.get(pkg).join(', ')})`);

    assert.deepEqual(
      undeclared,
      [],
      `Undeclared third-party imports found. Add them to .agents/runtime-deps.json:\n${undeclared.join('\n')}`,
    );
  });

  it('covers the required runtime packages, including minimatch', () => {
    const { dependencies } = loadRuntimeDepsManifest();
    for (const pkg of REQUIRED_NAMED) {
      assert.ok(
        Object.hasOwn(dependencies, pkg),
        `expected ${pkg} in runtime-deps.json "dependencies"`,
      );
    }
    // The historical gap: minimatch was imported but never declared.
    assert.ok(dependencies.minimatch, 'minimatch must be declared');
  });

  it('fails the drift check when a declaration is removed (negative control)', () => {
    const { packages } = scanThirdPartyImports(SCRIPTS_DIR);
    assert.ok(packages.has('minimatch'), 'precondition: minimatch is imported');

    // Simulate a manifest that dropped `minimatch` while the import remains.
    const { declared } = loadRuntimeDepsManifest();
    const declaredWithoutMinimatch = new Set(
      [...declared].filter((pkg) => pkg !== 'minimatch'),
    );
    const undeclared = [...packages].filter(
      (pkg) => !declaredWithoutMinimatch.has(pkg),
    );

    assert.deepEqual(
      undeclared,
      ['minimatch'],
      'drift comparison must flag an imported-but-undeclared package',
    );
  });
});
