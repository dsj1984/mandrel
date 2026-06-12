import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkVersionSync } from '../scripts/check-version-sync.js';

function makeFixture({
  pkgVersion = '1.2.3',
  manifestVersion = '1.2.3',
  manifestEntries,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'version-sync-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', version: pkgVersion }),
  );
  const manifest = manifestEntries ?? {
    '.': manifestVersion,
    'some-other-pkg': '0.2.0',
  };
  writeFileSync(
    join(root, '.release-please-manifest.json'),
    JSON.stringify(manifest),
  );
  return root;
}

test('checkVersionSync', async (t) => {
  await t.test('passes when both sources match', () => {
    const root = makeFixture({
      pkgVersion: '5.5.1',
      manifestVersion: '5.5.1',
    });
    try {
      const result = checkVersionSync(root);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.version, '5.5.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test(
    'reads the root package entry ("."), ignoring sibling packages',
    () => {
      const root = makeFixture({
        pkgVersion: '5.5.1',
        manifestEntries: { '.': '5.5.1', 'some-other-pkg': '9.9.9' },
      });
      try {
        const result = checkVersionSync(root);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.version, '5.5.1');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test('fails when package.json drifts from the manifest', () => {
    const root = makeFixture({
      pkgVersion: '5.5.2',
      manifestVersion: '5.5.1',
    });
    try {
      const result = checkVersionSync(root);
      assert.strictEqual(result.ok, false);
      assert.match(result.reason, /Version drift/);
      assert.match(result.reason, /\.release-please-manifest\.json.*5\.5\.1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('throws when the manifest has no root-package entry', () => {
    const root = makeFixture({
      pkgVersion: '1.0.0',
      manifestEntries: { 'some-other-pkg': '0.2.0' },
    });
    try {
      assert.throws(() => checkVersionSync(root), /no "\." root-package entry/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
