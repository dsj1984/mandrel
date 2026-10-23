import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  checkRulesetDrift,
  diffContexts,
  requiredContexts,
  USAGE,
} from '../../scripts/check-ruleset-drift.js';
import { fcParams } from '../helpers/fast-check-config.js';

const statusRule = (...contexts) => ({
  type: 'required_status_checks',
  parameters: {
    required_status_checks: contexts.map((context) => ({
      context,
      integration_id: 15368,
    })),
  },
});

function writeSnapshot(rules) {
  const file = path.join(makeTempDir('ruleset-drift-'), 'ruleset.json');
  writeFileSync(file, JSON.stringify({ id: 1, rules }));
  return file;
}

function sink() {
  const out = { text: '' };
  out.write = (s) => {
    out.text += s;
  };
  return out;
}

test('requiredContexts reads only required_status_checks rules', () => {
  const contexts = requiredContexts([
    { type: 'deletion' },
    statusRule('Validate and Test', 'baselines'),
  ]);
  assert.deepEqual([...contexts], ['Validate and Test', 'baselines']);
});

test('requiredContexts is empty when no status-check rule exists', () => {
  assert.equal(requiredContexts([{ type: 'non_fast_forward' }]).size, 0);
});

test('checkRulesetDrift exits 0 and prints ok when the sets match', () => {
  const stdout = sink();
  const code = checkRulesetDrift({
    snapshotPath: writeSnapshot([statusRule('a', 'b')]),
    fetchLive: () => [statusRule('b', 'a'), { type: 'deletion' }],
    stdout,
  });
  assert.equal(code, 0);
  assert.match(stdout.text, /contexts=2 drift=0 \(ok\)/);
});

test('checkRulesetDrift exits 1 and lists every one-sided context', () => {
  const stdout = sink();
  const code = checkRulesetDrift({
    snapshotPath: writeSnapshot([
      statusRule('Validate and Test', 'Dependency Audit', 'Windows Smoke'),
    ]),
    fetchLive: () => [statusRule('Validate and Test', 'Windows Smoke', 'e2e')],
    stdout,
  });
  assert.equal(code, 1);
  assert.match(stdout.text, /snapshot only \(not enforced\): Dependency Audit/);
  assert.match(stdout.text, /live only \(missing from snapshot\): e2e/);
  assert.match(stdout.text, /drift=2 \(fail\)/);
});

test('the live fetch error propagates rather than reading as no drift', () => {
  assert.throws(
    () =>
      checkRulesetDrift({
        snapshotPath: writeSnapshot([statusRule('a')]),
        fetchLive: () => {
          throw new Error('gh: HTTP 401');
        },
        stdout: sink(),
      }),
    /HTTP 401/,
  );
});

test('diffContexts: no drift exactly when the sets are equal, and the sides rebuild each set', () => {
  const name = fc.constantFrom('a', 'b', 'c', 'd', 'e');
  fc.assert(
    fc.property(fc.uniqueArray(name), fc.uniqueArray(name), (s, l) => {
      const snapshot = new Set(s);
      const live = new Set(l);
      const { snapshotOnly, liveOnly } = diffContexts(snapshot, live);
      const equal = snapshot.size === live.size && s.every((c) => live.has(c));
      assert.equal(snapshotOnly.length + liveOnly.length === 0, equal);
      const shared = s.filter((c) => live.has(c));
      assert.deepEqual(new Set([...shared, ...snapshotOnly]), snapshot);
      assert.deepEqual(new Set([...shared, ...liveOnly]), live);
    }),
    fcParams(),
  );
});

test('the usage block names the command and its exit codes', () => {
  assert.match(USAGE, /^Usage: node scripts\/check-ruleset-drift\.js/);
  assert.match(USAGE, /Exits 0 when the sets match, 1 when they differ/);
});
