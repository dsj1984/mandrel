/**
 * Unit tests for the active-Story env-var propagation surface used by
 * `story-init.js` (Epic #1030 Story #1043 / Task #1061).
 *
 * The AC for Task #1061 reads: *"story-init unit tests show CC_EPIC_ID
 * and CC_STORY_ID set to the active ids"*. The full `runStoryInit`
 * pipeline is exercised end-to-end by `tests/story-off-branch-e2e.test.js`
 * and the Story #1006 triage suite; here we cover the narrower
 * contract: `setActiveStoryEnv` writes the two vars + the worktree
 * `.env.local`, and `clearActiveStoryEnv` reverses both effects.
 *
 * The helper in `lib/observability/active-story-env.js` is the single
 * writer/clearer of those env vars — `story-init.js` and
 * `story-close/post-merge-close.js` are its only callers — so testing
 * the helper directly gives us full coverage of the
 * "set during a Story / unset outside one" contract that the trace
 * hook relies on.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ACTIVE_STORY_ENV_KEYS,
  clearActiveStoryEnv,
  renderActiveStoryEnvFile,
  setActiveStoryEnv,
} from '../../../.agents/scripts/lib/observability/active-story-env.js';

let workCwd;
let env;

beforeEach(() => {
  workCwd = mkdtempSync(path.join(tmpdir(), 'story-init-env-'));
  // Use a fresh per-test env bag so we don't disturb the host process.
  env = {};
});

afterEach(() => {
  rmSync(workCwd, { recursive: true, force: true });
});

describe('story-init env propagation — setActiveStoryEnv', () => {
  it('sets CC_EPIC_ID and CC_STORY_ID on the env bag to the active ids', () => {
    const result = setActiveStoryEnv({
      epicId: 1030,
      storyId: 1043,
      workCwd,
      env,
    });
    assert.equal(result.envSet, true);
    assert.equal(env.CC_EPIC_ID, '1030');
    assert.equal(env.CC_STORY_ID, '1043');
  });

  it('writes a .env.local file inside the worktree with the same ids', () => {
    setActiveStoryEnv({ epicId: 1030, storyId: 1043, workCwd, env });
    const envFile = path.join(workCwd, '.env.local');
    assert.equal(existsSync(envFile), true);
    const body = readFileSync(envFile, 'utf8');
    assert.match(body, /^CC_EPIC_ID=1030$/m);
    assert.match(body, /^CC_STORY_ID=1043$/m);
  });

  it('overwrites an existing .env.local on a re-run with new ids', () => {
    setActiveStoryEnv({ epicId: 1030, storyId: 1043, workCwd, env });
    setActiveStoryEnv({ epicId: 1030, storyId: 1099, workCwd, env });
    const body = readFileSync(path.join(workCwd, '.env.local'), 'utf8');
    assert.equal(env.CC_STORY_ID, '1099');
    assert.match(body, /^CC_STORY_ID=1099$/m);
    assert.doesNotMatch(body, /^CC_STORY_ID=1043$/m);
  });

  it('rejects non-positive ids (defensive: prevents bogus env values)', () => {
    assert.throws(
      () => setActiveStoryEnv({ epicId: 0, storyId: 1, workCwd, env }),
      /epicId must be a positive integer/,
    );
    assert.throws(
      () => setActiveStoryEnv({ epicId: 1, storyId: -2, workCwd, env }),
      /storyId must be a positive integer/,
    );
  });

  it('skips the .env.local write when workCwd is omitted but still sets env vars', () => {
    const result = setActiveStoryEnv({ epicId: 1030, storyId: 1043, env });
    assert.equal(result.envSet, true);
    assert.equal(result.fileWritten, false);
    assert.equal(env.CC_EPIC_ID, '1030');
    assert.equal(env.CC_STORY_ID, '1043');
  });

  it('warns (not throws) when the .env.local write fails', () => {
    const warnings = [];
    const stubFs = {
      writeFileSync: () => {
        throw new Error('EACCES: read-only filesystem');
      },
    };
    const result = setActiveStoryEnv({
      epicId: 1030,
      storyId: 1043,
      workCwd,
      env,
      fs: stubFs,
      logger: { warn: (m) => warnings.push(m) },
    });
    assert.equal(result.fileWritten, false);
    assert.equal(env.CC_EPIC_ID, '1030');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Failed to write/);
  });
});

describe('story-init env propagation — clearActiveStoryEnv', () => {
  it('removes both env vars and the .env.local file on close', () => {
    setActiveStoryEnv({ epicId: 1030, storyId: 1043, workCwd, env });
    const envFile = path.join(workCwd, '.env.local');
    assert.equal(existsSync(envFile), true);

    const result = clearActiveStoryEnv({ workCwd, env });
    assert.equal(result.envCleared, true);
    assert.equal(result.fileRemoved, true);
    assert.equal(env.CC_EPIC_ID, undefined);
    assert.equal(env.CC_STORY_ID, undefined);
    assert.equal(existsSync(envFile), false);
  });

  it('is a safe no-op when the env vars and file are already absent', () => {
    const result = clearActiveStoryEnv({ workCwd, env });
    assert.equal(result.envCleared, true);
    assert.equal(result.fileRemoved, false);
  });

  it('clears env vars even when workCwd is omitted', () => {
    env.CC_EPIC_ID = '1030';
    env.CC_STORY_ID = '1043';
    clearActiveStoryEnv({ env });
    for (const k of ACTIVE_STORY_ENV_KEYS) {
      assert.equal(env[k], undefined);
    }
  });
});

describe('story-init env propagation — renderActiveStoryEnvFile', () => {
  it('emits a deterministic body with both ids on their own lines', () => {
    const body = renderActiveStoryEnvFile({ epicId: 1030, storyId: 1043 });
    assert.match(body, /^CC_EPIC_ID=1030$/m);
    assert.match(body, /^CC_STORY_ID=1043$/m);
    // Every line ends with LF (deterministic across platforms).
    assert.equal(body.includes('\r'), false);
  });
});
