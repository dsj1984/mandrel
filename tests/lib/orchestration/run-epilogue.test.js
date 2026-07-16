/**
 * Unit tests for the v2 run-epilogue planner + executor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  planRunEpilogue,
  RUN_EPILOGUE_STEP_KINDS,
  resolveRunBaseSha,
  runPlanRunEpilogue,
} from '../../../.agents/scripts/lib/orchestration/run-epilogue.js';

const US = String.fromCharCode(31);

/**
 * Build a `gitSpawn` stub over a scripted `git log` first-parent history.
 *
 * @param {Array<{sha: string, parents?: string[], subject: string}>} commits
 *   Newest-first, as real `git log --first-parent` emits.
 */
function gitStub(commits, { logStatus = 0, stderr = '' } = {}) {
  return {
    gitSpawn: (_cwd, ...args) => {
      if (args[0] === 'log') {
        if (logStatus !== 0) return { status: logStatus, stdout: '', stderr };
        const stdout = commits
          .map(
            (c) =>
              `${c.sha}${US}${(c.parents ?? []).join(' ')}${US}${c.subject}`,
          )
          .join('\n');
        return { status: 0, stdout, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

describe('planRunEpilogue — not applicable', () => {
  it('is inapplicable for a single-Story run (common case)', () => {
    const plan = planRunEpilogue({ planRunId: 'run-1', stories: ['s1'] });
    assert.equal(plan.applicable, false);
    assert.deepEqual(plan.steps, []);
    assert.match(plan.reason, /single-Story/);
  });

  it('is inapplicable for an empty run', () => {
    const plan = planRunEpilogue({ planRunId: 'run-1', stories: [] });
    assert.equal(plan.applicable, false);
    assert.match(plan.reason, /no Stories/);
  });

  it('synthesizes an adhoc planRunId for positional multi-Story runs', () => {
    const plan = planRunEpilogue({ stories: ['102', '101'] });
    assert.equal(plan.applicable, true);
    assert.equal(plan.planRunId, 'adhoc-101-102');
    assert.equal(plan.steps.length, 3);
  });
});

describe('planRunEpilogue — applicable (N>1)', () => {
  it('emits the three ordered epilogue steps over the run Stories', () => {
    const plan = planRunEpilogue({
      planRunId: 'run-42',
      stories: ['s1', 's2', 's3'],
    });
    assert.equal(plan.applicable, true);
    assert.equal(plan.planRunId, 'run-42');
    assert.deepEqual(
      plan.steps.map((s) => s.kind),
      [...RUN_EPILOGUE_STEP_KINDS],
    );
    for (const step of plan.steps) {
      assert.deepEqual(step.stories, ['s1', 's2', 's3']);
    }
  });

  it('normalizes story ids from objects, dedupes, and preserves order', () => {
    const plan = planRunEpilogue({
      planRunId: '  run-7  ',
      stories: [{ id: 's1' }, { slug: 's2' }, 's1', '  s3  '],
    });
    assert.equal(plan.planRunId, 'run-7');
    assert.deepEqual(plan.stories, ['s1', 's2', 's3']);
  });

  it('accepts numeric Story ids from resolve-plan-run envelopes', () => {
    const plan = planRunEpilogue({
      planRunId: 'run-8',
      stories: [{ id: 101 }, { id: 102 }, 103],
    });
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.stories, ['101', '102', '103']);
  });

  it('is pure — no side effects, deterministic output', () => {
    const args = { planRunId: 'run-9', stories: ['a', 'b'] };
    assert.deepEqual(planRunEpilogue(args), planRunEpilogue(args));
  });
});

describe('resolveRunBaseSha — pre-run base derivation (Story #4550)', () => {
  const HISTORY = [
    { sha: 'ddd', parents: ['ccc'], subject: 'docs: unrelated later commit' },
    {
      sha: 'ccc',
      parents: ['bbb'],
      subject: 'feat: second story (#102) (#901)',
    },
    { sha: 'bbb', parents: ['aaa'], subject: 'fix: first story (#101) (#900)' },
    { sha: 'aaa', parents: ['000'], subject: 'chore: pre-run tip' },
  ];

  it('anchors on the earliest run merge and returns its first parent', () => {
    const base = resolveRunBaseSha({
      stories: [101, 102],
      cwd: '/repo',
      git: gitStub(HISTORY),
    });
    assert.equal(base.resolved, true);
    assert.equal(base.baseSha, 'aaa');
    assert.equal(base.mergeSha, 'bbb');
    assert.equal(base.storyId, 101);
  });

  it('matches the `(#id)` marker, not a bare `#id` prose mention', () => {
    const base = resolveRunBaseSha({
      stories: [101],
      cwd: '/repo',
      git: gitStub([
        {
          sha: 'ccc',
          parents: ['bbb'],
          subject: 'fix: real story (#101) (#900)',
        },
        // An *earlier* commit that merely mentions the id — must not anchor.
        {
          sha: 'bbb',
          parents: ['aaa'],
          subject: 'docs: plan for #101 refactor',
        },
        { sha: 'aaa', parents: ['000'], subject: 'chore: root' },
      ]),
    });
    assert.equal(base.resolved, true);
    assert.equal(
      base.baseSha,
      'bbb',
      'anchored on the (#101) merge, not the prose',
    );
  });

  it('honours a non-default baseBranch ref', () => {
    const seen = [];
    const base = resolveRunBaseSha({
      stories: [101],
      cwd: '/repo',
      baseRef: 'origin/trunk',
      git: {
        gitSpawn: (_cwd, ...args) => {
          seen.push(args);
          return {
            status: 0,
            stdout: `bbb${US}aaa${US}fix: s (#101) (#900)`,
            stderr: '',
          };
        },
      },
    });
    assert.equal(base.resolved, true);
    assert.ok(seen[0].includes('origin/trunk'));
  });

  it('reports unresolved — not an empty set — when no run merge landed', () => {
    const base = resolveRunBaseSha({
      stories: [777],
      cwd: '/repo',
      git: gitStub(HISTORY),
    });
    assert.equal(base.resolved, false);
    assert.match(base.reason, /#777/);
    assert.match(base.reason, /has the run landed/);
  });

  it('reports unresolved when the base ref is unreadable', () => {
    const base = resolveRunBaseSha({
      stories: [101],
      cwd: '/repo',
      git: gitStub([], {
        logStatus: 128,
        stderr: "fatal: bad revision 'origin/main'",
      }),
    });
    assert.equal(base.resolved, false);
    assert.match(base.reason, /git log origin\/main.*failed/);
    assert.match(base.reason, /bad revision/);
  });

  it('reports unresolved when the run merge is a root commit', () => {
    const base = resolveRunBaseSha({
      stories: [101],
      cwd: '/repo',
      git: gitStub([
        { sha: 'aaa', parents: [], subject: 'fix: s (#101) (#900)' },
      ]),
    });
    assert.equal(base.resolved, false);
    assert.match(base.reason, /root commit/);
  });

  it('reports unresolved when the run carries no numeric Story ids', () => {
    const base = resolveRunBaseSha({
      stories: ['slug-a', 'slug-b'],
      cwd: '/repo',
      git: gitStub(HISTORY),
    });
    assert.equal(base.resolved, false);
    assert.match(base.reason, /no numeric Story ids/);
  });

  it('survives a throwing git without taking the epilogue down', () => {
    const base = resolveRunBaseSha({
      stories: [101],
      cwd: '/repo',
      git: {
        gitSpawn: () => {
          throw new Error('ENOENT: git not found');
        },
      },
    });
    assert.equal(base.resolved, false);
    assert.match(base.reason, /could not be spawned/);
  });
});

describe('runPlanRunEpilogue — executor', () => {
  it('skips execution when not applicable', async () => {
    const result = await runPlanRunEpilogue({
      planRunId: 'run-1',
      stories: [1],
      provider: {},
    });
    assert.equal(result.applicable, false);
    assert.deepEqual(result.results, []);
  });

  it('runs sibling-coherence against Story bodies', async () => {
    const comments = [];
    const provider = {
      getTicket: async (id) => ({
        id,
        title: `Story ${id}`,
        body:
          id === 1
            ? '## Acceptance\n\n- A\n\n## Spec\n\nshared\n'
            : '## Spec\n\nshared\n',
        labels: ['type::story'],
      }),
      getTicketComments: async () => [],
      postComment: async (ticketId, payload) => {
        comments.push({ ticketId, body: payload.body });
        return { commentId: comments.length };
      },
      deleteComment: async () => {},
    };
    const result = await runPlanRunEpilogue({
      planRunId: 'stage-x',
      stories: [1, 2],
      provider,
      config: { github: { owner: 'o', repo: 'r' } },
      cwd: process.cwd(),
    });
    assert.equal(result.applicable, true);
    const coherence = result.results.find(
      (r) => r.kind === 'sibling-coherence',
    );
    assert.ok(coherence);
    assert.ok(
      coherence.findings.some((f) => /Acceptance/i.test(f)),
      'expected missing-Acceptance finding',
    );
    assert.ok(
      coherence.findings.some((f) => /Duplicate/i.test(f)),
      'expected duplicate Spec finding',
    );
    assert.ok(comments.some((c) => /plan-run-sibling-coherence/.test(c.body)));
  });
});
