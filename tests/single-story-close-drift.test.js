/**
 * Contract tests for plan-vs-actual drift detection in `single-story-close.js`.
 *
 * Story #3260 (Epic #3212) — Asserts:
 *   1. When the branch diff contains a file absent from the plan, a
 *      `story-plan-files-added` soft finding is posted.
 *   2. When the plan names a file not in the branch diff, a
 *      `story-plan-files-missed` soft finding is posted.
 *   3. Both findings are non-blocking: the close gate decision is unchanged.
 *   4. No findings are posted when the plan and diff match exactly.
 *   5. Drift detection is skipped (non-blocking) when no story-plan comment exists.
 *   6. Drift detection is skipped (non-blocking) when the plan comment is unparseable.
 *   7. Errors from findStructuredComment are caught and do not block close.
 *
 * Tests exercise the pure helper functions directly (`computeDriftFindings`,
 * `extractPlanFiles`, `getDiffFiles`, `formatAddedFinding`, `formatMissedFinding`)
 * and the orchestration wrapper (`runDriftDetectionPhase`) with an in-memory
 * provider and injected fakes so no real git or GitHub API calls are made.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeDriftFindings,
  extractPlanFiles,
  formatAddedFinding,
  formatMissedFinding,
  getDiffFiles,
  runDriftDetectionPhase,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/drift-detection.js';

// ---------------------------------------------------------------------------
// Helper: build a fake story-plan comment body the way post-story-plan.js does.
// ---------------------------------------------------------------------------

/**
 * Wrap a plan JSON object in the structured-comment body format that
 * `post-story-plan.js#formatPlanBody` emits. Drift detection reads the
 * JSON from the first ```json block in `comment.body`.
 *
 * @param {object} plan
 * @returns {{ body: string }}
 */
function makePlanComment(plan) {
  // Mirror the HTML marker inserted by `structuredCommentMarker('story-plan')`.
  const marker = '<!-- structured-comment type="story-plan" -->';
  const body = `${marker}\n### Story Plan (revision ${plan.plan_revision ?? 1})\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
  return { body };
}

/**
 * Minimal in-memory provider for drift tests. Drift detection only calls
 * `postComment` and `getTicketComments`; delete is not needed here.
 */
function makeProvider() {
  const comments = [];
  let nextId = 1;
  return {
    comments,
    async postComment(ticketId, { type, body }) {
      const id = nextId++;
      comments.push({ id, ticketId, type, body });
      return { commentId: id };
    },
    async getTicketComments(ticketId) {
      return comments.filter((c) => c.ticketId === ticketId);
    },
    async deleteComment(id) {
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) comments.splice(idx, 1);
    },
  };
}

function noop() {}

// ---------------------------------------------------------------------------
// computeDriftFindings — pure unit tests
// ---------------------------------------------------------------------------

describe('computeDriftFindings — pure unit', () => {
  it('returns empty lists when plan and diff match exactly', () => {
    const { added, missed } = computeDriftFindings({
      planFiles: ['src/a.js', 'src/b.js'],
      diffFiles: ['src/a.js', 'src/b.js'],
    });
    assert.deepEqual(added, []);
    assert.deepEqual(missed, []);
  });

  it('reports added when diff contains files not in the plan', () => {
    const { added, missed } = computeDriftFindings({
      planFiles: ['src/a.js'],
      diffFiles: ['src/a.js', 'src/extra.js'],
    });
    assert.deepEqual(added, ['src/extra.js']);
    assert.deepEqual(missed, []);
  });

  it('reports missed when plan names files not in the diff', () => {
    const { added, missed } = computeDriftFindings({
      planFiles: ['src/a.js', 'src/b.js'],
      diffFiles: ['src/a.js'],
    });
    assert.deepEqual(added, []);
    assert.deepEqual(missed, ['src/b.js']);
  });

  it('reports both added and missed when sets diverge', () => {
    const { added, missed } = computeDriftFindings({
      planFiles: ['src/a.js', 'src/b.js'],
      diffFiles: ['src/a.js', 'src/c.js'],
    });
    assert.deepEqual(added, ['src/c.js']);
    assert.deepEqual(missed, ['src/b.js']);
  });

  it('sorts results lexicographically', () => {
    const { added, missed } = computeDriftFindings({
      planFiles: ['z.js'],
      diffFiles: ['m.js', 'a.js'],
    });
    assert.deepEqual(added, ['a.js', 'm.js']);
    assert.deepEqual(missed, ['z.js']);
  });

  it('handles empty plan and empty diff', () => {
    const { added, missed } = computeDriftFindings({
      planFiles: [],
      diffFiles: [],
    });
    assert.deepEqual(added, []);
    assert.deepEqual(missed, []);
  });

  it('handles duplicate entries in diff gracefully (Set deduplication)', () => {
    const { added } = computeDriftFindings({
      planFiles: [],
      diffFiles: ['src/a.js', 'src/a.js'],
    });
    // Duplicates are deduplicated by Set.
    assert.deepEqual(added, ['src/a.js']);
  });
});

// ---------------------------------------------------------------------------
// extractPlanFiles — unit tests
// ---------------------------------------------------------------------------

describe('extractPlanFiles — unit', () => {
  it('returns null when comment is null', () => {
    assert.equal(extractPlanFiles(null), null);
  });

  it('returns null when comment has no JSON block', () => {
    assert.equal(extractPlanFiles({ body: 'no code block here' }), null);
  });

  it('returns null when JSON lacks files_to_touch', () => {
    const comment = { body: '```json\n{"ac_mapping":{}}\n```' };
    assert.equal(extractPlanFiles(comment), null);
  });

  it('returns null when files_to_touch is not an array', () => {
    const comment = {
      body: '```json\n{"files_to_touch":"not-an-array","ac_mapping":{},"open_questions":[],"plan_revision":1}\n```',
    };
    assert.equal(extractPlanFiles(comment), null);
  });

  it('returns null when JSON is malformed', () => {
    const comment = { body: '```json\n{broken json\n```' };
    assert.equal(extractPlanFiles(comment), null);
  });

  it('returns the files_to_touch array on valid comment', () => {
    const plan = {
      files_to_touch: ['src/a.js', 'src/b.js'],
      ac_mapping: {},
      open_questions: [],
      plan_revision: 1,
    };
    const comment = makePlanComment(plan);
    const files = extractPlanFiles(comment);
    assert.deepEqual(files, ['src/a.js', 'src/b.js']);
  });

  it('filters out non-string or empty entries', () => {
    const plan = {
      files_to_touch: ['src/a.js', '', 'src/b.js'],
      ac_mapping: {},
      open_questions: [],
      plan_revision: 1,
    };
    const comment = makePlanComment(plan);
    const files = extractPlanFiles(comment);
    assert.deepEqual(files, ['src/a.js', 'src/b.js']);
  });
});

// ---------------------------------------------------------------------------
// getDiffFiles — unit tests with injected gitSync
// ---------------------------------------------------------------------------

describe('getDiffFiles — unit (injected git)', () => {
  it('returns sorted file list from git diff output', () => {
    const fakeGitSync = () => 'src/b.js\nsrc/a.js\n';
    const files = getDiffFiles(fakeGitSync, '/repo', 'main');
    assert.deepEqual(files, ['src/a.js', 'src/b.js']);
  });

  it('returns empty array when git diff output is empty', () => {
    const fakeGitSync = () => '';
    const files = getDiffFiles(fakeGitSync, '/repo', 'main');
    assert.deepEqual(files, []);
  });

  it('returns empty array when gitSync throws', () => {
    const fakeGitSync = () => {
      throw new Error('git error');
    };
    const files = getDiffFiles(fakeGitSync, '/repo', 'main');
    assert.deepEqual(files, []);
  });

  it('trims whitespace from each path', () => {
    const fakeGitSync = () => '  src/a.js  \n  src/b.js  \n';
    const files = getDiffFiles(fakeGitSync, '/repo', 'main');
    assert.deepEqual(files, ['src/a.js', 'src/b.js']);
  });

  it('filters blank lines', () => {
    const fakeGitSync = () => '\nsrc/a.js\n\n';
    const files = getDiffFiles(fakeGitSync, '/repo', 'main');
    assert.deepEqual(files, ['src/a.js']);
  });

  it('passes the base branch in the git diff --name-only invocation', () => {
    let capturedArgs;
    const fakeGitSync = (_cwd, ...args) => {
      capturedArgs = args;
      return '';
    };
    getDiffFiles(fakeGitSync, '/repo', 'epic/99');
    assert.deepEqual(capturedArgs, [
      'diff',
      '--name-only',
      'origin/epic/99...HEAD',
    ]);
  });
});

// ---------------------------------------------------------------------------
// formatAddedFinding / formatMissedFinding — unit tests
// ---------------------------------------------------------------------------

describe('formatAddedFinding — unit', () => {
  it('contains the finding type name', () => {
    const body = formatAddedFinding({ storyId: 42, addedFiles: ['src/a.js'] });
    assert.match(body, /story-plan-files-added/);
  });

  it('includes the story id', () => {
    const body = formatAddedFinding({ storyId: 42, addedFiles: ['src/a.js'] });
    assert.match(body, /#42/);
  });

  it('lists each added file in a code-style bullet', () => {
    const body = formatAddedFinding({
      storyId: 1,
      addedFiles: ['src/a.js', 'src/b.js'],
    });
    assert.match(body, /`src\/a\.js`/);
    assert.match(body, /`src\/b\.js`/);
  });

  it('states the finding is non-blocking', () => {
    const body = formatAddedFinding({ storyId: 1, addedFiles: ['x.js'] });
    assert.match(body, /not blocked/i);
  });
});

describe('formatMissedFinding — unit', () => {
  it('contains the finding type name', () => {
    const body = formatMissedFinding({ storyId: 7, missedFiles: ['src/c.js'] });
    assert.match(body, /story-plan-files-missed/);
  });

  it('includes the story id', () => {
    const body = formatMissedFinding({ storyId: 7, missedFiles: ['src/c.js'] });
    assert.match(body, /#7/);
  });

  it('lists each missed file in a code-style bullet', () => {
    const body = formatMissedFinding({
      storyId: 1,
      missedFiles: ['src/c.js', 'src/d.js'],
    });
    assert.match(body, /`src\/c\.js`/);
    assert.match(body, /`src\/d\.js`/);
  });

  it('states the finding is non-blocking', () => {
    const body = formatMissedFinding({ storyId: 1, missedFiles: ['x.js'] });
    assert.match(body, /not blocked/i);
  });
});

// ---------------------------------------------------------------------------
// runDriftDetectionPhase — orchestration contract tests
// ---------------------------------------------------------------------------

describe('runDriftDetectionPhase — AC-1: files-added finding is emitted', () => {
  it('posts a story-plan-files-added notification when diff has extra files', async () => {
    const storyId = 100;
    const provider = makeProvider();
    const planFiles = ['src/a.js'];
    const diffFiles = ['src/a.js', 'src/extra.js'];

    const planComment = makePlanComment({
      files_to_touch: planFiles,
      ac_mapping: {},
      open_questions: [],
      plan_revision: 1,
    });

    const result = await runDriftDetectionPhase({
      cwd: '/repo',
      baseBranch: 'main',
      storyId,
      provider,
      progress: noop,
      injectedFindStructuredComment: async () => planComment,
      injectedGitSync: () => diffFiles.join('\n'),
    });

    assert.deepEqual(result.added, ['src/extra.js']);
    assert.deepEqual(result.missed, []);
    assert.equal(result.skipped, false);

    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 1, 'expected one notification comment');
    assert.match(comments[0].body, /story-plan-files-added/);
    assert.match(comments[0].body, /`src\/extra\.js`/);
  });
});

describe('runDriftDetectionPhase — AC-2: files-missed finding is emitted', () => {
  it('posts a story-plan-files-missed notification when plan has untouched files', async () => {
    const storyId = 101;
    const provider = makeProvider();
    const planFiles = ['src/a.js', 'src/b.js'];
    const diffFiles = ['src/a.js'];

    const planComment = makePlanComment({
      files_to_touch: planFiles,
      ac_mapping: {},
      open_questions: [],
      plan_revision: 1,
    });

    const result = await runDriftDetectionPhase({
      cwd: '/repo',
      baseBranch: 'main',
      storyId,
      provider,
      progress: noop,
      injectedFindStructuredComment: async () => planComment,
      injectedGitSync: () => diffFiles.join('\n'),
    });

    assert.deepEqual(result.added, []);
    assert.deepEqual(result.missed, ['src/b.js']);
    assert.equal(result.skipped, false);

    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 1, 'expected one notification comment');
    assert.match(comments[0].body, /story-plan-files-missed/);
    assert.match(comments[0].body, /`src\/b\.js`/);
  });
});

describe('runDriftDetectionPhase — AC-3: findings are non-blocking', () => {
  it('returns a result (does not throw) when drift findings are present', async () => {
    const storyId = 102;
    const provider = makeProvider();

    const planComment = makePlanComment({
      files_to_touch: ['src/planned.js'],
      ac_mapping: {},
      open_questions: [],
      plan_revision: 1,
    });

    // Both drift types present: extra file in diff, missing file from plan.
    let result;
    await assert.doesNotReject(async () => {
      result = await runDriftDetectionPhase({
        cwd: '/repo',
        baseBranch: 'main',
        storyId,
        provider,
        progress: noop,
        injectedFindStructuredComment: async () => planComment,
        injectedGitSync: () => 'src/unplanned.js',
      });
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.added, ['src/unplanned.js']);
    assert.deepEqual(result.missed, ['src/planned.js']);
  });

  it('posts both finding types when both drift classes are present', async () => {
    const storyId = 103;
    const provider = makeProvider();

    const planComment = makePlanComment({
      files_to_touch: ['src/planned.js'],
      ac_mapping: {},
      open_questions: [],
      plan_revision: 1,
    });

    await runDriftDetectionPhase({
      cwd: '/repo',
      baseBranch: 'main',
      storyId,
      provider,
      progress: noop,
      injectedFindStructuredComment: async () => planComment,
      injectedGitSync: () => 'src/unplanned.js',
    });

    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 2, 'expected two notification comments');
    const bodies = comments.map((c) => c.body);
    assert.ok(
      bodies.some((b) => b.includes('story-plan-files-added')),
      'expected files-added comment',
    );
    assert.ok(
      bodies.some((b) => b.includes('story-plan-files-missed')),
      'expected files-missed comment',
    );
  });
});

describe('runDriftDetectionPhase — no-drift path', () => {
  it('posts no comments when plan and diff match', async () => {
    const storyId = 104;
    const provider = makeProvider();

    const planComment = makePlanComment({
      files_to_touch: ['src/a.js'],
      ac_mapping: {},
      open_questions: [],
      plan_revision: 1,
    });

    const result = await runDriftDetectionPhase({
      cwd: '/repo',
      baseBranch: 'main',
      storyId,
      provider,
      progress: noop,
      injectedFindStructuredComment: async () => planComment,
      injectedGitSync: () => 'src/a.js',
    });

    assert.deepEqual(result.added, []);
    assert.deepEqual(result.missed, []);
    assert.equal(result.skipped, false);
    const comments = await provider.getTicketComments(storyId);
    assert.equal(
      comments.length,
      0,
      'expected no comments when there is no drift',
    );
  });
});

describe('runDriftDetectionPhase — skip when no story-plan comment', () => {
  it('returns skipped:true and posts nothing when plan comment is absent', async () => {
    const storyId = 105;
    const provider = makeProvider();

    const result = await runDriftDetectionPhase({
      cwd: '/repo',
      baseBranch: 'main',
      storyId,
      provider,
      progress: noop,
      injectedFindStructuredComment: async () => null,
      injectedGitSync: () => 'src/a.js',
    });

    assert.equal(result.skipped, true);
    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 0);
  });
});

describe('runDriftDetectionPhase — skip on unparseable comment', () => {
  it('returns skipped:true when plan comment body has no JSON block', async () => {
    const storyId = 106;
    const provider = makeProvider();

    const result = await runDriftDetectionPhase({
      cwd: '/repo',
      baseBranch: 'main',
      storyId,
      provider,
      progress: noop,
      injectedFindStructuredComment: async () => ({ body: 'no json here' }),
      injectedGitSync: () => 'src/a.js',
    });

    assert.equal(result.skipped, true);
    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 0);
  });
});

describe('runDriftDetectionPhase — error resilience', () => {
  it('does not throw when findStructuredComment rejects', async () => {
    const storyId = 107;
    const provider = makeProvider();

    let result;
    await assert.doesNotReject(async () => {
      result = await runDriftDetectionPhase({
        cwd: '/repo',
        baseBranch: 'main',
        storyId,
        provider,
        progress: noop,
        injectedFindStructuredComment: async () => {
          throw new Error('provider unavailable');
        },
        injectedGitSync: () => 'src/a.js',
      });
    });
    assert.equal(result.skipped, true);
  });

  it('still posts found findings even when postComment throws for the first finding', async () => {
    // The second finding (missed) should still attempt to post even if
    // the first (added) postComment call throws.
    const storyId = 108;
    let callCount = 0;
    const provider = {
      comments: [],
      async postComment(ticketId, opts) {
        callCount++;
        if (callCount === 1) throw new Error('network blip');
        const id = callCount;
        provider.comments.push({ id, ticketId, ...opts });
        return { commentId: id };
      },
      async getTicketComments(ticketId) {
        return provider.comments.filter((c) => c.ticketId === ticketId);
      },
      async deleteComment() {},
    };

    const planComment = makePlanComment({
      files_to_touch: ['src/planned.js'],
      ac_mapping: {},
      open_questions: [],
      plan_revision: 1,
    });

    // Drift: 'src/unplanned.js' is added, 'src/planned.js' is missed.
    let result;
    await assert.doesNotReject(async () => {
      result = await runDriftDetectionPhase({
        cwd: '/repo',
        baseBranch: 'main',
        storyId,
        provider,
        progress: noop,
        injectedFindStructuredComment: async () => planComment,
        injectedGitSync: () => 'src/unplanned.js',
      });
    });

    // Even though the first postComment threw, the phase completed.
    assert.equal(result.skipped, false);
    // The second comment (missed) should have been posted.
    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /story-plan-files-missed/);
  });
});
