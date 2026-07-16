// lib/cli/__tests__/registry-pin-current.test.js
/**
 * Unit tests for the `pin-current` doctor check (Story #4525 / #4530).
 *
 * `pin-current` fails when the consumer's declared `mandrel` dependency pin
 * (`package.json`) disagrees with the version actually resolvable in
 * `node_modules` — the skew #4525 reported doctor grading as fully green.
 * It is distinct from (and, unlike) `version-current`: that check stays a
 * non-fatal, cache-only "is a newer version published?" advisory; this one
 * is fatal, and answers "does the declared dependency describe what is
 * actually installed?".
 *
 * Every test drives `runPinCurrent` through its injectable seams (`cwd`,
 * `fsImpl`, `resolvePackageRoot`) so no real filesystem or package
 * resolution occurs (testing-standards § Unit).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { registry, runPinCurrent } from '../registry.js';

const CONSUMER_ROOT = path.join(path.sep, 'consumer');
const INSTALLED_ROOT = path.join(CONSUMER_ROOT, 'node_modules', 'mandrel');

/** Minimal readFileSync-only fs fake keyed by absolute path. */
function makeFsFake(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    readFileSync(p, _enc) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
  };
}

function pkgJson(deps) {
  return JSON.stringify({ dependencies: deps });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registry — pin-current is registered as a fatal check', () => {
  it('is present in the registry, between agents-drift and version-current', () => {
    const names = registry.map((c) => c.name);
    const idx = names.indexOf('pin-current');
    assert.ok(idx > -1, 'pin-current must be registered');
    assert.equal(names[idx - 1], 'agents-drift');
    assert.equal(names[idx + 1], 'version-current');
  });

  it('carries no `advisory: true` flag — unlike version-current', () => {
    const entry = registry.find((c) => c.name === 'pin-current');
    assert.equal(entry.advisory, undefined);
    const versionCurrent = registry.find((c) => c.name === 'version-current');
    assert.equal(versionCurrent.advisory, true);
  });
});

// ---------------------------------------------------------------------------
// Fatal mismatch
// ---------------------------------------------------------------------------

describe('runPinCurrent — pin disagrees with the installed version', () => {
  it('fails and names both versions when the pin lags the installed version (the #4525 repro)', () => {
    const fsImpl = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: pkgJson({
        mandrel: '^1.87.0',
      }),
      [path.join(INSTALLED_ROOT, 'package.json')]: JSON.stringify({
        version: '2.0.0',
      }),
    });
    const result = runPinCurrent({
      cwd: () => CONSUMER_ROOT,
      fsImpl,
      resolvePackageRoot: () => INSTALLED_ROOT,
    });

    assert.equal(result.ok, false);
    assert.match(result.detail, /v1\.87\.0/);
    assert.match(result.detail, /v2\.0\.0/);
    assert.match(result.remedy, /mandrel update/);
  });

  it('fails when the pin is AHEAD of what is installed (any disagreement, not just lag)', () => {
    const fsImpl = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: pkgJson({
        mandrel: '^2.0.0',
      }),
      [path.join(INSTALLED_ROOT, 'package.json')]: JSON.stringify({
        version: '1.87.0',
      }),
    });
    const result = runPinCurrent({
      cwd: () => CONSUMER_ROOT,
      fsImpl,
      resolvePackageRoot: () => INSTALLED_ROOT,
    });

    assert.equal(result.ok, false);
    assert.match(result.detail, /v2\.0\.0/);
    assert.match(result.detail, /v1\.87\.0/);
  });
});

// ---------------------------------------------------------------------------
// Clean pass
// ---------------------------------------------------------------------------

describe('runPinCurrent — pin matches installed', () => {
  it('passes when the pin base version equals the installed version', () => {
    const fsImpl = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: pkgJson({
        mandrel: '^1.87.0',
      }),
      [path.join(INSTALLED_ROOT, 'package.json')]: JSON.stringify({
        version: '1.87.0',
      }),
    });
    const result = runPinCurrent({
      cwd: () => CONSUMER_ROOT,
      fsImpl,
      resolvePackageRoot: () => INSTALLED_ROOT,
    });

    assert.equal(result.ok, true);
    assert.match(result.detail, /matches/);
  });
});

// ---------------------------------------------------------------------------
// Clean skip — no resolvable pin (AC: no dependency entry / no package.json)
// ---------------------------------------------------------------------------

describe('runPinCurrent — clean skip, not a failure, when there is no resolvable pin', () => {
  it('skips when there is no package.json at all', () => {
    const fsImpl = makeFsFake({});
    const result = runPinCurrent({ cwd: () => CONSUMER_ROOT, fsImpl });
    assert.equal(result.ok, true);
    assert.match(result.detail, /skipped/);
  });

  it('skips when package.json has no mandrel dependency entry (e.g. mandrel own repo)', () => {
    const fsImpl = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: JSON.stringify({
        name: 'mandrel',
        dependencies: { 'some-other-pkg': '^1.0.0' },
      }),
    });
    const result = runPinCurrent({ cwd: () => CONSUMER_ROOT, fsImpl });
    assert.equal(result.ok, true);
    assert.match(result.detail, /skipped/);
  });

  it('skips when the pin is an unresolvable specifier (workspace:, git+, latest, *)', () => {
    for (const spec of ['workspace:*', 'git+https://x/y.git', 'latest', '*']) {
      const fsImpl = makeFsFake({
        [path.join(CONSUMER_ROOT, 'package.json')]: pkgJson({ mandrel: spec }),
      });
      const result = runPinCurrent({ cwd: () => CONSUMER_ROOT, fsImpl });
      assert.equal(result.ok, true, `expected skip for spec "${spec}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Clean skip — pin resolvable but package not installed
// ---------------------------------------------------------------------------

describe('runPinCurrent — clean skip when mandrel is not installed', () => {
  it('skips rather than fails when resolvePackageRoot throws', () => {
    const fsImpl = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: pkgJson({
        mandrel: '^1.87.0',
      }),
    });
    const result = runPinCurrent({
      cwd: () => CONSUMER_ROOT,
      fsImpl,
      resolvePackageRoot: () => {
        const err = new Error("Cannot find module 'mandrel/package.json'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      },
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /not installed/);
  });

  it('skips rather than fails when the installed package.json is unreadable', () => {
    const fsImpl = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: pkgJson({
        mandrel: '^1.87.0',
      }),
      // INSTALLED_ROOT/package.json deliberately absent from the fake.
    });
    const result = runPinCurrent({
      cwd: () => CONSUMER_ROOT,
      fsImpl,
      resolvePackageRoot: () => INSTALLED_ROOT,
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /unreadable/);
  });
});

// ---------------------------------------------------------------------------
// Anchoring — pin and node_modules resolution share the same cwd
// ---------------------------------------------------------------------------

describe('runPinCurrent — anchors both reads at the same consumer cwd', () => {
  it('passes the resolved projectRoot to resolvePackageRoot, not a package-relative path', () => {
    const fsImpl = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: pkgJson({
        mandrel: '^1.87.0',
      }),
      [path.join(INSTALLED_ROOT, 'package.json')]: JSON.stringify({
        version: '1.87.0',
      }),
    });
    let seenRoot = null;
    runPinCurrent({
      cwd: () => CONSUMER_ROOT,
      fsImpl,
      resolvePackageRoot: (fromDir) => {
        seenRoot = fromDir;
        return INSTALLED_ROOT;
      },
    });
    assert.equal(seenRoot, CONSUMER_ROOT);
  });
});
