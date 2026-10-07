/**
 * Dependency exceptions end to end, through the engine, over three fixture
 * shapes: a Mandrel-shaped npm repo, a pnpm monorepo with the `.pnpm` store
 * layout, and a yarn repo with no `node_modules`. The probes must be correct
 * where they can decide and must say `unknown` — never `dead` — where they
 * cannot.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { runEngine } from '../engine.js';
import { fakeGh, installManifest, lines, makeRepo } from './fixtures/repo.js';

const TODAY = '2026-10-07';

const find = (env, pred) => env.records.find(pred);
const byTarget = (env, surface, target) =>
  find(env, (r) => r.surface === surface && r.target === target);

describe('npm-shaped repo', () => {
  let env;
  before(async () => {
    const root = makeRepo({
      'package.json': {
        name: 'consumer',
        dependencies: { 'js-yaml': '^4.3.2', lodash: '^4.17.21' },
        devDependencies: { typescript: '^5.0.0' },
        scripts: { lint: 'npx used-tool --check' },
        overrides: {
          'js-yaml': '$js-yaml',
          'gone-pkg': '^1.0.0',
          lodash: '^4.17.0',
          'parent-pkg': { 'child-pkg': '^2.1.0' },
          weird: 'npm:other@^1.0.0',
        },
        '//': {
          'overrides.js-yaml':
            'Load-bearing: GHSA-2883 is fixed only in ^4.3.2.',
          'overrides.weird': 'aliased while the upstream rename lands',
        },
      },
      'package-lock.json': {
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'consumer',
            dependencies: { 'js-yaml': '^4.3.2', lodash: '^4.17.21' },
          },
          'node_modules/js-yaml': { version: '4.3.2' },
          'node_modules/markdownlint': {
            version: '1.0.0',
            dependencies: { 'js-yaml': '4.1.1' },
          },
          'node_modules/lodash': { version: '4.17.21' },
          'node_modules/parent-pkg': {
            version: '1.0.0',
            dependencies: { 'child-pkg': '^2.0.0' },
          },
          'node_modules/parent-pkg/node_modules/child-pkg': {
            version: '2.1.0',
          },
          'node_modules/weird': { version: '1.0.0' },
          'node_modules/uses-weird': {
            version: '1.0.0',
            dependencies: { weird: '^1.0.0' },
          },
          'node_modules/typescript': { version: '5.4.0' },
        },
      },
      'patches/lodash+4.17.20.patch': 'diff\n',
      'patches/js-yaml+4.3.2.patch': 'diff\n',
      'patches/gone+1.0.0.patch': 'diff\n',
      '.npmrc': lines(
        '# peer ranges of the legacy plugin conflict (tracked in #900)',
        'legacy-peer-deps=true',
        'fund=false',
      ),
      '.nsprc': {
        1500: { active: true, notes: 'dev-only path', expiry: '2026-01-01' },
        GHSA_IGNORED_INACTIVE: { active: false },
      },
      'audit-ci.json': {
        allowlist: [
          'GHSA-aaaa-bbbb-cccc',
          'GHSA-dddd|gone-transitive',
          'lodash',
        ],
      },
      'renovate.json': {
        ignoreDeps: ['gone-dep', 'lodash'],
        packageRules: [
          {
            matchPackageNames: ['typescript'],
            enabled: false,
            description: 'pinned with the peer range',
          },
          { matchPackageNames: ['/^@types\\//'], enabled: false },
        ],
      },
      'knip.json': {
        ignoreDependencies: ['lodash', 'phantom-tool', 'used-tool'],
      },
    });
    env = await runEngine({
      cwd: root,
      today: TODAY,
      gh: fakeGh({ 900: 'open' }),
    });
  });

  it('inventories every npm override leaf, nested and $name forms included', () => {
    const targets = env.records
      .filter((r) => r.surface === 'npm-overrides')
      .map((r) => r.target)
      .sort();
    assert.deepEqual(targets, [
      'child-pkg',
      'gone-pkg',
      'js-yaml',
      'lodash',
      'weird',
    ]);
  });

  it('reads the package.json `//` note as the pin justification', () => {
    const pin = byTarget(env, 'npm-overrides', 'js-yaml');
    assert.match(pin.justification, /GHSA-2883/);
    assert.equal(pin.file, 'package.json');
    assert.ok(pin.line > 1, 'the record points at the override line');
  });

  it('a pin a dependent still needs is live', () => {
    assert.equal(byTarget(env, 'npm-overrides', 'js-yaml').verdict, 'live');
    assert.equal(
      byTarget(env, 'npm-overrides', 'child-pkg').probeBasis,
      'dependent-needs-pin',
    );
  });

  it('a pin for a package absent from the tree is dead', () => {
    const pin = byTarget(env, 'npm-overrides', 'gone-pkg');
    assert.equal(pin.verdict, 'dead');
    assert.equal(pin.probeBasis, 'absent-from-tree');
  });

  it('a pin every dependent already satisfies is dead (redundant)', () => {
    const pin = byTarget(env, 'npm-overrides', 'lodash');
    assert.equal(pin.verdict, 'dead');
    assert.equal(pin.probeBasis, 'redundant');
  });

  it('an unsupported range shape is undecided, never dead', () => {
    const pin = byTarget(env, 'npm-overrides', 'weird');
    assert.equal(pin.probeBasis, 'range-undecidable');
    assert.equal(pin.verdict, 'unknown');
  });

  it('patch-package: drifted version and absent package are dead, a matching patch is live', () => {
    const patch = (name) =>
      find(env, (r) => r.surface === 'patch-package' && r.target === name);
    assert.equal(patch('lodash').probeBasis, 'version-drift');
    assert.equal(patch('gone').probeBasis, 'absent-from-tree');
    assert.notEqual(patch('js-yaml').verdict, 'dead');
  });

  it('.npmrc relaxations are inventoried with the comment above as justification', () => {
    const rc = find(env, (r) => r.surface === 'npmrc');
    assert.equal(rc.target, 'legacy-peer-deps=true');
    assert.equal(rc.verdict, 'live');
    assert.deepEqual(rc.ticketRefs, ['#900']);
    assert.equal(
      env.records.filter((r) => r.surface === 'npmrc').length,
      1,
      'fund=false is not a relaxation',
    );
  });

  it('npm-audit allowlists: expiry folds into the verdict, absent scoped packages are dead', () => {
    const nsp = find(env, (r) => r.surface === 'nsprc');
    assert.equal(nsp.verdict, 'expired');
    assert.equal(nsp.expires, '2026-01-01');
    assert.equal(
      env.records.filter((r) => r.surface === 'nsprc').length,
      1,
      'inactive entries are skipped',
    );
    assert.equal(
      byTarget(env, 'audit-ci-allowlist', 'GHSA-dddd|gone-transitive')
        .probeBasis,
      'package-not-in-tree',
    );
    assert.equal(
      byTarget(env, 'audit-ci-allowlist', 'GHSA-aaaa-bbbb-cccc').verdict,
      'unjustified',
    );
  });

  it('Renovate ignores and disabled rules: undeclared packages are dead, patterns undecided', () => {
    assert.equal(
      byTarget(env, 'renovate-ignoreDeps', 'gone-dep').verdict,
      'dead',
    );
    assert.notEqual(
      byTarget(env, 'renovate-ignoreDeps', 'lodash').verdict,
      'dead',
    );
    const rule = byTarget(env, 'renovate-disabled-rule', 'typescript');
    assert.equal(rule.verdict, 'live');
    assert.equal(rule.justification, 'pinned with the peer range');
    assert.equal(
      env.records.filter((r) => r.surface === 'renovate-disabled-rule').length,
      1,
      'a regex matcher names no package to probe',
    );
  });

  it('knip ignoreDependencies: a package nothing declares or invokes is dead', () => {
    assert.equal(
      byTarget(env, 'knip-ignoreDependencies', 'phantom-tool').verdict,
      'dead',
    );
    assert.equal(
      byTarget(env, 'knip-ignoreDependencies', 'used-tool').probeBasis,
      'invoked',
    );
    assert.equal(
      byTarget(env, 'knip-ignoreDependencies', 'lodash').probeBasis,
      'package-in-tree',
    );
  });

  it('every dependency record is categorized `dependency`', () => {
    const dep = env.records.filter((r) => r.adapter.startsWith('dependency-'));
    assert.ok(dep.length >= 15);
    assert.ok(dep.every((r) => r.category === 'dependency'));
  });
});

describe('pnpm monorepo with the .pnpm store', () => {
  let env;
  before(async () => {
    const root = makeRepo(
      {
        'package.json': {
          name: 'mono',
          private: true,
          pnpm: {
            overrides: { foo: '^2.0.0', 'bar>baz': '^1.5.0' },
            patchedDependencies: {
              'foo@2.0.0': 'patches/foo@2.0.0.patch',
              'qux@1.0.0': 'patches/missing.patch',
            },
            peerDependencyRules: { ignoreMissing: ['react', 'ghost-peer'] },
            allowedDeprecatedVersions: { request: '2' },
          },
        },
        'pnpm-workspace.yaml': lines(
          'packages:',
          "  - 'packages/*'",
          'overrides:',
          "  baz: '^1.0.0'",
        ),
        'pnpm-lock.yaml': lines(
          "lockfileVersion: '9.0'",
          'packages:',
          '  foo@2.0.0: {}',
          '  bar@1.0.0: {}',
          '  baz@1.2.0: {}',
          '  react@18.0.0: {}',
          '  qux@1.0.0: {}',
          '  leftpad@1.3.0: {}',
          'snapshots:',
          "  '@scope/x@1.0.0(react@18.0.0)': {}",
        ),
        'patches/foo@2.0.0.patch': 'diff\n',
        'packages/app/package.json': {
          name: 'app',
          dependencies: { foo: '^2.0.0' },
          overrides: { leftpad: '^1.0.0' },
        },
        'tools/outside/package.json': {
          name: 'outside',
          overrides: { never: '^1.0.0' },
        },
      },
      { untracked: {} },
    );
    installManifest(root, 'node_modules/.pnpm/bar@1.0.0/node_modules/bar', {
      name: 'bar',
      version: '1.0.0',
      dependencies: { baz: '^1.2.0' },
    });
    installManifest(root, 'node_modules/.pnpm/foo@2.0.0/node_modules/foo', {
      name: 'foo',
      version: '2.0.0',
    });
    env = await runEngine({ cwd: root, today: TODAY, gh: fakeGh({}) });
  });

  it('reads pnpm overrides from package.json and pnpm-workspace.yaml', () => {
    const foo = byTarget(env, 'pnpm-overrides', 'foo');
    assert.equal(foo.probeBasis, 'redundant', 'app already asks for ^2.0.0');
    const scoped = find(
      env,
      (r) =>
        r.surface === 'pnpm-overrides' &&
        r.file === 'package.json' &&
        r.target === 'baz',
    );
    assert.equal(
      scoped.probeBasis,
      'dependent-needs-pin',
      'bar (from the .pnpm store) asks ^1.2.0',
    );
    const yamlPin = find(
      env,
      (r) => r.file === 'pnpm-workspace.yaml' && r.target === 'baz',
    );
    assert.equal(yamlPin.probeBasis, 'redundant');
  });

  it('walks every workspace manifest and only workspace manifests', () => {
    const leftpad = byTarget(env, 'npm-overrides', 'leftpad');
    assert.equal(leftpad.file, 'packages/app/package.json');
    assert.equal(leftpad.probeBasis, 'no-dependent-ranges');
    assert.equal(byTarget(env, 'npm-overrides', 'never'), undefined);
  });

  it('pnpm patchedDependencies: a missing patch file is dead, an applied one is not', () => {
    assert.equal(
      byTarget(env, 'pnpm-patchedDependencies', 'qux').probeBasis,
      'patch-file-missing',
    );
    assert.equal(
      byTarget(env, 'pnpm-patchedDependencies', 'foo').probeBasis,
      'applies-to-resolved',
    );
  });

  it('peer rules and allowed deprecations probe presence in the tree', () => {
    assert.equal(
      byTarget(env, 'pnpm-peerDependencyRules.ignoreMissing', 'react')
        .probeBasis,
      'package-in-tree',
    );
    assert.equal(
      byTarget(env, 'pnpm-peerDependencyRules.ignoreMissing', 'ghost-peer')
        .verdict,
      'dead',
    );
    assert.ok(byTarget(env, 'pnpm-allowedDeprecatedVersions', 'request'));
  });
});

describe('yarn repo with no node_modules', () => {
  let env;
  before(async () => {
    const root = makeRepo({
      'package.json': {
        name: 'y',
        dependencies: { minimist: '^1.2.0' },
        resolutions: { '**/minimist': '^1.2.6', 'parent/@scope/gone': '1.0.0' },
      },
      'yarn.lock': lines(
        'minimist@^1.2.0, minimist@^1.2.6:',
        '  version "1.2.8"',
        '',
      ),
    });
    env = await runEngine({ cwd: root, today: TODAY, gh: fakeGh({}) });
  });

  it('degrades the redundancy probe instead of guessing', () => {
    assert.ok(
      env.degradations.some(
        (d) => d.input === 'dependency-manifests-unavailable',
      ),
    );
    const pin = byTarget(env, 'yarn-resolutions', 'minimist');
    assert.notEqual(pin.verdict, 'dead');
  });

  it('still proves an absent scoped package dead from the lockfile', () => {
    assert.equal(
      byTarget(env, 'yarn-resolutions', '@scope/gone').probeBasis,
      'absent-from-tree',
    );
  });
});
