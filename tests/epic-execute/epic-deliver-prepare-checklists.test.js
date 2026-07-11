import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  runEpicDeliverPrepare,
  writeStoryChecklists,
} from '../../.agents/scripts/epic-deliver-prepare.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

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

/**
 * End-to-end smoke coverage (issue #4466). The unit tests above inject
 * `buildPayload`; this drives the WHOLE `runEpicDeliverPrepare` runner through
 * the REAL `buildChecklistPayload` (real `.agents/schemas/audit-rules.json` +
 * committed `.agents/audit-checklists/*.md`) with a Story whose serialized
 * `## Changes` footprint matches a local lens — so the conditional
 * checklist-writing branch actually executes end-to-end, not just the
 * happy no-op path the pre-existing `epic-deliver-prepare.test.js` fixtures
 * (empty Story bodies → empty footprint → null payload) ever reached. That
 * blind spot is exactly how the `fs is not defined` ReferenceError shipped
 * green (PR #4465); this test would have caught it through the real runner.
 */
describe('runEpicDeliverPrepare — checklist-writing branch executes end-to-end', () => {
  let scratch;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-prepare-smoke-'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function createFakeProvider({ epic, descendants }) {
    let autoId = 1;
    const comments = new Map();
    return {
      _comments: comments,
      async getTicket(id) {
        if (id === epic.id) return epic;
        return descendants.find((d) => d.id === id) ?? null;
      },
      async getSubTickets() {
        return descendants;
      },
      async getTicketComments(ticketId) {
        return comments.get(ticketId) ?? [];
      },
      async postComment(ticketId, payload) {
        const list = comments.get(ticketId) ?? [];
        const c = { id: autoId++, body: payload.body };
        list.push(c);
        comments.set(ticketId, list);
        return c;
      },
      async deleteComment(commentId) {
        for (const [, list] of comments) {
          const idx = list.findIndex((c) => c.id === commentId);
          if (idx !== -1) list.splice(idx, 1);
        }
      },
    };
  }

  it('writes a real footprint-matched checklist for a Story through the full runner', async () => {
    const epicId = 987654;
    const storyId = 987655;
    const epic = { id: epicId, labels: ['type::epic', 'acceptance::n-a'] };
    // A serialized Story body carrying a `## Changes` path. `audit-clean-code`
    // is a `scope: local` lens with the universal `**/*` glob and a committed
    // checklist, so ANY changes path matches it → non-empty payload → the
    // `fs.promises.mkdir`/`writeFile` branch runs.
    const storyBody = serialize({
      goal: 'Touch a source file so the local-lens footprint matches.',
      changes: [{ path: 'src/example.js', assumption: 'creates' }],
    });
    const descendants = [
      {
        id: storyId,
        number: storyId,
        title: 'Footprint-matched story',
        labels: ['type::story'],
        body: storyBody,
      },
    ];
    const provider = createFakeProvider({ epic, descendants });
    // `tempRoot` points at a scratch dir so the checklist write does not touch
    // the repo's real `temp/`; `agentRoot` stays `.agents` so the runner reads
    // the real audit-rules + committed checklists (resolved via PROJECT_ROOT).
    const config = {
      github: { owner: 'test-owner', repo: 'test-repo' },
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: scratch },
      },
      orchestration: {
        runners: {
          deliverRunner: { enabled: true, concurrencyCap: 3 },
        },
      },
    };

    const out = await runEpicDeliverPrepare({
      epicId,
      injectedProvider: provider,
      injectedConfig: config,
      // Bypass the git-dependent preflight guards (checkout-safety, lease) and
      // the boot sweep — the runner logic under test is the checklist-writing
      // branch, not the git plumbing.
      skipPreflightGuards: true,
    });

    const entry = out.stories.find((s) => s.storyId === storyId);
    assert.ok(entry, 'the story appears in the dispatch hint');
    assert.ok(
      typeof entry.checklistPath === 'string' && entry.checklistPath.length > 0,
      'checklistPath is non-null — the fs-write branch executed',
    );

    // The file the runner promised must exist on disk with real checklist
    // content (proving it went through the real buildChecklistPayload, not a
    // stub). `entry.checklistPath` is absolute because tempRoot is absolute.
    const written = fs.readFileSync(entry.checklistPath, 'utf-8');
    assert.ok(written.length > 0, 'the checklist file is non-empty');
    assert.match(
      written,
      /audit-clean-code|Clean Code|clean-code/i,
      'the checklist body came from the real clean-code lens artifact',
    );
  });
});
