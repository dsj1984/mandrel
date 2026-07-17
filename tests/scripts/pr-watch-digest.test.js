/**
 * pr-watch-digest.test.js — Story #4539.
 *
 * The red-path CI digest was Epic-scoped by filename and bailed out
 * (`return null`) whenever no story id was supplied. The v2 Story delivery
 * path has no Epic and invoked the watch with `--pr` alone, so a red check
 * wrote no digest at all — while the module header advertised one. These
 * tests pin the Story-scoped keying and the no-scope bail-out.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  resolveDigestScope,
  writeCiDigest,
} from '../../.agents/scripts/pr-watch-with-update.js';

const FAILURES = [
  { name: 'test', outcome: 'failure' },
  { name: 'lint', outcome: 'failure' },
];

function withTempRoot(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mandrel-digest-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolveDigestScope', () => {
  it('keys on the Story id — the only scope the v2 delivery path has', () => {
    assert.deepEqual(resolveDigestScope({ storyId: 4539 }), {
      kind: 'story',
      id: 4539,
    });
  });

  it('returns null with no scope at all — nothing to key a filename on', () => {
    assert.equal(resolveDigestScope({}), null);
    assert.equal(resolveDigestScope({ storyId: '' }), null);
    assert.equal(resolveDigestScope({ storyId: 'nope' }), null);
  });
});

describe('writeCiDigest', () => {
  it('writes a Story-keyed digest naming the failing check, run id, and log tail', () => {
    withTempRoot((tempRoot) => {
      const out = writeCiDigest({
        storyId: 4539,
        prNumber: 12,
        failures: FAILURES,
        tempRoot,
        cwd: tempRoot,
        prRef: '12',
        runIdFn: () => '987654',
        logTailFn: () => 'AssertionError: boom',
      });

      assert.ok(out, 'a Story-scoped red path writes a digest');
      assert.equal(path.basename(out.jsonPath), 'story-4539-ci-digest.json');
      assert.equal(path.basename(out.mdPath), 'story-4539-ci-digest.md');

      const digest = JSON.parse(readFileSync(out.jsonPath, 'utf8'));
      assert.equal(digest.storyId, 4539);
      assert.equal(digest.epicId, undefined, 'no Epic key on a Story digest');
      assert.equal(digest.failingCheck, 'test');
      assert.equal(digest.runId, '987654');
      assert.deepEqual(digest.allFailures, FAILURES);

      const md = readFileSync(out.mdPath, 'utf8');
      assert.match(md, /# CI failure digest — Story #4539 \(PR #12\)/);
      assert.match(md, /AssertionError: boom/);
      assert.match(md, /`lint`=failure/, 'secondary failures are listed');
    });
  });

  it('returns null when neither scope is supplied, rather than writing an unkeyed file', () => {
    withTempRoot((tempRoot) => {
      const out = writeCiDigest({
        prNumber: 12,
        failures: FAILURES,
        tempRoot,
        cwd: tempRoot,
        prRef: '12',
        runIdFn: () => '1',
        logTailFn: () => '',
      });
      assert.equal(out, null);
    });
  });
});
