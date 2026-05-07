/**
 * Unit tests for `lib/observability/tool-trace-hook.js` (Epic #1030
 * Story #1043 / Task #1058). Covers:
 *   - Pre/Post pairing (durationMs is computed from the matching Pre).
 *   - The env-var no-op (CC_EPIC_ID unset => zero filesystem calls).
 *   - Hashing of Bash commands and file paths (raw value never lands
 *     on disk — `details.targetHash` is `sha256:<hex>`).
 *   - Top-level exception swallowing (a malformed event must not throw).
 *   - PostToolUse without a matching PreToolUse logs once and returns
 *     without throwing (durationMs: null).
 *
 * Each test uses an isolated `os.tmpdir()` workspace and threads it
 * through the writer's `config.paths.tempRoot`. The hook reads the env
 * vars internally; we set them per-test and restore at teardown.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  _resetInflightForTests,
  handlePost,
  handlePre,
  main,
  resolveActiveStory,
} from '../../../.agents/scripts/lib/observability/tool-trace-hook.js';

let workRoot;
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

// The hook calls appendTrace without a `config` arg, so the writer
// resolves tempRoot via the project default of `'temp'` relative to
// process.cwd(). We chdir into `workRoot` per-test, so the on-disk
// layout is `<workRoot>/temp/epic-<eid>/story-<sid>/...`.
const tracesPath = (eid, sid) =>
  path.join(workRoot, 'temp', `epic-${eid}`, `story-${sid}`, 'traces.ndjson');
const signalsPath = (eid, sid) =>
  path.join(workRoot, 'temp', `epic-${eid}`, `story-${sid}`, 'signals.ndjson');

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'tool-trace-hook-'));
  _resetInflightForTests();
  process.env.CC_EPIC_ID = '1030';
  process.env.CC_STORY_ID = '1043';
  // The signals-writer reads tempRoot from `resolveConfig` when no
  // `config` arg is threaded. We point AGENTRC_PATHS_TEMPROOT at the
  // tmpdir via the lower-level fallback: tempRootFrom() honors
  // `config.paths.tempRoot`, but since we're calling appendTrace
  // through the hook (no config arg), we set the env-resolved path by
  // pointing PROJECT_ROOT-equivalent at workRoot via cwd when needed.
  // The simplest cross-platform handle: spawn the hook into a tree
  // where `temp/` resolves to workRoot. We do that by chdir-ing.
  process.chdir(workRoot);
});

afterEach(() => {
  // Restore env. Keys we set must be deleted so they don't leak across
  // tests; everything else returns to its pre-test value.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
  // Restore cwd before removal — Windows refuses `rmSync` on the
  // current working directory (EPERM via the `\\?\` long-path prefix).
  try {
    process.chdir(ORIGINAL_CWD);
  } catch {
    // Best-effort; if the original cwd has gone we'll still try the rm.
  }
  rmSync(workRoot, { recursive: true, force: true });
});

describe('tool-trace-hook — resolveActiveStory env-var resolution', () => {
  it('returns null when CC_EPIC_ID is unset', () => {
    const active = resolveActiveStory({ CC_STORY_ID: '1043' });
    assert.equal(active, null);
  });

  it('returns null when CC_STORY_ID is unset', () => {
    const active = resolveActiveStory({ CC_EPIC_ID: '1030' });
    assert.equal(active, null);
  });

  it('returns null when ids are non-numeric', () => {
    assert.equal(
      resolveActiveStory({ CC_EPIC_ID: 'oops', CC_STORY_ID: '1' }),
      null,
    );
    assert.equal(
      resolveActiveStory({ CC_EPIC_ID: '1', CC_STORY_ID: 'nope' }),
      null,
    );
  });

  it('returns parsed numeric ids when both are valid', () => {
    const active = resolveActiveStory({
      CC_EPIC_ID: '1030',
      CC_STORY_ID: '1043',
    });
    assert.deepEqual(active, { epicId: 1030, storyId: 1043 });
  });
});

describe('tool-trace-hook — env-var no-op (zero filesystem calls)', () => {
  it('makes zero writes when CC_EPIC_ID is unset', async () => {
    delete process.env.CC_EPIC_ID;
    delete process.env.CC_STORY_ID;

    await main({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tu-1',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    });

    // No `temp/` directory should have been created. (`workRoot` is the
    // process cwd; the writer would create `temp/epic-1030/...` here on
    // any append.)
    assert.equal(existsSync(path.join(workRoot, 'temp')), false);
  });

  it('PreToolUse with no active Story is also a no-op', async () => {
    delete process.env.CC_EPIC_ID;

    await main({
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tu-2',
      tool_name: 'Bash',
      tool_input: { command: 'rm file' },
    });

    assert.equal(existsSync(path.join(workRoot, 'temp')), false);
  });
});

describe('tool-trace-hook — Pre/Post pairing', () => {
  it('appends one trace line on Post with the matched durationMs', async () => {
    const id = 'tu-pair-1';
    handlePre({
      hook_event_name: 'PreToolUse',
      tool_use_id: id,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    // A small delay so durationMs is observably positive.
    await new Promise((r) => setTimeout(r, 5));

    await handlePost(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: id,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      },
      { epicId: 1030, storyId: 1043 },
    );

    const raw = await fs.readFile(
      path.join(workRoot, 'temp', 'epic-1030', 'story-1043', 'traces.ndjson'),
      'utf8',
    );
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one trace line should be written');
    const trace = JSON.parse(lines[0]);
    assert.equal(trace.kind, 'trace');
    assert.equal(trace.source.tool, 'Bash');
    assert.equal(trace.epicId, 1030);
    assert.equal(trace.storyId, 1043);
    assert.equal(typeof trace.details.durationMs, 'number');
    assert.ok(
      trace.details.durationMs >= 0,
      'durationMs should be non-negative',
    );
    assert.ok(
      typeof trace.ts === 'string' && trace.ts.endsWith('Z'),
      'ts must be ISO-8601 UTC',
    );
  });

  it('PostToolUse without a matching PreToolUse logs one line with durationMs: null', async () => {
    await handlePost(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'orphan',
        tool_name: 'Read',
        tool_input: { file_path: '/etc/passwd' },
      },
      { epicId: 1030, storyId: 1043 },
    );

    const raw = await fs.readFile(
      path.join(workRoot, 'temp', 'epic-1030', 'story-1043', 'traces.ndjson'),
      'utf8',
    );
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    const trace = JSON.parse(lines[0]);
    assert.equal(trace.details.durationMs, null);
  });

  it('writes only to traces.ndjson, never to signals.ndjson', async () => {
    await handlePost(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tu-x',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      },
      { epicId: 1030, storyId: 1043 },
    );

    assert.equal(existsSync(tracesPath(1030, 1043)), true);
    assert.equal(existsSync(signalsPath(1030, 1043)), false);
  });
});

describe('tool-trace-hook — hashing & privacy', () => {
  it('stores sha256(command) in details.targetHash for Bash, never the raw command', async () => {
    const command =
      'curl -H "Authorization: Bearer SECRET-TOKEN-123" https://api';
    await handlePost(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tu-secret',
        tool_name: 'Bash',
        tool_input: { command },
      },
      { epicId: 1030, storyId: 1043 },
    );

    const raw = await fs.readFile(
      path.join(workRoot, 'temp', 'epic-1030', 'story-1043', 'traces.ndjson'),
      'utf8',
    );
    // The raw secret must NOT appear anywhere in the file.
    assert.equal(
      raw.includes('SECRET-TOKEN-123'),
      false,
      'raw command must not land on disk',
    );
    const trace = JSON.parse(raw.trim());
    const expectedHash = `sha256:${createHash('sha256')
      .update(command, 'utf8')
      .digest('hex')}`;
    assert.equal(trace.details.targetHash, expectedHash);
  });

  it('hashes file_path for Edit/Write/Read tool calls', async () => {
    const filePath = '/home/operator/secrets/.env';
    await handlePost(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tu-fp',
        tool_name: 'Read',
        tool_input: { file_path: filePath },
      },
      { epicId: 1030, storyId: 1043 },
    );

    const raw = await fs.readFile(
      path.join(workRoot, 'temp', 'epic-1030', 'story-1043', 'traces.ndjson'),
      'utf8',
    );
    assert.equal(
      raw.includes(filePath),
      false,
      'raw file_path must not land on disk',
    );
    const trace = JSON.parse(raw.trim());
    const expectedHash = `sha256:${createHash('sha256')
      .update(filePath, 'utf8')
      .digest('hex')}`;
    assert.equal(trace.details.targetHash, expectedHash);
  });
});

describe('tool-trace-hook — exception swallowing', () => {
  it('main() returns without throwing on a malformed event', async () => {
    // Pass a circular-reference event to provoke any latent
    // serialisation surface; main() must swallow.
    const evt = { hook_event_name: 'PostToolUse', tool_use_id: 'c1' };
    evt.self = evt;
    await assert.doesNotReject(() => main(evt));
  });

  it('main() returns without throwing on null / non-object input', async () => {
    await assert.doesNotReject(() => main(null));
    await assert.doesNotReject(() => main(undefined));
    await assert.doesNotReject(() => main(42));
    await assert.doesNotReject(() => main('not-an-event'));
  });

  it('main() ignores unknown hook_event_name without throwing', async () => {
    await assert.doesNotReject(() =>
      main({
        hook_event_name: 'UserPromptSubmit',
        tool_use_id: 'x',
        tool_name: 'Bash',
        tool_input: { command: 'noop' },
      }),
    );
    // No traces file should have been created.
    assert.equal(existsSync(tracesPath(1030, 1043)), false);
  });
});
