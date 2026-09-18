import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  parseProfileArgv,
  runTestProfile,
} from '../../scripts/run-test-profile.js';

test('parseProfileArgv defaults outDir and top', () => {
  const parsed = parseProfileArgv(['--grep', 'foo']);
  assert.equal(parsed.topN, 20);
  assert.match(parsed.outDir, /temp$/);
  assert.deepEqual(parsed.testArgv, ['--grep', 'foo']);
});

test('runTestProfile asks for the tap reporter in flag position', () => {
  // The defect this pins: the profiler used to append `--test-reporter tap`
  // after `buildNodeTestArgs`' file targets. Node stops parsing options at
  // the first positional, so the two tokens became file patterns, the
  // default reporter ran, and every profile reported
  // `Timed entries parsed: 0` for a full suite run.
  const outDir = makeTempDir('profile-argv-');
  let nodeArgs = null;

  runTestProfile({
    argv: ['--out-dir', outDir],
    cwd: process.cwd(),
    spawn: (_cmd, args) => {
      nodeArgs = args;
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const reporterIdx = nodeArgs.indexOf('--test-reporter');
  const firstTargetIdx = nodeArgs.findIndex((a) => !a.startsWith('-'));
  assert.ok(reporterIdx >= 0, 'the profiler must request a reporter');
  assert.equal(nodeArgs[reporterIdx + 1], 'tap');
  assert.ok(
    reporterIdx < firstTargetIdx,
    'the reporter flag must precede the first test-file target',
  );

  fs.rmSync(outDir, { recursive: true, force: true });
});

test('runTestProfile writes utf8 tap and summary under outDir', () => {
  const outDir = makeTempDir('profile-');
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
