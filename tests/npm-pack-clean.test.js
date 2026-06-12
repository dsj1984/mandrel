// tests/npm-pack-clean.test.js
//
// Asserts that `npm pack --dry-run` meets the packaging contract (Story #4049, C1):
//   1. No lib/**/__tests__ files are included in the tarball.
//   2. The package.json does not declare a "main" field (dangling index.js was removed).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');

test('npm-pack-clean', async (t) => {
  await t.test('npm pack --dry-run lists no __tests__ files', () => {
    const result = spawnSync('npm', ['pack', '--dry-run'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    assert.strictEqual(
      result.status,
      0,
      `npm pack --dry-run exited ${String(result.status)}: ${result.stderr}`,
    );
    const lines = result.stdout.split('\n');
    const testFiles = lines.filter((l) => l.includes('__tests__'));
    assert.deepStrictEqual(
      testFiles,
      [],
      `Unexpected __tests__ files in tarball:\n${testFiles.join('\n')}`,
    );
  });

  await t.test('package.json has no dangling "main" field', () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf-8'),
    );
    assert.strictEqual(
      pkg.main,
      undefined,
      `package.json should not have a "main" field`,
    );
  });
});
