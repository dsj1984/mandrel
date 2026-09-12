/**
 * tests/lib/orchestration/review-base-ref.test.js — the base ref a
 * Story-scope review is allowed to measure against (Story #5325).
 *
 * The behaviour under test is a refusal: there is no local-ref fallback, so
 * every path that cannot verify `origin/<base>` must report "unresolved" and
 * let the caller degrade, rather than quietly handing back a ref whose drift
 * would be scored as the Story's own change.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  remoteBaseRef,
  resolveSharedBaseRef,
  unresolvedBaseReviewOutcome,
} from '../../../.agents/scripts/lib/orchestration/review-base-ref.js';

const found = { status: 0, stdout: 'deadbeefdeadbeef\n', stderr: '' };
const missing = { status: 1, stdout: '', stderr: '' };

describe('remoteBaseRef', () => {
  it('qualifies a bare branch name and passes an already-qualified one through', () => {
    assert.equal(remoteBaseRef('main'), 'origin/main');
    assert.equal(remoteBaseRef('  trunk  '), 'origin/trunk');
    assert.equal(remoteBaseRef('origin/main'), 'origin/main');
  });

  it('returns null for input that cannot name a ref', () => {
    assert.equal(remoteBaseRef(''), null);
    assert.equal(remoteBaseRef('   '), null);
    assert.equal(remoteBaseRef(undefined), null);
    assert.equal(remoteBaseRef(42), null);
  });
});

describe('resolveSharedBaseRef', () => {
  it('resolves the remote-tracking ref when git can verify it', () => {
    const seen = [];
    const out = resolveSharedBaseRef({
      baseBranch: 'main',
      cwd: '/repo',
      gitSpawnFn: (_cwd, ...args) => {
        seen.push(args);
        return found;
      },
    });
    assert.deepEqual(out, {
      ref: 'origin/main',
      resolved: true,
      remoteRef: 'origin/main',
    });
    // The probe must pin a commit, so a tag or a stray path of the same name
    // cannot answer for the branch.
    assert.deepEqual(seen, [
      ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'],
    ]);
  });

  it('reports unresolved — never the local ref — when the remote ref is absent', () => {
    const out = resolveSharedBaseRef({
      baseBranch: 'main',
      cwd: '/repo',
      gitSpawnFn: () => missing,
    });
    assert.deepEqual(out, {
      ref: null,
      resolved: false,
      remoteRef: 'origin/main',
    });
  });

  it('treats a throwing git spawn as unresolved rather than propagating', () => {
    const out = resolveSharedBaseRef({
      baseBranch: 'main',
      cwd: '/repo',
      gitSpawnFn: () => {
        throw new Error('git is not installed');
      },
    });
    assert.equal(out.resolved, false);
    assert.equal(out.ref, null);
  });

  it('reports unresolved without probing when the base cannot be named', () => {
    let probed = false;
    const out = resolveSharedBaseRef({
      baseBranch: '',
      gitSpawnFn: () => {
        probed = true;
        return found;
      },
    });
    assert.deepEqual(out, { ref: null, resolved: false, remoteRef: null });
    assert.equal(probed, false);
  });
});

describe('unresolvedBaseReviewOutcome', () => {
  it('degrades loudly, scores nothing, and blocks nothing', () => {
    const lines = [];
    const out = unresolvedBaseReviewOutcome({
      storyId: 5325,
      baseBranch: 'main',
      remoteRef: 'origin/main',
      progress: (tag, msg) => lines.push([tag, msg]),
    });

    assert.equal(out.halted, false);
    assert.equal(out.skipped, true);
    assert.equal(out.posted, false);
    assert.deepEqual(out.severity, {
      critical: 0,
      high: 0,
      medium: 0,
      suggestion: 0,
    });
    assert.equal(out.degraded, true);
    assert.deepEqual(out.degradations, [
      {
        tool: 'story-scope-review',
        gate: 'base-ref-resolution',
        surface: 'origin/main',
        reason: 'remote-base-ref-unresolved',
      },
    ]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], 'REVIEW');
    assert.ok(lines[0][1].includes('origin/main'));
  });

  it('names the ref it would have probed when the remote ref is unknown', () => {
    const lines = [];
    const out = unresolvedBaseReviewOutcome({
      storyId: 5325,
      baseBranch: 'trunk',
      remoteRef: null,
      progress: (_tag, msg) => lines.push(msg),
      progressTag: 'CODE-REVIEW',
    });
    assert.equal(out.degradations[0].surface, 'origin/trunk');
    assert.ok(lines[0].includes('origin/trunk'));
  });
});
