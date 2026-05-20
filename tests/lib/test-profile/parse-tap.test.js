import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseTapOutput,
  selectSlowestEntries,
} from '../../../.agents/scripts/lib/test-profile/parse-tap.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/test-profile/sample.tap',
);

test('parseTapOutput reads footer aggregates and timed rows', () => {
  const tap = fs.readFileSync(fixturePath, 'utf8');
  const profile = parseTapOutput(tap);

  assert.equal(profile.testCount, 2);
  assert.equal(profile.suiteCount, 2);
  assert.equal(profile.totalDurationMs, 1500.75);
  assert.ok(profile.entries.length >= 3);

  const suite = profile.entries.find(
    (e) => e.kind === 'suite' && e.name === 'slowSuite',
  );
  assert.ok(suite);
  assert.equal(suite.durationMs, 1200.25);

  const leaf = profile.entries.find(
    (e) => e.kind === 'test' && e.name === 'nestedCase',
  );
  assert.ok(leaf);
  assert.equal(leaf.durationMs, 50.5);
  assert.match(leaf.path, /slowSuite/);
});

test('selectSlowestEntries returns top N sorted by duration', () => {
  const tap = fs.readFileSync(fixturePath, 'utf8');
  const profile = parseTapOutput(tap);
  const top = selectSlowestEntries(profile.entries, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].name, 'slowSuite');
  assert.ok(top[0].durationMs >= top[1].durationMs);
});

test('parseTapOutput normalizes CRLF', () => {
  const tap = fs.readFileSync(fixturePath, 'utf8').replace(/\n/g, '\r\n');
  const profile = parseTapOutput(tap);
  assert.equal(profile.testCount, 2);
});
