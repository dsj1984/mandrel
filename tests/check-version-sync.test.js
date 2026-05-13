import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkVersionSync } from '../scripts/check-version-sync.js';

function makeFixture({
  pkgVersion = '1.2.3',
  fileVersion = '1.2.3',
  changelogVersion = '1.2.3',
  changelogPrefix = '# Changelog\n\n',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'version-sync-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', version: pkgVersion }),
  );
  writeFileSync(join(root, '.agents/VERSION'), `${fileVersion}\n`);
  writeFileSync(
    join(root, 'docs/CHANGELOG.md'),
    `${changelogPrefix}## [${changelogVersion}] - 2026-04-14\n\nNotes.\n`,
  );
  return root;
}

test('checkVersionSync', async (t) => {
  await t.test('passes when all three sources match', () => {
    const root = makeFixture({
      pkgVersion: '5.5.1',
      fileVersion: '5.5.1',
      changelogVersion: '5.5.1',
    });
    try {
      const result = checkVersionSync(root);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.version, '5.5.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('fails when package.json drifts from VERSION file', () => {
    const root = makeFixture({
      pkgVersion: '5.5.2',
      fileVersion: '5.5.1',
      changelogVersion: '5.5.2',
    });
    try {
      const result = checkVersionSync(root);
      assert.strictEqual(result.ok, false);
      assert.match(result.reason, /Version drift/);
      assert.match(result.reason, /\.agents\/VERSION.*5\.5\.1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('fails when CHANGELOG latest entry lags', () => {
    const root = makeFixture({
      pkgVersion: '5.5.1',
      fileVersion: '5.5.1',
      changelogVersion: '5.5.0',
    });
    try {
      const result = checkVersionSync(root);
      assert.strictEqual(result.ok, false);
      assert.match(result.reason, /docs\/CHANGELOG\.md.*5\.5\.0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('reads the FIRST ## [X.Y.Z] heading (latest entry)', () => {
    // Real-world CHANGELOG has multiple version headings; we want the topmost one.
    const root = mkdtempSync(join(tmpdir(), 'version-sync-'));
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ version: '5.5.1' }),
    );
    writeFileSync(join(root, '.agents/VERSION'), '5.5.1\n');
    writeFileSync(
      join(root, 'docs/CHANGELOG.md'),
      '# Changelog\n\n## [5.5.1] - 2026-04-14\n\nNew.\n\n## [5.5.0] - 2026-04-14\n\nOld.\n',
    );
    try {
      const result = checkVersionSync(root);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.version, '5.5.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test(
    'treats a bare ## [Unreleased] anchor as a wildcard (v6 pre-cut window)',
    () => {
      // After Story #1605 (Epic #1184) consolidates the 5.x history out of
      // docs/CHANGELOG.md but before the v6.0.0 cut, the live changelog
      // carries only a `## [Unreleased]` anchor. package.json + VERSION
      // still read 5.41.0 in that window; the gate must not trip.
      const root = mkdtempSync(join(tmpdir(), 'version-sync-'));
      mkdirSync(join(root, '.agents'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ version: '5.41.0' }),
      );
      writeFileSync(join(root, '.agents/VERSION'), '5.41.0\n');
      writeFileSync(
        join(root, 'docs/CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\nv6 work in flight.\n',
      );
      try {
        const result = checkVersionSync(root);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.version, '5.41.0');
        assert.strictEqual(result.sources['docs/CHANGELOG.md'], null);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test('throws when CHANGELOG has no version heading', () => {
    const root = mkdtempSync(join(tmpdir(), 'version-sync-'));
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ version: '1.0.0' }),
    );
    writeFileSync(join(root, '.agents/VERSION'), '1.0.0\n');
    writeFileSync(
      join(root, 'docs/CHANGELOG.md'),
      '# Changelog\n\nNo entries yet.\n',
    );
    try {
      assert.throws(
        () => checkVersionSync(root),
        /no "## \[X\.Y\.Z\]" heading/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
