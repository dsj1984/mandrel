import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { writeStoryChecklists } from '../../.agents/scripts/epic-deliver-prepare.js';

/**
 * Regression guard for the `fs is not defined` ReferenceError that shipped in
 * `writeStoryChecklists` (missing `import fs`): the function reached
 * `fs.promises.mkdir` / `fs.promises.writeFile` at runtime and threw, blocking
 * every `/deliver <epic>` at the prepare step. This test drives the real write
 * path (a matched footprint yields a non-empty payload) so the module-level
 * `fs` import is exercised, not just parsed.
 */
describe('writeStoryChecklists — fs write path', () => {
  let cwd;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-checklists-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('writes the checklist file for a Story with a non-empty payload', async () => {
    const result = await writeStoryChecklists({
      epicId: 4430,
      cwd,
      config: {},
      stories: [{ storyId: 42, worktree: 'wt', title: 'demo' }],
      storyById: new Map(),
      // Inject a deterministic payload so the test does not depend on the
      // repo's audit-rules content — the point is to exercise the fs writes.
      buildPayload: () => ({ payload: '# Checklist\n- concern one' }),
    });

    assert.equal(result.length, 1);
    const relPath = result[0].checklistPath;
    assert.equal(
      relPath,
      path.join('temp', 'epic-4430', 'checklists', 'story-42.md'),
    );

    // The file the prepare step promised must actually exist on disk with the
    // payload content — this is the exact mkdir+writeFile pair that threw.
    const written = fs.readFileSync(path.resolve(cwd, relPath), 'utf-8');
    assert.equal(written, '# Checklist\n- concern one');
  });

  it('returns a null checklistPath (and writes nothing) when the payload is empty', async () => {
    const result = await writeStoryChecklists({
      epicId: 4430,
      cwd,
      config: {},
      stories: [{ storyId: 7, worktree: 'wt', title: 'no-match' }],
      storyById: new Map(),
      buildPayload: () => ({ payload: '' }),
    });

    assert.equal(result[0].checklistPath, null);
    assert.equal(fs.existsSync(path.join(cwd, 'temp', 'epic-4430')), false);
  });
});
