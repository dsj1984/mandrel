/**
 * Unit tests for `active-story-env.js`.
 *
 * v2 Stories are standalone — there is no parent Epic — so this module writes
 * only `CC_STORY_ID`:
 *   - `setActiveStoryEnv({ storyId, workCwd })` writes `CC_STORY_ID` to env +
 *     `.env.local`, and never `CC_EPIC_ID` (the trace hook's no-op contract is
 *     keyed on that var's ABSENCE, so an empty-string value would break it).
 *   - A pre-existing `CC_EPIC_ID` is removed, so a leaked value cannot key
 *     this Story's traces to a foreign Epic directory.
 *   - `clearActiveStoryEnv` wipes what the trace path reads.
 *
 * A22 — the `story.heartbeat` substrate was deleted (its emitter demanded an
 * `epicId >= 1` that v2 never supplies, so it could never fire). The slice env
 * surface (`setActiveSliceEnv` / `renderActiveSliceEnvFile`, `CC_SLICE_ID`,
 * `CC_OPERATOR`) existed only to feed it and went with it; its tests are gone
 * with the code they covered.
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

describe('renderActiveStoryEnvFile — writes CC_STORY_ID only', () => {
  it('emits the CC_STORY_ID line', () => {
    const body = renderActiveStoryEnvFile({ storyId: 7 });
    assert.match(body, /CC_STORY_ID=7/);
  });

  it('never emits a CC_EPIC_ID line', () => {
    const body = renderActiveStoryEnvFile({ storyId: 7 });
    assert.doesNotMatch(body, /CC_EPIC_ID/);
  });
});

describe('setActiveStoryEnv', () => {
  it('sets CC_STORY_ID and does NOT set CC_EPIC_ID', () => {
    const result = setActiveStoryEnv({ storyId: 42, env });
    assert.equal(result.envSet, true);
    assert.equal(env.CC_STORY_ID, '42');
    assert.equal('CC_EPIC_ID' in env, false);
  });

  it('removes a pre-existing CC_EPIC_ID (no empty-string fallthrough)', () => {
    env.CC_EPIC_ID = '99';
    setActiveStoryEnv({ storyId: 42, env });
    assert.equal('CC_EPIC_ID' in env, false);
  });

  it('writes .env.local without a CC_EPIC_ID line', () => {
    const result = setActiveStoryEnv({ storyId: 42, workCwd: tmp, env });
    assert.equal(result.fileWritten, true);
    const body = readFileSync(result.filePath, 'utf8');
    assert.doesNotMatch(body, /CC_EPIC_ID/);
    assert.match(body, /CC_STORY_ID=42/);
  });
});

describe('setActiveStoryEnv — storyId validation unchanged', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, null, undefined, 'fish']) {
    it(`storyId=${String(bad)} → throws`, () => {
      assert.throws(
        () => setActiveStoryEnv({ storyId: bad, env }),
        /storyId must be a positive integer/,
      );
    });
  }
});

describe('clearActiveStoryEnv', () => {
  it('removes every owned env var when present', () => {
    env.CC_EPIC_ID = '1';
    env.CC_STORY_ID = '2';
    clearActiveStoryEnv({ env });
    for (const k of ACTIVE_STORY_ENV_KEYS) {
      assert.equal(k in env, false);
    }
  });

  it('removes only CC_STORY_ID when CC_EPIC_ID was never set', () => {
    env.CC_STORY_ID = '2';
    const result = clearActiveStoryEnv({ env });
    assert.equal(result.envCleared, true);
    assert.equal('CC_STORY_ID' in env, false);
  });

  it('removes .env.local when present', () => {
    setActiveStoryEnv({ storyId: 7, workCwd: tmp, env });
    const filePath = path.join(tmp, '.env.local');
    assert.equal(existsSync(filePath), true);
    clearActiveStoryEnv({ workCwd: tmp, env });
    assert.equal(existsSync(filePath), false);
  });
});
