/**
 * tests/contract/check-prepush-recovery.test.js — Story #3162.
 *
 * Contract: the pre-push coverage-gate skip helper must exit 0 (skip the
 * gate) only when STORY_CLOSE_RECOVERY=1 AND the push targets an
 * `epic/<id>` ref; in every other combination it must exit 1 so the
 * coverage chain still runs as today.
 *
 * We pin both the pure decision function and the CLI surface (exit code
 * + the auditable log line) because the CLI is the contract the husky
 * hook depends on.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parsePrePushLocalRefs,
  shouldSkipCoverageGate,
} from '../../.agents/scripts/check-prepush-recovery.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SCRIPT = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'check-prepush-recovery.js',
);
const SKIP_LOG = '[pre-push] coverage gate skipped by STORY_CLOSE_RECOVERY';

const EPIC_REF_LINE =
  'refs/heads/epic/123 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef ' +
  'refs/heads/epic/123 0000000000000000000000000000000000000000';
const STORY_REF_LINE =
  'refs/heads/story-104 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef ' +
  'refs/heads/story-104 0000000000000000000000000000000000000000';
const MAIN_REF_LINE =
  'refs/heads/main deadbeefdeadbeefdeadbeefdeadbeefdeadbeef ' +
  'refs/heads/main 0000000000000000000000000000000000000000';

function runHelper({ env, stdin }) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: stdin ?? '',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('parsePrePushLocalRefs — extracts local ref from each non-empty line', () => {
  const refs = parsePrePushLocalRefs(`${EPIC_REF_LINE}\n${STORY_REF_LINE}\n`);
  assert.deepEqual(refs, ['refs/heads/epic/123', 'refs/heads/story-104']);
});

test('parsePrePushLocalRefs — empty / whitespace stdin yields empty array', () => {
  assert.deepEqual(parsePrePushLocalRefs(''), []);
  assert.deepEqual(parsePrePushLocalRefs('\n\n'), []);
  assert.deepEqual(parsePrePushLocalRefs(undefined), []);
});

test('shouldSkipCoverageGate — skip ONLY when env=1 AND an epic/<id> ref is in the push', () => {
  // Happy path: env set + epic ref → skip.
  assert.equal(
    shouldSkipCoverageGate({ env: '1', localRefs: ['refs/heads/epic/123'] }),
    true,
  );
  // Mixed push that includes an epic ref → skip (operator pushing multiple
  // branches in one invocation; the recovery push is in there).
  assert.equal(
    shouldSkipCoverageGate({
      env: '1',
      localRefs: ['refs/heads/story-104', 'refs/heads/epic/9'],
    }),
    true,
  );
});

test('shouldSkipCoverageGate — env unset → never skip, even with epic ref', () => {
  assert.equal(
    shouldSkipCoverageGate({
      env: undefined,
      localRefs: ['refs/heads/epic/123'],
    }),
    false,
  );
  assert.equal(
    shouldSkipCoverageGate({ env: '0', localRefs: ['refs/heads/epic/123'] }),
    false,
  );
  // Loose truthy values are NOT honored — must be exactly "1" so a stray
  // STORY_CLOSE_RECOVERY=true in shell history cannot accidentally bypass.
  assert.equal(
    shouldSkipCoverageGate({ env: 'true', localRefs: ['refs/heads/epic/123'] }),
    false,
  );
});

test('shouldSkipCoverageGate — env=1 but no epic ref → do not skip', () => {
  assert.equal(
    shouldSkipCoverageGate({ env: '1', localRefs: ['refs/heads/story-104'] }),
    false,
  );
  assert.equal(
    shouldSkipCoverageGate({ env: '1', localRefs: ['refs/heads/main'] }),
    false,
  );
  assert.equal(shouldSkipCoverageGate({ env: '1', localRefs: [] }), false);
});

test('shouldSkipCoverageGate — ref must be exactly under refs/heads/epic/ (no prefix tricks)', () => {
  // A branch literally named "epic-foo" must NOT match — only the
  // canonical epic/<id> shape qualifies.
  assert.equal(
    shouldSkipCoverageGate({ env: '1', localRefs: ['refs/heads/epic-foo'] }),
    false,
  );
  // Tag refs do not count even if they contain "epic/" in the name.
  assert.equal(
    shouldSkipCoverageGate({ env: '1', localRefs: ['refs/tags/epic/123'] }),
    false,
  );
});

test('CLI — exits 0 and emits audit log when env=1 + epic ref on stdin', () => {
  const result = runHelper({
    env: { STORY_CLOSE_RECOVERY: '1' },
    stdin: `${EPIC_REF_LINE}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(SKIP_LOG.replace(/[[\]]/g, '\\$&')));
});

test('CLI — exits 1 (run coverage) when env unset, even with epic ref', () => {
  const result = runHelper({
    env: { STORY_CLOSE_RECOVERY: '' },
    stdin: `${EPIC_REF_LINE}\n`,
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /skipped/);
});

test('CLI — exits 1 (run coverage) when env=1 but no epic ref in push', () => {
  const result = runHelper({
    env: { STORY_CLOSE_RECOVERY: '1' },
    stdin: `${STORY_REF_LINE}\n${MAIN_REF_LINE}\n`,
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /skipped/);
});

test('CLI — exits 1 when stdin is empty (no refs to push)', () => {
  const result = runHelper({
    env: { STORY_CLOSE_RECOVERY: '1' },
    stdin: '',
  });
  assert.equal(result.status, 1);
});
