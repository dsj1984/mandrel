import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as bundleSize from '../../../.agents/scripts/lib/baselines/kinds/bundle-size.js';
import * as coverage from '../../../.agents/scripts/lib/baselines/kinds/coverage.js';
import * as crap from '../../../.agents/scripts/lib/baselines/kinds/crap.js';
import * as lighthouse from '../../../.agents/scripts/lib/baselines/kinds/lighthouse.js';
import * as lint from '../../../.agents/scripts/lib/baselines/kinds/lint.js';
import * as maintainability from '../../../.agents/scripts/lib/baselines/kinds/maintainability.js';
import * as mutation from '../../../.agents/scripts/lib/baselines/kinds/mutation.js';

// ---------------------------------------------------------------------------
// purity.test.js — Story #1961 / Task #1967.
//
// Locks in the no-I/O contract for the compare(head, base) primitive across
// all seven per-kind modules. The test patches every callable on `fs`,
// `fs/promises`, `child_process`, and `process.exit` to throw on access,
// then invokes each kind's compare with synthetic envelopes. If any kind's
// compare triggers I/O, a child process, or attempts to terminate the
// process, the corresponding patched method throws and the test fails.
//
// We patch the live module-level exports rather than mocking the import
// graph because `node --test` does not yet support `mock.module()` in the
// version this repo pins. The patches are restored in afterEach.
// ---------------------------------------------------------------------------

const KINDS = [
  { name: 'bundle-size', mod: bundleSize, sample: bundleSizeSample() },
  { name: 'coverage', mod: coverage, sample: coverageSample() },
  { name: 'crap', mod: crap, sample: crapSample() },
  { name: 'lighthouse', mod: lighthouse, sample: lighthouseSample() },
  { name: 'lint', mod: lint, sample: lintSample() },
  { name: 'maintainability', mod: maintainability, sample: maintainabilitySample() },
  { name: 'mutation', mod: mutation, sample: mutationSample() },
];

function bundleSizeSample() {
  return {
    head: { rows: [{ bundle: 'main', rawKb: 200, gzippedKb: 80 }] },
    base: { rows: [{ bundle: 'main', rawKb: 180, gzippedKb: 70 }] },
  };
}
function coverageSample() {
  return {
    head: { rows: [{ path: 'src/a.js', lines: 80, branches: 70, functions: 90 }] },
    base: { rows: [{ path: 'src/a.js', lines: 90, branches: 80, functions: 95 }] },
  };
}
function crapSample() {
  return {
    head: { rows: [{ path: 'src/a.js', method: 'foo', startLine: 1, crap: 12 }] },
    base: { rows: [{ path: 'src/a.js', method: 'foo', startLine: 1, crap: 8 }] },
  };
}
function lighthouseSample() {
  return {
    head: { rows: [{ route: '/dashboard', performance: 80, accessibility: 90, bestPractices: 90, seo: 90 }] },
    base: { rows: [{ route: '/dashboard', performance: 90, accessibility: 95, bestPractices: 95, seo: 95 }] },
  };
}
function lintSample() {
  return {
    head: { rows: [{ path: 'src/a.js', errorCount: 2, warningCount: 0 }] },
    base: { rows: [{ path: 'src/a.js', errorCount: 0, warningCount: 0 }] },
  };
}
function maintainabilitySample() {
  return {
    head: { rows: [{ path: 'src/a.js', mi: 60 }] },
    base: { rows: [{ path: 'src/a.js', mi: 80 }] },
  };
}
function mutationSample() {
  return {
    head: { rows: [{ path: 'src/a.js', score: 70, killed: 7, survived: 3 }] },
    base: { rows: [{ path: 'src/a.js', score: 85, killed: 8, survived: 2 }] },
  };
}

// Patch all callable members of the given namespace object to throw on
// access. Returns a restore function. Non-callable properties are left
// alone — only the function exports matter for the I/O contract.
function patchNamespace(ns, label) {
  const original = new Map();
  for (const key of Object.keys(ns)) {
    let value;
    try {
      value = ns[key];
    } catch {
      continue;
    }
    if (typeof value !== 'function') continue;
    original.set(key, value);
    try {
      ns[key] = function purityTrap(..._args) {
        throw new Error(
          `[purity] kind module called ${label}.${key}() — compare(head, base) MUST be pure (no I/O, no child processes, no process control)`,
        );
      };
    } catch {
      // Some namespaces have read-only members — skip them. The throw on
      // access still fires for any member we successfully replaced.
    }
  }
  return () => {
    for (const [key, value] of original) {
      try {
        ns[key] = value;
      } catch {
        // best-effort restore
      }
    }
  };
}

describe('per-kind compare(head, base) purity (Task #1967)', () => {
  let restoreFs;
  let restoreFsPromises;
  let restoreChildProcess;
  let originalExit;

  beforeEach(() => {
    restoreFs = patchNamespace(fs, 'fs');
    restoreFsPromises = patchNamespace(fsPromises, 'fs/promises');
    restoreChildProcess = patchNamespace(child_process, 'child_process');
    originalExit = process.exit;
    process.exit = function purityExitTrap(code) {
      throw new Error(
        `[purity] kind module called process.exit(${code}) — compare(head, base) MUST be pure (no process control)`,
      );
    };
  });

  afterEach(() => {
    restoreFs();
    restoreFsPromises();
    restoreChildProcess();
    process.exit = originalExit;
  });

  for (const { name, mod, sample } of KINDS) {
    it(`${name}: compare runs without touching fs, child_process, or process.exit`, () => {
      assert.equal(
        typeof mod.compare,
        'function',
        `kinds/${name} must export a compare(head, base) function`,
      );
      // The call itself is the assertion — any I/O or process.exit attempt
      // will throw inside the patched namespace and fail the test.
      const out = mod.compare(sample.head, sample.base);
      assert.ok(
        out && Array.isArray(out.regressions) && Array.isArray(out.improvements) && Array.isArray(out.unchanged),
        `kinds/${name}.compare must return { regressions, improvements, unchanged }`,
      );
    });
  }

  it('every kind module declines to import the friction emitter', async () => {
    // Source-text scan for the negative AC: no kind module wires the
    // friction emitter into its import graph. Friction emission belongs to
    // the dispatcher, not the per-kind primitives.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const kindsDir = path.resolve(
      here,
      '../../../.agents/scripts/lib/baselines/kinds',
    );
    for (const { name } of KINDS) {
      const filename = `${name}.js`;
      const src = await readFile(path.join(kindsDir, filename), 'utf-8');
      assert.ok(
        !/from\s+['"][^'"]*gates\/friction(?:\.js)?['"]/.test(src),
        `kinds/${filename} must not import the friction emitter`,
      );
    }
  });
});
