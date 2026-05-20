import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  parseProfileArgv,
  runTestProfile,
} from '../../.agents/scripts/run-test-profile.js';

test('parseProfileArgv defaults outDir and top', () => {
  const parsed = parseProfileArgv(['--grep', 'foo']);
  assert.equal(parsed.topN, 20);
  assert.match(parsed.outDir, /temp$/);
  assert.deepEqual(parsed.testArgv, ['--grep', 'foo']);
});

test('runTestProfile writes utf8 tap and summary under outDir', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
  const fixtureTap = fs.readFileSync(
    new URL('../fixtures/test-profile/sample.tap', import.meta.url),
    'utf8',
  );

  const outcome = runTestProfile({
    argv: ['--out-dir', outDir, '--top', '3'],
    cwd: process.cwd(),
    spawn: () => ({
      status: 0,
      stdout: fixtureTap,
      stderr: '',
    }),
  });

  assert.equal(outcome.exitCode, 0);
  const tap = fs.readFileSync(outcome.tapPath, 'utf8');
  const summary = fs.readFileSync(outcome.summaryPath, 'utf8');
  assert.equal(tap, fixtureTap);
  assert.match(summary, /slowSuite/);
  assert.match(summary, /Mandrel test profile/);
  assert.match(summary, /\[suite\]/);

  fs.rmSync(outDir, { recursive: true, force: true });
});
