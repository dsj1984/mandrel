import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  checkKernelVersion,
  currentKernelVersion,
  getKindModule,
  listKinds,
} from '../../.agents/scripts/lib/baselines/kernel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('listKinds()', () => {
  it('exposes every shipped kind', () => {
    const kinds = listKinds();
    for (const expected of [
      'lint',
      'coverage',
      'crap',
      'maintainability',
      'mutation',
      'lighthouse',
      'bundle-size',
    ]) {
      assert.ok(kinds.includes(expected), `missing kind: ${expected}`);
    }
  });
});

describe('currentKernelVersion()', () => {
  it("returns the installed typhonjs-escomplex version for 'crap'", () => {
    const pkgPath = path.join(
      REPO_ROOT,
      'node_modules',
      'typhonjs-escomplex',
      'package.json',
    );
    const expected = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    assert.equal(currentKernelVersion('crap'), expected);
  });

  it("returns the same version for 'maintainability' (shared escomplex kernel)", () => {
    assert.equal(
      currentKernelVersion('maintainability'),
      currentKernelVersion('crap'),
    );
  });

  it("returns the static '1.0.0' for kinds with a static kernel", () => {
    for (const kind of [
      'lint',
      'coverage',
      'mutation',
      'lighthouse',
      'bundle-size',
    ]) {
      assert.equal(currentKernelVersion(kind), '1.0.0');
    }
  });

  it('throws on an unknown kind', () => {
    assert.throws(() => currentKernelVersion('nope'), /unknown kind/);
  });
});

describe('checkKernelVersion()', () => {
  it('returns { match: true, current } when the baseline matches the running kernel', () => {
    const current = currentKernelVersion('lint');
    const result = checkKernelVersion('lint', current);
    assert.equal(result.match, true);
    assert.equal(result.current, current);
  });

  it('returns { match: false, current } when versions differ', () => {
    const result = checkKernelVersion('lint', '0.0.1');
    assert.equal(result.match, false);
    assert.equal(typeof result.current, 'string');
    assert.notEqual(result.current, '0.0.1');
  });
});

describe('getKindModule()', () => {
  it('exposes the expected per-kind contract surface', () => {
    const mod = getKindModule('lint');
    assert.equal(mod.name, 'lint');
    assert.equal(mod.keyField, 'path');
    assert.equal(typeof mod.kernelVersion, 'function');
    assert.equal(typeof mod.projectRow, 'function');
    assert.equal(typeof mod.sortRows, 'function');
    assert.equal(typeof mod.rollup, 'function');
  });

  it('throws on an unknown kind', () => {
    assert.throws(() => getKindModule('nope'), /unknown kind/);
  });
});
