/**
 * Unit tests for `review-providers/mi-exemptions.js` — the maintainability
 * gate's exemption list as the native review provider reads it.
 *
 * Live defect this module exists for (Story #5007 / PR #5022): the review lens
 * scored files `delivery.quality.gates.maintainability.ignoreGlobs` exempts, so
 * the `check-baselines.js` ratchet PASSED while the lens raised a **critical
 * blocker** on the same three `config-settings-schema*.js` modules in the same
 * close run. A critical finding halts close before auto-merge, so the only way
 * to land legitimate work was to merge the PR by hand.
 *
 * The bar here: the resolver reads the same gate key the ratchet reads, and it
 * fails OPEN — never closed — when the config cannot be resolved.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveMaintainabilityIgnoreGlobs,
  scopeMaintainabilityFiles,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/mi-exemptions.js';

/** The three real paths from PR #5022, and the glob that exempts all of them. */
const EXEMPT_FILES = [
  '.agents/scripts/lib/config-settings-schema-delivery.js',
  '.agents/scripts/lib/config-settings-schema-quality.js',
  '.agents/scripts/lib/config-settings-schema.js',
];
const EXEMPT_GLOB = '.agents/scripts/lib/config-settings-schema*.js';

function configWithIgnoreGlobs(globs) {
  return () => ({
    delivery: {
      quality: { gates: { maintainability: { ignoreGlobs: globs } } },
    },
  });
}

test('resolveMaintainabilityIgnoreGlobs: reads the same gate key the ratchet reads', () => {
  const globs = resolveMaintainabilityIgnoreGlobs({
    resolveConfigFn: configWithIgnoreGlobs(['a/**.js', 'b*.js']),
  });
  assert.deepEqual(globs, ['a/**.js', 'b*.js']);
});

test('resolveMaintainabilityIgnoreGlobs: returns a copy, so a caller cannot poison the config', () => {
  const config = configWithIgnoreGlobs(['a/**.js']);
  const first = resolveMaintainabilityIgnoreGlobs({ resolveConfigFn: config });
  first.push('mutated');
  assert.deepEqual(
    resolveMaintainabilityIgnoreGlobs({ resolveConfigFn: config }),
    ['a/**.js'],
  );
});

test('resolveMaintainabilityIgnoreGlobs: an unresolvable config fails OPEN', () => {
  // `[]` scores every changed file and at worst produces an advisory a human
  // reads. Degrading the other way would silently retire the dimension, which
  // is strictly worse than the false positive it prevents.
  const globs = resolveMaintainabilityIgnoreGlobs({
    resolveConfigFn: () => {
      throw new Error('unreadable .agentrc.json');
    },
  });
  assert.deepEqual(globs, []);
});

test('resolveMaintainabilityIgnoreGlobs: a missing or non-array key fails OPEN', () => {
  for (const value of [undefined, null, 'not-an-array', 42, {}]) {
    assert.deepEqual(
      resolveMaintainabilityIgnoreGlobs({
        resolveConfigFn: configWithIgnoreGlobs(value),
      }),
      [],
      `ignoreGlobs=${JSON.stringify(value)} must degrade to []`,
    );
  }
  assert.deepEqual(
    resolveMaintainabilityIgnoreGlobs({ resolveConfigFn: () => ({}) }),
    [],
  );
});

/** Scope a file list with an explicit glob list, bypassing config resolution. */
function scopeWith(files, globs) {
  return scopeMaintainabilityFiles(files, {
    cwd: '/repo',
    resolveIgnoreGlobsFn: () => globs,
  });
}

test('scopeMaintainabilityFiles: splits the real PR #5022 file set on the real glob', () => {
  const scoredPath = '.agents/scripts/lib/orchestration/runner.js';
  const { scored, ignored } = scopeWith(
    [...EXEMPT_FILES, scoredPath],
    [EXEMPT_GLOB],
  );
  assert.deepEqual(ignored, EXEMPT_FILES);
  assert.deepEqual(scored, [scoredPath]);
});

test('scopeMaintainabilityFiles: an empty or absent list is a no-op that scores everything', () => {
  for (const globs of [[], undefined, null, 'nope']) {
    const { scored, ignored, notice } = scopeWith(EXEMPT_FILES, globs);
    assert.deepEqual(scored, EXEMPT_FILES);
    assert.deepEqual(ignored, []);
    assert.equal(notice, null, 'nothing exempted renders no notice');
  }
});

test('scopeMaintainabilityFiles: matches dot-prefixed roots like .agents/', () => {
  // The repo's own exemptions all live under `.agents/`, so a matcher without
  // picomatch's `{ dot: true }` would silently exempt nothing here.
  const { ignored } = scopeWith(
    ['.agents/scripts/lib/config/gates/crap.schema.js'],
    ['.agents/scripts/lib/config/gates/*.schema.js'],
  );
  assert.equal(ignored.length, 1);
});

test('scopeMaintainabilityFiles: the notice names every exempt file and the gate key', () => {
  const { notice } = scopeWith(EXEMPT_FILES, [EXEMPT_GLOB]);
  assert.match(notice, /3 changed file\(s\) exempt via/);
  assert.match(
    notice,
    /delivery\.quality\.gates\.maintainability\.ignoreGlobs/,
  );
  for (const file of EXEMPT_FILES) assert.ok(notice.includes(file));
});

test('scopeMaintainabilityFiles: reads the gate key when no resolver is injected', () => {
  // The production default path — no `resolveIgnoreGlobsFn`. This repo's own
  // .agentrc.json exempts config-settings-schema*.js, so the real read must
  // exempt all three.
  const { ignored } = scopeMaintainabilityFiles(EXEMPT_FILES, {
    cwd: process.cwd(),
  });
  assert.deepEqual(ignored, EXEMPT_FILES);
});
