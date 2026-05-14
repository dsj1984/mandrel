import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  detectStrykerConfig,
  getCanonicalConfigFilenames,
} from '../../../.agents/scripts/lib/mutation/config-detector.js';

/**
 * Story #1736 / Task #1754. Unit coverage for the Stryker config detector.
 * Every test injects an in-memory fs shim so no real filesystem is touched.
 */

function makeFsShim(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    existsSync(p) {
      return store.has(p);
    },
    readFileSync(p) {
      if (!store.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return store.get(p);
    },
  };
}

describe('mutation/config-detector — detectStrykerConfig', () => {
  it('returns found=false when no config is present', () => {
    const fsImpl = makeFsShim();
    const result = detectStrykerConfig({ cwd: '/repo', fsImpl });
    assert.equal(result.found, false);
    assert.equal(result.via, null);
    assert.equal(result.path, null);
    assert.match(result.reason, /no Stryker config/);
  });

  it('detects every canonical config filename', () => {
    for (const filename of getCanonicalConfigFilenames()) {
      const abs = path.resolve('/repo', filename);
      const fsImpl = makeFsShim({ [abs]: '{}' });
      const result = detectStrykerConfig({ cwd: '/repo', fsImpl });
      assert.equal(result.found, true, `expected found=true for ${filename}`);
      assert.equal(result.via, 'config-file');
      assert.equal(result.path, abs);
    }
  });

  it('detects a "stryker" block in package.json', () => {
    const pkgPath = path.resolve('/repo', 'package.json');
    const fsImpl = makeFsShim({
      [pkgPath]: JSON.stringify({ name: 'app', stryker: { mutate: ['src'] } }),
    });
    const result = detectStrykerConfig({ cwd: '/repo', fsImpl });
    assert.equal(result.found, true);
    assert.equal(result.via, 'package-json');
    assert.equal(result.path, pkgPath);
  });

  it('does not detect package.json without a "stryker" key', () => {
    const pkgPath = path.resolve('/repo', 'package.json');
    const fsImpl = makeFsShim({
      [pkgPath]: JSON.stringify({ name: 'app' }),
    });
    const result = detectStrykerConfig({ cwd: '/repo', fsImpl });
    assert.equal(result.found, false);
  });

  it('treats package.json with a non-object "stryker" key as absent', () => {
    const pkgPath = path.resolve('/repo', 'package.json');
    const fsImpl = makeFsShim({
      [pkgPath]: JSON.stringify({ name: 'app', stryker: 'yes' }),
    });
    const result = detectStrykerConfig({ cwd: '/repo', fsImpl });
    assert.equal(result.found, false);
  });

  it('tolerates malformed package.json without throwing', () => {
    const pkgPath = path.resolve('/repo', 'package.json');
    const fsImpl = makeFsShim({
      [pkgPath]: '{not valid json',
    });
    const result = detectStrykerConfig({ cwd: '/repo', fsImpl });
    assert.equal(result.found, false);
  });

  it('honours an explicit configPath when supplied', () => {
    const explicit = path.resolve('/repo', 'custom/stryker.json');
    const fsImpl = makeFsShim({ [explicit]: '{}' });
    const result = detectStrykerConfig({
      cwd: '/repo',
      configPath: 'custom/stryker.json',
      fsImpl,
    });
    assert.equal(result.found, true);
    assert.equal(result.via, 'explicit');
    assert.equal(result.path, explicit);
  });

  it('returns found=false with reason when explicit configPath is missing', () => {
    const fsImpl = makeFsShim();
    const result = detectStrykerConfig({
      cwd: '/repo',
      configPath: 'custom/stryker.json',
      fsImpl,
    });
    assert.equal(result.found, false);
    assert.match(result.reason, /explicit strykerConfigPath/);
  });

  it('explicit configPath wins even when a canonical file is also present', () => {
    const canonical = path.resolve('/repo', 'stryker.conf.js');
    const explicit = path.resolve('/repo', 'custom/stryker.json');
    const fsImpl = makeFsShim({
      [canonical]: 'module.exports = {}',
      [explicit]: '{}',
    });
    const result = detectStrykerConfig({
      cwd: '/repo',
      configPath: 'custom/stryker.json',
      fsImpl,
    });
    assert.equal(result.via, 'explicit');
    assert.equal(result.path, explicit);
  });
});
