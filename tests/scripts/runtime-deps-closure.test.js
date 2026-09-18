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
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadRuntimeDepsManifest } from '../../.agents/scripts/lib/runtime-deps/manifest.js';
import { extractThirdPartyImports } from '../../.agents/scripts/lib/runtime-deps/scan-imports.js';
import { registry } from '../../lib/cli/registry.js';
import {
  checkManifestClean,
  FRAMEWORK_RUNTIME_DEPS,
  SHAREABLE_RUNTIME_DEPS,
} from '../../scripts/install-matrix-assert.js';

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

  it('nothing in the tree imports a displaced package', () => {
    // Story #5336's first CI red: a test still imported typhonjs-escomplex and
    // passed locally anyway, because a worktree's module walk-up escapes into
    // the parent checkout where the removed package still sits installed. CI's
    // fresh clone has no such parent. Asserting the source text closes that
    // gap on every host — the tree, not the resolver, is the evidence.
    const displaced = [
      'typhonjs-escomplex',
      '@typhonjs/babel-parser',
      'typhonjs-plugin-manager',
      'typhonjs-escomplex-module',
      'typhonjs-escomplex-project',
    ];
    const pattern = new RegExp(
      `(?:from\\s*|require\\(\\s*)['"](?:${displaced
        .map((d) => d.replace(/[/.]/g, '\\$&'))
        .join('|')})['"]`,
    );
    const root = path.resolve(import.meta.dirname, '../..');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.git'))
          continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          /\.(m?js)$/.test(entry.name) &&
          pattern.test(fs.readFileSync(full, 'utf8'))
        ) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    for (const top of ['tests', 'lib', 'bin', '.agents'])
      walk(path.join(root, top));
    assert.deepEqual(offenders, [], 'files importing a displaced package');
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

  it('passes a consumer that declares a shareable dep, trips on a framework-internal one', () => {
    // The check exists to catch a consumer manifest being written into with
    // framework-internal packages. That inference only holds for packages
    // nobody else would declare: @babel/parser and babel-runtime are declared
    // by ordinary repositories for their own reasons, so flagging them would
    // be a false positive on an innocent consumer rather than a caught
    // mutation.
    const withManifest = (dependencies) => ({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ name: 'c', dependencies }),
    });

    for (const shareable of SHAREABLE_RUNTIME_DEPS) {
      const ok = checkManifestClean({
        consumer: '/c',
        packageName: 'mandrel',
        fs: withManifest({ [shareable]: '^7.0.0' }),
      });
      assert.equal(ok.ok, true, `${shareable} must not read as a leak`);
    }

    const internal = FRAMEWORK_RUNTIME_DEPS.find(
      (d) => !SHAREABLE_RUNTIME_DEPS.includes(d),
    );
    const leaked = checkManifestClean({
      consumer: '/c',
      packageName: 'mandrel',
      fs: withManifest({ [internal]: '*' }),
    });
    assert.equal(leaked.ok, false, `${internal} must still read as a leak`);
    assert.match(leaked.detail, new RegExp(internal.replace('/', '\\/')));
  });

  it('reports a dependency reached only through an aliased require', () => {
    // `scan-imports` matched the literal `require`/`import` callees, so a
    // module reached through a `createRequire` bound to another name was a
    // runtime dependency the drift guard could not see — which is how
    // typhonjs-escomplex-commons stayed undeclared while being imported.
    const aliased = extractThirdPartyImports(
      [
        "import { createRequire } from 'node:module';",
        'const fromReader = createRequire(import.meta.url);',
        "const table = fromReader('some-pkg/dist/thing.js');",
      ].join('\n'),
    );
    assert.ok(aliased.has('some-pkg'), 'aliased require must be reported');

    // An alias named `require` was already covered, and a call through
    // something that is not a createRequire binding must stay unreported —
    // otherwise every function call taking a string literal becomes an import.
    const notAnAlias = extractThirdPartyImports(
      "const t = translate('some-pkg/dist/thing.js');",
    );
    assert.equal(notAnAlias.has('some-pkg'), false);
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
