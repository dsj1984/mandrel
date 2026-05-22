/**
 * Unit tests for `active-story-env.js`.
 *
 * Story #2874 — verifies the null-epicId standalone-Story contract:
 *   - `setActiveStoryEnv({ epicId: null, storyId, workCwd })` succeeds
 *     and writes only `CC_STORY_ID` to env + `.env.local`.
 *   - `renderActiveStoryEnvFile` omits the `CC_EPIC_ID=` line when
 *     `epicId === null`.
 *   - All other invalid `epicId` values (0, negative, NaN, non-int)
 *     still throw — `null` is the only standalone signal.
 *   - `clearActiveStoryEnv` still works the same way.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ACTIVE_STORY_ENV_KEYS,
  clearActiveStoryEnv,
  renderActiveStoryEnvFile,
  setActiveStoryEnv,
} from '../../../.agents/scripts/lib/observability/active-story-env.js';

let tmp;
let env;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'active-story-env-test-'));
  env = {};
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('renderActiveStoryEnvFile — null epicId omits CC_EPIC_ID line', () => {
  it('includes CC_EPIC_ID line when epicId is a positive integer', () => {
    const body = renderActiveStoryEnvFile({ epicId: 42, storyId: 7 });
    assert.match(body, /CC_EPIC_ID=42/);
    assert.match(body, /CC_STORY_ID=7/);
  });

  it('omits CC_EPIC_ID line entirely when epicId === null', () => {
    const body = renderActiveStoryEnvFile({ epicId: null, storyId: 7 });
    assert.doesNotMatch(body, /CC_EPIC_ID/);
    assert.match(body, /CC_STORY_ID=7/);
  });
});

describe('setActiveStoryEnv — accepts null epicId (Story #2874)', () => {
  it('null epicId: sets CC_STORY_ID, does NOT set CC_EPIC_ID', () => {
    const result = setActiveStoryEnv({
      epicId: null,
      storyId: 42,
      env,
    });
    assert.equal(result.envSet, true);
    assert.equal(env.CC_STORY_ID, '42');
    assert.equal('CC_EPIC_ID' in env, false);
  });

  it('null epicId: removes pre-existing CC_EPIC_ID (no empty-string fallthrough)', () => {
    env.CC_EPIC_ID = '99';
    setActiveStoryEnv({ epicId: null, storyId: 42, env });
    assert.equal('CC_EPIC_ID' in env, false);
  });

  it('null epicId: writes .env.local without CC_EPIC_ID line', () => {
    const result = setActiveStoryEnv({
      epicId: null,
      storyId: 42,
      workCwd: tmp,
      env,
    });
    assert.equal(result.fileWritten, true);
    const body = readFileSync(result.filePath, 'utf8');
    assert.doesNotMatch(body, /CC_EPIC_ID/);
    assert.match(body, /CC_STORY_ID=42/);
  });

  it('positive-integer epicId: behaviour unchanged (CC_EPIC_ID set)', () => {
    setActiveStoryEnv({ epicId: 1030, storyId: 1042, env });
    assert.equal(env.CC_EPIC_ID, '1030');
    assert.equal(env.CC_STORY_ID, '1042');
  });
});

describe('setActiveStoryEnv — non-null invalid epicId still throws', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, 'fish']) {
    it(`epicId=${String(bad)} → throws`, () => {
      assert.throws(
        () => setActiveStoryEnv({ epicId: bad, storyId: 1, env }),
        /epicId must be a positive integer or null/,
      );
    });
  }
});

describe('setActiveStoryEnv — storyId validation unchanged', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, null, undefined]) {
    it(`storyId=${String(bad)} → throws`, () => {
      assert.throws(
        () => setActiveStoryEnv({ epicId: null, storyId: bad, env }),
        /storyId must be a positive integer/,
      );
    });
  }
});

describe('clearActiveStoryEnv — unchanged', () => {
  it('removes both env vars when present', () => {
    env.CC_EPIC_ID = '1';
    env.CC_STORY_ID = '2';
    clearActiveStoryEnv({ env });
    for (const k of ACTIVE_STORY_ENV_KEYS) {
      assert.equal(k in env, false);
    }
  });

  it('removes only CC_STORY_ID when CC_EPIC_ID was never set (standalone close)', () => {
    env.CC_STORY_ID = '2';
    const result = clearActiveStoryEnv({ env });
    assert.equal(result.envCleared, true);
    assert.equal('CC_STORY_ID' in env, false);
  });

  it('removes .env.local when present', () => {
    setActiveStoryEnv({ epicId: null, storyId: 7, workCwd: tmp, env });
    const filePath = path.join(tmp, '.env.local');
    assert.equal(existsSync(filePath), true);
    clearActiveStoryEnv({ workCwd: tmp, env });
    assert.equal(existsSync(filePath), false);
  });
});
