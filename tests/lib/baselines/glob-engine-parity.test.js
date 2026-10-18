import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Minimatch } from 'minimatch';
import picomatch from 'picomatch';

/**
 * Every glob Mandrel's own config, baselines and glob-site tests feed the
 * four former minimatch sites (ignoreGlobs, baseline components, bundle
 * `path` patterns, doc-link `--exclude`), run through both engines.
 */
const GLOBS = [
  '.agents/scripts/**/__tests__/**',
  '.agents/scripts/lib/generated/**',
  '.agents/scripts/lib/config-settings-schema*.js',
  '.agents/scripts/lib/config/gates/*.schema.js',
  'lib/**/__tests__/**',
  '**',
  'src/app/**',
  'src/worker/**',
  'nonexistent/**',
  'docs/drafts/**',
  '**/archive/**',
  '**/tmp/**',
  '**/__fixtures__/**',
  'fixtures/**',
  'gen/**',
  'app/fixtures/**',
  'src/**',
  '**/*.generated.ts',
  'dist/*.js',
  'dist/**/*.js',
  'dist/app.js',
];

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

describe('glob engine parity: minimatch vs picomatch with { dot: true }', () => {
  for (const glob of GLOBS) {
    it(`${glob} yields identical verdicts`, () => {
      const mm = new Minimatch(glob, { dot: true });
      const pm = picomatch(glob, { dot: true });
      for (const p of PATHS) {
        assert.equal(pm(p), mm.match(p), `${glob} vs ${p}`);
      }
      assert.equal(picomatch.scan(glob).isGlob, mm.hasMagic(), glob);
    });
  }
});
