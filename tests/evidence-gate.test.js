import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseWrapperArgs,
  splitOnDashDash,
} from '../.agents/scripts/evidence-gate.js';

test('splitOnDashDash() partitions argv at the first --', () => {
  const { wrapperArgs, runnerArgs } = splitOnDashDash([
    '--scope-id',
    '817',
    '--gate',
    'lint',
    '--',
    'npm',
    'run',
    'lint',
  ]);
  assert.deepEqual(wrapperArgs, ['--scope-id', '817', '--gate', 'lint']);
  assert.deepEqual(runnerArgs, ['npm', 'run', 'lint']);
});

test('splitOnDashDash() returns empty runner side when -- is missing', () => {
  const { wrapperArgs, runnerArgs } = splitOnDashDash(['--gate', 'lint']);
  assert.deepEqual(wrapperArgs, ['--gate', 'lint']);
  assert.deepEqual(runnerArgs, []);
});

test('parseWrapperArgs() coerces --scope-id + --epic-id and toggles --no-evidence', () => {
  const args = parseWrapperArgs([
    '--epic-id',
    '802',
    '--scope-id',
    '817',
    '--gate',
    'lint',
    '--no-evidence',
  ]);
  assert.equal(args.scopeId, 817);
  assert.equal(args.epicId, 802);
  assert.equal(args.gate, 'lint');
  assert.equal(args.useEvidence, false);
});

test('parseWrapperArgs() defaults --no-evidence to false (evidence ON)', () => {
  const args = parseWrapperArgs([
    '--epic-id',
    '802',
    '--scope-id',
    '817',
    '--gate',
    'test',
  ]);
  assert.equal(args.useEvidence, true);
});

test('parseWrapperArgs() yields scopeId=null on non-positive input', () => {
  assert.equal(parseWrapperArgs(['--scope-id', '0']).scopeId, null);
  assert.equal(parseWrapperArgs(['--scope-id', 'abc']).scopeId, null);
  assert.equal(parseWrapperArgs([]).scopeId, null);
});

test('parseWrapperArgs() yields epicId=null on non-positive input', () => {
  assert.equal(parseWrapperArgs(['--epic-id', '0']).epicId, null);
  assert.equal(parseWrapperArgs(['--epic-id', 'abc']).epicId, null);
  assert.equal(parseWrapperArgs([]).epicId, null);
});
