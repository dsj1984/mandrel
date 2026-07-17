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

  it('ignores a marker quoted inside a later revert subject', () => {
    // The canonical false positive: a revert embeds the reverted subject
    // verbatim, so `(#101)` appears mid-string on a commit that is not the
    // Story's merge. A substring scan anchored here and swept every commit
    // in between into the roster diff.
    const base = resolveRunBaseSha({
      stories: [101],
      cwd: '/repo',
      git: gitStub([
        {
          sha: 'ddd',
          parents: ['ccc'],
          subject: 'fix: real story (#101) (#900)',
        },
        {
          sha: 'ccc',
          parents: ['bbb'],
          subject: 'revert: "feat: old thing (#101) (#800)" (#850)',
        },
        { sha: 'bbb', parents: ['aaa'], subject: 'chore: unrelated' },
        { sha: 'aaa', parents: ['000'], subject: 'chore: root' },
      ]),
    });
    assert.equal(base.resolved, true);
    assert.equal(base.mergeSha, 'ddd', 'anchored on the real merge');
    assert.equal(
      base.baseSha,
      'ccc',
      'base is the real merge’s first parent, not the revert’s',
    );
  });

  it('matches the Story marker before the squash-appended PR number', () => {
    // GitHub appends ` (#<prNumber>)` to the PR title, so the Story's own
    // marker is second-to-last. Requiring the *last* marker to be the Story
    // id would match no real squash merge at all.
    const base = resolveRunBaseSha({
      stories: [101],
      cwd: '/repo',
      git: gitStub([
        { sha: 'bbb', parents: ['aaa'], subject: 'fix: s (#101) (#900)' },
        { sha: 'aaa', parents: ['000'], subject: 'chore: root' },
      ]),
    });
    assert.equal(base.resolved, true);
    assert.equal(base.storyId, 101);
    assert.equal(base.baseSha, 'aaa');
  });

  it('matches the `(refs #id)` PR-title form', () => {
    const base = resolveRunBaseSha({
      stories: [4575],
      cwd: '/repo',
      git: gitStub([
        {
          sha: 'bbb',
          parents: ['aaa'],
          subject:
            'feat(dead-exports): add a production pass (refs #4575) (#4582)',
        },
        { sha: 'aaa', parents: ['000'], subject: 'chore: root' },
      ]),
    });
    assert.equal(base.resolved, true);
    assert.equal(base.storyId, 4575);
    assert.equal(base.baseSha, 'aaa');
  });

  it('does not match a marker that is not part of the trailing run', () => {
    const base = resolveRunBaseSha({
      stories: [101],
      cwd: '/repo',
      git: gitStub([
        {
          sha: 'bbb',
          parents: ['aaa'],
          subject: 'docs: describe (#101) handling in the guide',
        },
        { sha: 'aaa', parents: ['000'], subject: 'chore: root' },
      ]),
    });
    assert.equal(base.resolved, false);
    assert.match(base.reason, /no landed squash-merge/);
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

/**
 * Story #4571 — the audit roster's LENS SELECTION must run over the run's
 * landed diff.
 *
 * Story #4550 anchored the *reported* diff to the pre-run base, but the
 * `selectAudits` call beside it still asked for `main...HEAD` — the very range
 * that is empty by construction once the run's Stories have merged and the
 * epilogue runs from the main checkout. The comment printed the right files
 * while the lenses next to it were chosen from nothing: file-pattern triggers
 * never fired, and keyword-less lenses were unreachable.
 */
describe('audit-roster — lens selection is grounded in the landed diff', () => {
  function rosterProvider(comments) {
    return {
      getTicket: async (id) => ({
        id,
        title: `Story ${id}`,
        body: '',
        labels: ['type::story'],
      }),
      getTicketComments: async () => [],
      postComment: async (ticketId, payload) => {
        comments.push({ ticketId, body: payload.body });
        return { commentId: comments.length };
      },
      deleteComment: async () => {},
    };
  }

  /** A run whose two Stories landed as squash-merges on `origin/main`. */
  function landedRunGit(changedFiles) {
    return {
      gitSpawn: (_cwd, ...args) => {
        if (args[0] === 'log') {
          const stdout = [
            `ccc${US}bbb${US}fix: second (#2)`,
            `bbb${US}aaa${US}feat: first (#1)`,
            `aaa${US}${US}chore: pre-run base`,
          ].join('\n');
          return { status: 0, stdout, stderr: '' };
        }
        if (args[0] === 'diff') {
          return {
            status: 0,
            stdout: `${changedFiles.join('\n')}\n`,
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('passes the resolved landed diff to selectAudits and reports lensGrounding: diff', async () => {
    const comments = [];
    const seen = [];
    const result = await runPlanRunEpilogue({
      planRunId: 'run-x',
      stories: [1, 2],
      provider: rosterProvider(comments),
      git: landedRunGit(['src/scheduler/wave.js', 'src/scheduler/tick.js']),
      selectAuditsFn: async (args) => {
        seen.push(args);
        return { selectedAudits: ['audit-clean-code'] };
      },
    });

    const roster = result.results.find((r) => r.kind === 'audit-roster');
    assert.deepEqual(
      seen[0].changedFiles,
      ['src/scheduler/wave.js', 'src/scheduler/tick.js'],
      "the roster must select lenses over the run's landed files",
    );
    assert.equal(
      seen[0].headRef,
      undefined,
      'the roster must not hand selectAudits a ref to diff — that range is empty by construction here',
    );
    assert.equal(seen[0].baseBranch, undefined);
    assert.equal(roster.lensGrounding, 'diff');
    assert.deepEqual(roster.selectedAudits, ['audit-clean-code']);
  });

  it('reports lensGrounding: keyword-only when the pre-run base is unresolved', async () => {
    const comments = [];
    const seen = [];
    // No landed merge carries a `(#<storyId>)` marker → base unresolved.
    const git = {
      gitSpawn: (_cwd, ...args) => {
        if (args[0] === 'log') {
          return {
            status: 0,
            stdout: `zzz${US}yyy${US}chore: unrelated`,
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };

    const result = await runPlanRunEpilogue({
      planRunId: 'run-y',
      stories: [1, 2],
      provider: rosterProvider(comments),
      git,
      selectAuditsFn: async (args) => {
        seen.push(args);
        return { selectedAudits: [] };
      },
    });

    const roster = result.results.find((r) => r.kind === 'audit-roster');
    assert.deepEqual(
      seen[0].changedFiles,
      [],
      'an unresolved base must select over an explicitly empty set, never fall back to a git range',
    );
    assert.equal(
      roster.lensGrounding,
      'keyword-only',
      'a roster whose lenses were NOT chosen from the diff must say so — silence is what made the original bug invisible',
    );
    assert.equal(roster.changedFileCount, null);

    const body = comments.find((c) =>
      c.body.includes('plan-run-audit-roster'),
    ).body;
    assert.match(body, /keyword-only/);
  });
});
