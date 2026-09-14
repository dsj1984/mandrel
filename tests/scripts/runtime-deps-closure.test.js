/**
 * runtime-deps closure — the manifest must describe what actually loads.
 *
 * Three properties, each of which was false before Story #5336:
 *
 *  1. The install-matrix mirror is the whole declared set, so the check that
 *     guards a consumer's manifest cannot silently stop covering a package.
 *  2. Every shareable exemption names a package the framework really declares,
 *     so an exemption cannot outlive the dependency it excuses.
 *  3. `babel-runtime` is declared even though no framework script imports it,
 *     because the metric-core packages require it and none of them declares
 *     it. That is the peer repair the closure exists to make explicit.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import {
  FRAMEWORK_RUNTIME_DEPS,
  SHAREABLE_RUNTIME_DEPS,
} from '../../.agents/scripts/install-matrix-assert.js';
import { loadRuntimeDepsManifest } from '../../.agents/scripts/lib/runtime-deps/manifest.js';
import { registry } from '../../lib/cli/registry.js';

const require = createRequire(import.meta.url);

describe('runtime-deps closure', () => {
  it('mirrors every declared dependency in the install-matrix list', () => {
    const { dependencies } = loadRuntimeDepsManifest();
    assert.deepEqual(
      [...FRAMEWORK_RUNTIME_DEPS].sort(),
      Object.keys(dependencies).sort(),
    );
  });

  it('exempts only packages the framework actually declares', () => {
    const { dependencies } = loadRuntimeDepsManifest();
    for (const pkg of SHAREABLE_RUNTIME_DEPS) {
      assert.ok(
        Object.hasOwn(dependencies, pkg),
        `${pkg} is exempted from the leak check but not declared`,
      );
    }
  });

  it('declares babel-runtime, which the metric core requires and never declares', () => {
    const { dependencies } = loadRuntimeDepsManifest();
    assert.ok(dependencies['babel-runtime']);
    for (const pkg of [
      'typhonjs-escomplex-commons',
      'escomplex-plugin-metrics-module',
      'escomplex-plugin-syntax-babylon',
    ]) {
      const manifest = require(`${pkg}/package.json`);
      assert.equal(
        manifest.dependencies?.['babel-runtime'],
        undefined,
        `${pkg} now declares babel-runtime — the peer repair may be redundant`,
      );
    }
  });

  it('no longer declares or resolves the displaced plumbing', () => {
    const { declared } = loadRuntimeDepsManifest();
    for (const pkg of [
      'typhonjs-escomplex',
      '@typhonjs/babel-parser',
      'typhonjs-escomplex-module',
      'typhonjs-escomplex-project',
      'typhonjs-plugin-manager',
    ]) {
      assert.ok(!declared.has(pkg), `${pkg} must not be declared`);
    }
  });

  it("doctor's runtime-deps check accepts a package resolvable only by its manifest", () => {
    // The regression this pins: the check probed bare specifiers only, so a
    // dependency with no `main` and no `exports` read as missing while it sat
    // installed — and `mandrel update` fails the run when doctor reports a
    // failure, so every consumer's upgrade would have broken.
    const check = registry.find((c) => c.name === 'runtime-deps');
    assert.ok(check, 'doctor must carry a runtime-deps check');
    const result = check.run({
      manifestRequired: ['main-less-pkg'],
      resolve: (specifier) => {
        if (specifier === 'main-less-pkg') {
          throw new Error('MODULE_NOT_FOUND');
        }
        return `/resolved/${specifier}`;
      },
    });
    assert.equal(result.ok, true, result.detail);
  });
});
