import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  INTEGRATION_INCLUDE,
  listTestFilesForTier,
  parseTierArgv,
} from '../../.agents/scripts/lib/test-tiers.js';

test('parseTierArgv defaults to full', () => {
  assert.deepEqual(parseTierArgv(['--grep', 'foo']), {
    tier: 'full',
    rest: ['--grep', 'foo'],
  });
});

test('parseTierArgv extracts tier and remainder', () => {
  assert.deepEqual(parseTierArgv(['--tier', 'quick', '--grep', 'x']), {
    tier: 'quick',
    rest: ['--grep', 'x'],
  });
});

test('parseTierArgv rejects unknown tier', () => {
  assert.throws(() => parseTierArgv(['--tier', 'nope']), /quick, integration/);
});

test('listTestFilesForTier partitions quick vs integration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));
  const testsDir = path.join(root, 'tests', 'unit');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(path.join(testsDir, 'fast.test.js'), '');
  fs.writeFileSync(path.join(testsDir, 'slow.integration.test.js'), '');
  fs.writeFileSync(
    path.join(root, 'tests', 'hook-chain-reflog-invariant.test.js'),
    '',
  );

  const quick = listTestFilesForTier('quick', root, fs);
  const integration = listTestFilesForTier('integration', root, fs);

  assert.ok(quick.includes('tests/unit/fast.test.js'));
  assert.ok(!quick.includes('tests/unit/slow.integration.test.js'));
  assert.ok(!quick.includes('tests/hook-chain-reflog-invariant.test.js'));

  assert.ok(integration.includes('tests/unit/slow.integration.test.js'));
  assert.ok(integration.includes('tests/hook-chain-reflog-invariant.test.js'));
  assert.ok(!integration.includes('tests/unit/fast.test.js'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('listTestFilesForTier full keeps the default glob', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-full-'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  assert.deepEqual(listTestFilesForTier('full', root, fs), [
    'tests/**/*.test.js',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('INTEGRATION_INCLUDE matches documented slow suites', () => {
  assert.ok(
    INTEGRATION_INCLUDE.some((p) =>
      p.includes('epic-execute-record-wave.test.js'),
    ),
  );
  assert.ok(
    INTEGRATION_INCLUDE.some((p) =>
      p.includes('check-baselines-regression.test.js'),
    ),
  );
});
