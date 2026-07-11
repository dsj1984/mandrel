/**
 * Unit coverage for `assertSharedCheckoutAvailable`
 * (lib/orchestration/story-close/shared-checkout-guard.js — Story #4460).
 *
 * Covers the acceptance-criteria scenarios directly:
 *   (a) a foreign (different-epic) live lock is refused with the new
 *       story-close-specific diagnostic instead of a raw git error;
 *   (b) same-epic runs are unaffected — this guard only looks at OTHER
 *       epics' lock files, so it never fires on the caller's own epic id
 *       (that serialization stays solely on `withEpicMergeLock`);
 *   (c) a clean checkout on the caller's own epic branch proceeds
 *       normally (no throw), including when the tree is merely dirty
 *       with no foreign lock present (a distinct diagnostic naming the
 *       dirty files).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertSharedCheckoutAvailable } from '../../../../.agents/scripts/lib/orchestration/story-close/shared-checkout-guard.js';

function gitStub(routes = {}) {
  const calls = [];
  return {
    calls,
    gitSpawn: (cwd, ...args) => {
      calls.push({ cwd, args });
      const key = args.join(' ');
      const route = routes[key];
      if (typeof route === 'function') return route(cwd, args);
      return route ?? { status: 0, stdout: '', stderr: '' };
    },
  };
}

describe('assertSharedCheckoutAvailable — foreign-epic collision (scenario a)', () => {
  it('throws a story-close-specific diagnostic naming the foreign epic + pid + lock path', () => {
    const acquiredAt = Date.parse('2026-07-11T12:00:00.000Z');
    const findForeignActiveEpicLock = () => ({
      epicId: '4405',
      filePath: '/repo/.git/epic-4405.merge.lock',
      pid: 55555,
      acquiredAt,
    });
    const stub = gitStub();

    assert.throws(
      () =>
        assertSharedCheckoutAvailable({
          cwd: '/repo',
          epicId: 4425,
          gitSpawn: stub.gitSpawn,
          findForeignActiveEpicLock,
        }),
      (err) => {
        assert.match(err.message, /shared-checkout guard/);
        assert.match(err.message, /epic #4405/);
        assert.match(err.message, /pid 55555/);
        assert.match(err.message, /epic-4405\.merge\.lock/);
        assert.match(err.message, /2026-07-11T12:00:00\.000Z/);
        return true;
      },
    );
    // Refused before ever probing git status — the foreign-lock check
    // short-circuits.
    assert.equal(stub.calls.length, 0);
  });

  it("never treats the caller's own epic id as foreign (composes with, does not replace, the per-epic lock)", () => {
    // Simulates the real findForeignActiveEpicLock contract: it already
    // excludes the caller's own epicId namespace, so a same-epic
    // concurrent run always resolves to null here — same-epic
    // serialization remains solely owned by withEpicMergeLock upstream.
    const findForeignActiveEpicLock = (epicId) => {
      assert.equal(epicId, 4425);
      return null;
    };
    const stub = gitStub({
      'status --porcelain': { status: 0, stdout: '', stderr: '' },
    });

    assert.doesNotThrow(() =>
      assertSharedCheckoutAvailable({
        cwd: '/repo',
        epicId: 4425,
        gitSpawn: stub.gitSpawn,
        findForeignActiveEpicLock,
      }),
    );
  });
});

describe('assertSharedCheckoutAvailable — dirty shared checkout (no foreign lock)', () => {
  it('throws naming the dirty files and current branch when no foreign lock is held', () => {
    const findForeignActiveEpicLock = () => null;
    const stub = gitStub({
      'status --porcelain': {
        status: 0,
        stdout: ' M finalizer.js\n?? scratch.test.js\n',
        stderr: '',
      },
      'rev-parse --abbrev-ref HEAD': {
        status: 0,
        stdout: 'epic/4405\n',
        stderr: '',
      },
    });

    assert.throws(
      () =>
        assertSharedCheckoutAvailable({
          cwd: '/repo',
          epicId: 4425,
          gitSpawn: stub.gitSpawn,
          findForeignActiveEpicLock,
        }),
      (err) => {
        assert.match(err.message, /shared-checkout guard/);
        assert.match(err.message, /epic #4425/);
        assert.match(err.message, /currently on `epic\/4405`/);
        assert.match(err.message, /finalizer\.js/);
        assert.match(err.message, /scratch\.test\.js/);
        return true;
      },
    );
  });

  it('falls back to "unknown" branch when rev-parse fails', () => {
    const findForeignActiveEpicLock = () => null;
    const stub = gitStub({
      'status --porcelain': { status: 0, stdout: ' M x.js\n', stderr: '' },
      'rev-parse --abbrev-ref HEAD': { status: 1, stdout: '', stderr: 'boom' },
    });

    assert.throws(
      () =>
        assertSharedCheckoutAvailable({
          cwd: '/repo',
          epicId: 1,
          gitSpawn: stub.gitSpawn,
          findForeignActiveEpicLock,
        }),
      /currently on `unknown`/,
    );
  });

  it('truncates the dirty-file listing past the cap with an overflow count', () => {
    const findForeignActiveEpicLock = () => null;
    const many = Array.from({ length: 25 }, (_, i) => ` M file-${i}.js`).join(
      '\n',
    );
    const stub = gitStub({
      'status --porcelain': { status: 0, stdout: many, stderr: '' },
      'rev-parse --abbrev-ref HEAD': {
        status: 0,
        stdout: 'epic/1\n',
        stderr: '',
      },
    });

    assert.throws(
      () =>
        assertSharedCheckoutAvailable({
          cwd: '/repo',
          epicId: 1,
          gitSpawn: stub.gitSpawn,
          findForeignActiveEpicLock,
        }),
      /\+5 more/,
    );
  });
});

describe('assertSharedCheckoutAvailable — clean checkout proceeds normally (scenario c)', () => {
  it('does not throw when there is no foreign lock and the tree is clean', () => {
    const findForeignActiveEpicLock = () => null;
    const stub = gitStub({
      'status --porcelain': { status: 0, stdout: '', stderr: '' },
    });

    assert.doesNotThrow(() =>
      assertSharedCheckoutAvailable({
        cwd: '/repo',
        epicId: 4425,
        gitSpawn: stub.gitSpawn,
        findForeignActiveEpicLock,
      }),
    );
  });

  it('does not throw when `git status` itself fails to run (defers to the downstream checkout)', () => {
    const findForeignActiveEpicLock = () => null;
    const stub = gitStub({
      'status --porcelain': { status: 128, stdout: '', stderr: 'not a repo' },
    });

    assert.doesNotThrow(() =>
      assertSharedCheckoutAvailable({
        cwd: '/repo',
        epicId: 4425,
        gitSpawn: stub.gitSpawn,
        findForeignActiveEpicLock,
      }),
    );
  });

  it('uses the real findForeignActiveEpicLock default when not overridden, against a non-repo cwd', () => {
    // No injected findForeignActiveEpicLock — exercises the real default
    // wired from epic-merge-lock.js against a cwd with no .git directory,
    // which resolves to "no foreign lock" rather than throwing.
    const stub = gitStub({
      'status --porcelain': { status: 0, stdout: '', stderr: '' },
    });

    assert.doesNotThrow(() =>
      assertSharedCheckoutAvailable({
        cwd: '/tmp/mandrel-shared-checkout-guard-default-test-nonexistent',
        epicId: 4425,
        gitSpawn: stub.gitSpawn,
      }),
    );
  });
});
