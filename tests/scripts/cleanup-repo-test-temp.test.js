import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { cleanupRepoTestTempArtifacts } from '../../.agents/scripts/cleanup-repo-test-temp.js';

let sandbox;
let prevSkip;
let prevVerbose;

afterEach(() => {
  if (sandbox) {
    fs.rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
  if (prevSkip !== undefined) {
    if (prevSkip === null)
      delete process.env.MANDREL_SKIP_POSTTEST_TEMP_CLEANUP;
    else process.env.MANDREL_SKIP_POSTTEST_TEMP_CLEANUP = prevSkip;
    prevSkip = undefined;
  }
  if (prevVerbose !== undefined) {
    if (prevVerbose === null)
      delete process.env.MANDREL_VERBOSE_TEST_TEMP_CLEANUP;
    else process.env.MANDREL_VERBOSE_TEST_TEMP_CLEANUP = prevVerbose;
    prevVerbose = undefined;
  }
});

test('cleanupRepoTestTempArtifacts removes only reserved-band epic-* dirs', () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-repo-temp-'));
  const tempDir = path.join(sandbox, 'temp');
  fs.mkdirSync(path.join(tempDir, 'epic-999007'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'epic-999007', 'x.txt'), 'x');
  fs.mkdirSync(path.join(tempDir, 'epic-999042'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'epic-runner-logs'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'loose.txt'), 'y');
  fs.mkdirSync(path.join(tempDir, 'epic-1143'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'epic-1143', 'keep.txt'), 'k');

  const out = cleanupRepoTestTempArtifacts({ repoRoot: sandbox });
  assert.equal(out.skipped, false);
  assert.deepEqual(out.removed.sort(), ['epic-999007', 'epic-999042']);

  assert.equal(fs.existsSync(path.join(tempDir, 'epic-999007')), false);
  assert.equal(fs.existsSync(path.join(tempDir, 'epic-999042')), false);
  assert.equal(fs.existsSync(path.join(tempDir, 'epic-runner-logs')), true);
  assert.equal(fs.readFileSync(path.join(tempDir, 'loose.txt'), 'utf8'), 'y');
  assert.equal(
    fs.readFileSync(path.join(tempDir, 'epic-1143', 'keep.txt'), 'utf8'),
    'k',
  );
});

test('cleanupRepoTestTempArtifacts is a no-op when temp/ is missing', () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-repo-temp-'));
  const out = cleanupRepoTestTempArtifacts({ repoRoot: sandbox });
  assert.deepEqual(out, { skipped: false, removed: [] });
});

test('cleanupRepoTestTempArtifacts skips when MANDREL_SKIP_POSTTEST_TEMP_CLEANUP=1', () => {
  prevSkip = process.env.MANDREL_SKIP_POSTTEST_TEMP_CLEANUP ?? null;
  process.env.MANDREL_SKIP_POSTTEST_TEMP_CLEANUP = '1';

  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-repo-temp-'));
  const tempDir = path.join(sandbox, 'temp');
  fs.mkdirSync(path.join(tempDir, 'epic-999001'), { recursive: true });

  const out = cleanupRepoTestTempArtifacts({ repoRoot: sandbox });
  assert.deepEqual(out, { skipped: true, removed: [] });
  assert.equal(fs.existsSync(path.join(tempDir, 'epic-999001')), true);
});
