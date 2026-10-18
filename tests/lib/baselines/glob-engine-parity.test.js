import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import picomatch from 'picomatch';

/**
 * Pins the verdict every corpus glob produced through minimatch before the
 * four glob sites (ignoreGlobs, baseline components, bundle `path`
 * patterns, doc-link `--exclude`) moved to picomatch. The parity run over
 * this corpus found no divergence, so these expectations are minimatch's.
 */
const PATHS = [
  '.agents/scripts/lib/__tests__/config-settings-schema-delivery-ci.test.js',
  '.agents/scripts/lib/orchestration/__tests__/deep/x.test.js',
  '.agents/scripts/lib/generated/agentrc-validator.js',
  '.agents/scripts/lib/config-settings-schema.js',
  '.agents/scripts/lib/config-settings-schema-mirror.js',
  '.agents/scripts/lib/config/gates/crap.schema.js',
  '.agents/scripts/lib/config/gates/nested/crap.schema.js',
  '.agents/scripts/check-doc-links.js',
  'lib/__tests__/a.test.js',
  'lib/cli/__tests__/b.test.js',
  'lib/cli/index.js',
  '.github/workflows/ci.yml',
  'src/app/index.ts',
  'src/app/.hidden/x.ts',
  'src/worker/a/b.ts',
  'src/apps/index.ts',
  'docs/drafts/plan.md',
  'docs/archive/old.md',
  'archive/root.md',
  'docs/a/tmp/b.md',
  'pkg/__fixtures__/f.ts',
  'fixtures/a.js',
  'app/fixtures/a.js',
  'gen/x.generated.ts',
  'src/a/b.generated.ts',
  'dist/app.js',
  'dist/chunks/vendor.js',
  'dist/.cache.js',
  'README.md',
];

/** [glob, isGlob, paths it matches with { dot: true }] */
const CASES = [
  [
    '.agents/scripts/**/__tests__/**',
    true,
    [
      '.agents/scripts/lib/__tests__/config-settings-schema-delivery-ci.test.js',
      '.agents/scripts/lib/orchestration/__tests__/deep/x.test.js',
    ],
  ],
  [
    '.agents/scripts/lib/generated/**',
    true,
    ['.agents/scripts/lib/generated/agentrc-validator.js'],
  ],
  [
    '.agents/scripts/lib/config-settings-schema*.js',
    true,
    [
      '.agents/scripts/lib/config-settings-schema.js',
      '.agents/scripts/lib/config-settings-schema-mirror.js',
    ],
  ],
  [
    '.agents/scripts/lib/config/gates/*.schema.js',
    true,
    ['.agents/scripts/lib/config/gates/crap.schema.js'],
  ],
  [
    'lib/**/__tests__/**',
    true,
    ['lib/__tests__/a.test.js', 'lib/cli/__tests__/b.test.js'],
  ],
  ['**', true, PATHS],
  ['src/app/**', true, ['src/app/index.ts', 'src/app/.hidden/x.ts']],
  ['src/worker/**', true, ['src/worker/a/b.ts']],
  ['nonexistent/**', true, []],
  ['docs/drafts/**', true, ['docs/drafts/plan.md']],
  ['**/archive/**', true, ['docs/archive/old.md', 'archive/root.md']],
  ['**/tmp/**', true, ['docs/a/tmp/b.md']],
  ['**/__fixtures__/**', true, ['pkg/__fixtures__/f.ts']],
  ['fixtures/**', true, ['fixtures/a.js']],
  ['gen/**', true, ['gen/x.generated.ts']],
  ['app/fixtures/**', true, ['app/fixtures/a.js']],
  [
    'src/**',
    true,
    [
      'src/app/index.ts',
      'src/app/.hidden/x.ts',
      'src/worker/a/b.ts',
      'src/apps/index.ts',
      'src/a/b.generated.ts',
    ],
  ],
  ['**/*.generated.ts', true, ['gen/x.generated.ts', 'src/a/b.generated.ts']],
  ['dist/*.js', true, ['dist/app.js', 'dist/.cache.js']],
  [
    'dist/**/*.js',
    true,
    ['dist/app.js', 'dist/chunks/vendor.js', 'dist/.cache.js'],
  ],
  ['dist/app.js', false, ['dist/app.js']],
];

describe('glob corpus verdicts under picomatch { dot: true }', () => {
  for (const [glob, isGlob, matches] of CASES) {
    it(`${glob} matches its pinned paths`, () => {
      const isMatch = picomatch(glob, { dot: true });
      assert.deepEqual(
        PATHS.filter((p) => isMatch(p)),
        matches,
      );
      assert.equal(
        picomatch.isMatch(PATHS[0], glob, { dot: true }),
        matches.includes(PATHS[0]),
      );
      assert.equal(picomatch.scan(glob).isGlob, isGlob);
    });
  }
});
