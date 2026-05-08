import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HELP,
  parseArgv,
  parseAuditList,
} from '../../.agents/scripts/lib/audit-suite/cli.js';

test('HELP: documents the canonical flag set', () => {
  for (const flag of [
    '--audits',
    '--ticket',
    '--base-branch',
    '--substitution',
    '--run-id',
    '--help',
  ]) {
    assert.match(HELP, new RegExp(flag.replace(/-/g, '\\-')));
  }
});

test('parseAuditList: splits on commas and trims tokens', () => {
  assert.deepEqual(parseAuditList('a, b ,c'), ['a', 'b', 'c']);
});

test('parseAuditList: drops empty / whitespace-only tokens', () => {
  assert.deepEqual(parseAuditList('a,,, b ,'), ['a', 'b']);
});

test('parseAuditList: returns [] for null/undefined', () => {
  assert.deepEqual(parseAuditList(null), []);
  assert.deepEqual(parseAuditList(undefined), []);
});

test('parseArgv: maps short forms onto the values bag', () => {
  const v = parseArgv([
    '--audits',
    'a,b',
    '--ticket',
    '525',
    '--base-branch',
    'main',
    '--substitution',
    'k=v',
    '--substitution',
    'k2=v2',
    '--run-id',
    'gate1-525',
  ]);
  assert.equal(v.audits, 'a,b');
  assert.equal(v.ticket, '525');
  assert.equal(v['base-branch'], 'main');
  assert.deepEqual(v.substitution, ['k=v', 'k2=v2']);
  assert.equal(v['run-id'], 'gate1-525');
});

test('parseArgv: --help yields a boolean flag', () => {
  const v = parseArgv(['--help']);
  assert.equal(v.help, true);
});

test('parseArgv: tolerates unknown flags (strict: false)', () => {
  const v = parseArgv(['--audits', 'a', '--unknown', 'x']);
  assert.equal(v.audits, 'a');
});
