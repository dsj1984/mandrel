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

// Story #3162 — STORY_CLOSE_RECOVERY env var gates a scoped coverage skip
// for operator recovery pushes targeting epic/<id>. The hook delegates the
// decision to check-prepush-recovery.js so the gating logic stays testable
// in isolation; here we assert the wiring is present.
test('pre-push — STORY_CLOSE_RECOVERY scoped skip wired to coverage gate', () => {
  const hook = readPrePush();
  assert.match(hook, /STORY_CLOSE_RECOVERY/);
  assert.match(hook, /check-prepush-recovery\.js/);
  // The skip branch must wrap BOTH coverage-capture and crap:check so a
  // pre-existing CRAP regression on epic/<id> also clears (the CRAP gate
  // reads the freshly-captured coverage; gating only the capture would
  // leave CRAP failing on stale numbers).
  const helperIdx = hook.indexOf('check-prepush-recovery.js');
  const captureIdx = hook.indexOf(
    'coverage-capture.js --skip-when-no-crap-files',
  );
  const crapIdx = hook.indexOf('npm run crap:check');
  assert.ok(
    helperIdx > -1 && captureIdx > helperIdx && crapIdx > captureIdx,
    'recovery helper must precede both coverage-capture and crap:check so both are gated',
  );
});
