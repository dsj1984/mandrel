/**
 * tests/pre-push-hook.test.js — Story #2745 pre-push rebalance contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function readPrePush() {
  return fs.readFileSync(path.join(REPO_ROOT, '.husky', 'pre-push'), 'utf8');
}

test('pre-push — diff-scoped preview + coverage/CRAP ratchet, not full lint', () => {
  const hook = readPrePush();
  assert.doesNotMatch(hook, /npm run lint\b/);
  assert.doesNotMatch(hook, /maintainability:check/);
  assert.match(hook, /quality-preview\.js/);
  assert.match(hook, /--changed-since\s+origin\/main/);
  assert.match(hook, /coverage-capture\.js\s+--skip-when-no-crap-files/);
  assert.match(hook, /coverage-capture\.js[^\n]*--ref\s+origin\/main/);
  assert.match(hook, /npm run crap:check/);
  const captureIdx = hook.indexOf('coverage-capture.js');
  const crapIdx = hook.indexOf('npm run crap:check');
  assert.ok(
    captureIdx > -1 && crapIdx > captureIdx,
    'crap:check must run after coverage-capture',
  );
});

test('pre-push — documents npm run verify for the full local gate', () => {
  const hook = readPrePush();
  assert.match(hook, /npm run verify/);
  assert.match(hook, /CI/i);
});

test('pre-push — optional audit remains opt-in via PREPUSH_AUDIT', () => {
  const hook = readPrePush();
  assert.match(hook, /PREPUSH_AUDIT/);
  assert.match(hook, /npm audit --audit-level=high/);
});
