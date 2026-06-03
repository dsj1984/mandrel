import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  detectPackageManager,
  detectPrimaryLanguage,
  detectStack,
  detectTestRunner,
} from '../../.agents/scripts/lib/onboard/detect-stack.js';

/**
 * Story #3520 — Stack detection helper for /onboard.
 *
 * The headline AC exercises `detectStack` against a real on-disk sample
 * repo fixture (default filesystem facade), asserting it reports the
 * package manager, test runner, and primary language. The remaining
 * cases drive the individual detectors through an in-memory facade seam
 * so the recognition rules are covered without touching disk.
 */

/**
 * Build an in-memory filesystem facade over a virtual file map.
 *
 * @param {Record<string, string>} files - Map of relative path → contents.
 * @returns {import('../../.agents/scripts/lib/onboard/detect-stack.js').FsFacade & { _root: string }}
 */
function memFacade(files, root = '/repo') {
  const norm = (p) => p.split(path.sep).join('/');
  const abs = (rel) => norm(path.join(root, rel));
  const fileSet = new Map(Object.entries(files).map(([k, v]) => [abs(k), v]));
  return {
    _root: root,
    exists: (p) => fileSet.has(norm(p)),
    readFile: (p) => (fileSet.has(norm(p)) ? fileSet.get(norm(p)) : null),
    listExtensions: () =>
      [...fileSet.keys()].map((p) => path.extname(p).toLowerCase()),
  };
}

describe('detectStack — sample repo fixture (real disk)', () => {
  let fixtureRoot;

  before(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'detect-stack-fixture-'));
    // A small npm + node-test + TypeScript sample repo.
    writeFileSync(path.join(fixtureRoot, 'package-lock.json'), '{}');
    writeFileSync(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify({
        name: 'sample',
        scripts: { test: 'node --test' },
      }),
    );
    writeFileSync(path.join(fixtureRoot, 'tsconfig.json'), '{}');
    const srcDir = path.join(fixtureRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(srcDir, 'util.ts'), 'export const y = 2;\n');
    // A vendored dir that must be ignored by language detection.
    const vendored = path.join(fixtureRoot, 'node_modules', 'pkg');
    mkdirSync(vendored, { recursive: true });
    writeFileSync(path.join(vendored, 'dep.js'), 'module.exports = {};\n');
  });

  after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('reports package manager, test runner, and primary language', () => {
    const result = detectStack(fixtureRoot);
    assert.deepEqual(result, {
      packageManager: 'npm',
      testRunner: 'node-test',
      primaryLanguage: 'typescript',
    });
  });

  it('ignores vendored node_modules when inferring language', () => {
    // Despite a .js file under node_modules, TypeScript wins from src/.
    assert.equal(detectPrimaryLanguage(fixtureRoot), 'typescript');
  });
});

describe('detectStack — input guard', () => {
  it('throws on a non-string root', () => {
    assert.throws(() => detectStack(undefined), /non-empty string/);
    assert.throws(() => detectStack(''), /non-empty string/);
  });
});

describe('detectPackageManager', () => {
  it('prefers pnpm lockfile', () => {
    assert.equal(
      detectPackageManager('/repo', memFacade({ 'pnpm-lock.yaml': '' })),
      'pnpm',
    );
  });

  it('detects yarn', () => {
    assert.equal(
      detectPackageManager('/repo', memFacade({ 'yarn.lock': '' })),
      'yarn',
    );
  });

  it('detects bun', () => {
    assert.equal(
      detectPackageManager('/repo', memFacade({ 'bun.lockb': '' })),
      'bun',
    );
  });

  it('detects npm from package-lock', () => {
    assert.equal(
      detectPackageManager('/repo', memFacade({ 'package-lock.json': '{}' })),
      'npm',
    );
  });

  it('falls back to npm when only package.json exists', () => {
    assert.equal(
      detectPackageManager('/repo', memFacade({ 'package.json': '{}' })),
      'npm',
    );
  });

  it('returns null with no Node manifest', () => {
    assert.equal(detectPackageManager('/repo', memFacade({})), null);
  });
});

describe('detectTestRunner', () => {
  it('detects vitest from devDependencies', () => {
    const fac = memFacade({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^1' } }),
    });
    assert.equal(detectTestRunner('/repo', fac), 'vitest');
  });

  it('detects jest from dependencies', () => {
    const fac = memFacade({
      'package.json': JSON.stringify({ dependencies: { jest: '^29' } }),
    });
    assert.equal(detectTestRunner('/repo', fac), 'jest');
  });

  it('detects mocha and ava', () => {
    assert.equal(
      detectTestRunner(
        '/repo',
        memFacade({
          'package.json': JSON.stringify({ devDependencies: { mocha: '^10' } }),
        }),
      ),
      'mocha',
    );
    assert.equal(
      detectTestRunner(
        '/repo',
        memFacade({
          'package.json': JSON.stringify({ devDependencies: { ava: '^6' } }),
        }),
      ),
      'ava',
    );
  });

  it('detects node built-in runner from the test script', () => {
    const fac = memFacade({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    });
    assert.equal(detectTestRunner('/repo', fac), 'node-test');
  });

  it('returns null when nothing is recognizable', () => {
    const fac = memFacade({
      'package.json': JSON.stringify({ scripts: { test: 'echo no tests' } }),
    });
    assert.equal(detectTestRunner('/repo', fac), null);
  });

  it('returns null when package.json is unparseable', () => {
    const fac = memFacade({ 'package.json': '{ not json' });
    assert.equal(detectTestRunner('/repo', fac), null);
  });
});

describe('detectPrimaryLanguage', () => {
  it('picks the most frequent recognized language', () => {
    const fac = memFacade({
      'a.py': '',
      'b.py': '',
      'c.js': '',
    });
    assert.equal(detectPrimaryLanguage('/repo', fac), 'python');
  });

  it('breaks ties toward typescript when tsconfig.json is present', () => {
    const fac = memFacade({
      'a.ts': '',
      'b.js': '',
      'tsconfig.json': '{}',
    });
    assert.equal(detectPrimaryLanguage('/repo', fac), 'typescript');
  });

  it('returns null when no recognized source files exist', () => {
    const fac = memFacade({ 'README.md': '', 'data.csv': '' });
    assert.equal(detectPrimaryLanguage('/repo', fac), null);
  });
});
