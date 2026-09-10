/**
 * Unit tests for the v2 run-epilogue planner + executor.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import {
  planRunEpilogue,
  RUN_EPILOGUE_STEP_KINDS,
  resolveRunBaseSha,
  runPlanRunEpilogue,
} from '../../../.agents/scripts/lib/orchestration/run-epilogue.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

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
    assert.equal(plan.steps.length, RUN_EPILOGUE_STEP_KINDS.length);
  });
});

describe('planRunEpilogue — applicable (N>1)', () => {
  it('emits every ordered epilogue step over the run Stories', () => {
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

/**
 * Story #4578 — an empty follow-up roll-up over a multi-Story run must
 * report as a CLAIM, not as success.
 *
 * The bug this pins: a 7-Story run containing a mid-run git outage, a parked
 * worker, and a four-round acceptance critic rendered byte-identically to a
 * genuinely clean run ("No friction signals — nothing to follow up"). The
 * roll-up was truthful about the stream and misleading about the run.
 */
describe('follow-up-rollup — an empty roll-up over N>1 asserts (Story #4578)', () => {
  function rollupProvider(comments) {
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

  it('flags emptyRollupSuspect and names the count when no Story emitted a signal', async () => {
    const comments = [];
    // An absolute tempRoot with no signals.ndjson under it → an empty stream.
    const tempRoot = makeTempDir('rollup-empty-');
    try {
      const result = await runPlanRunEpilogue({
        planRunId: 'adhoc-1-2-3',
        stories: [1, 2, 3],
        provider: rollupProvider(comments),
        config: {
          github: { owner: 'o', repo: 'r' },
          project: { paths: { tempRoot } },
        },
        cwd: process.cwd(),
      });

      const rollup = result.results.find((r) => r.kind === 'follow-up-rollup');
      assert.equal(rollup.signalCount, 0);
      assert.equal(rollup.storyCount, 3);
      assert.equal(
        rollup.emptyRollupSuspect,
        true,
        'zero signals across 3 Stories is a claim the epilogue must flag',
      );

      const body = comments.find((c) => /### follow-ups/.test(c.body))?.body;
      assert.match(body, /0 friction signals across 3 Stories/);
      assert.match(body, /not a clean bill of health/);
      assert.doesNotMatch(
        body,
        /nothing to follow up/,
        'the reassuring line is exactly what made the zero-signal retro invisible',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  /**
   * Story #4824 — an ALL-DISCARDED roll-up is the other invisible shape.
   *
   * Every candidate fell under the ≥2 threshold, so nothing was filed; the
   * row rendered as a bare `` `category` ×1 `` and the operator had no way to
   * tell a genuine one-off from a systemic defect whose window was too narrow
   * to see it recur. The row — and the machine-readable step result — must
   * name the recurring fingerprint and its cross-Story count instead.
   */
  it('names the discarded fingerprint and its cross-run count', async () => {
    const comments = [];
    const tempRoot = makeTempDir('rollup-discarded-');
    const config = {
      github: { owner: 'o', repo: 'r' },
      project: { paths: { tempRoot } },
    };
    try {
      // One occurrence, in one Story — below the threshold, so the whole
      // roll-up discards.
      await emitRuntimeFriction({
        storyId: 9101,
        category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
        tool: 'native-review-lint',
        details: {
          surface: 'scoped-lint',
          reason: 'lint runner produced no parseable output',
        },
        config,
      });

      const result = await runPlanRunEpilogue({
        planRunId: 'adhoc-9101-9102',
        stories: [9101, 9102],
        provider: rollupProvider(comments),
        config,
        cwd: process.cwd(),
      });

      const rollup = result.results.find((r) => r.kind === 'follow-up-rollup');
      assert.equal(rollup.filed, 0, 'nothing clears the threshold');
      assert.equal(rollup.emptyRollupSuspect, false);
      assert.equal(rollup.discarded.length, 1);

      const [item] = rollup.discarded;
      assert.equal(item.category, 'tool-degraded');
      assert.equal(item.occurrences, 1);
      assert.equal(item.storyCount, 1, 'the cross-run count is named');
      assert.deepEqual(item.tools, ['native-review-lint']);
      assert.match(item.fingerprint, /^[0-9a-f]{8}$/);
      assert.equal(
        item.source,
        'framework',
        'a tool that could not execute is a framework-surface failure',
      );

      const body = comments.find((c) => /### follow-ups/.test(c.body))?.body;
      assert.doesNotMatch(
        body,
        /nothing to follow up/,
        'an all-discarded roll-up must not render as a clean run',
      );
      assert.match(body, /Below threshold \(not filed\)/);
      assert.match(body, /`tool-degraded` ×1/);
      assert.match(body, /across 1 Story/);
      assert.match(body, /via `native-review-lint`/);
      assert.match(body, new RegExp(`fingerprint \`${item.fingerprint}\``));
      assert.match(body, new RegExp(`"fingerprint": "${item.fingerprint}"`));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  /**
   * The recurrence window is what turns the row above into a filing: the same
   * defect firing once in each of two Stories reaches the threshold, where
   * the pre-#4824 run-scoped gather scored it 1 on each and discarded both.
   */
  it('files a defect recurring once per Story across the surviving window', async () => {
    const comments = [];
    const tempRoot = makeTempDir('rollup-recurrence-');
    const config = {
      github: { owner: 'o', repo: 'r' },
      project: { paths: { tempRoot } },
      // The graduator is a no-op, so the assertion reads the composed
      // proposals rather than a live GitHub filing.
      delivery: { feedbackLoop: { retroProposals: false } },
    };
    try {
      for (const storyId of [9201, 9202]) {
        await emitRuntimeFriction({
          storyId,
          category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
          tool: 'native-review-lint',
          details: {
            surface: 'scoped-lint',
            reason: 'lint runner produced no parseable output',
          },
          config,
        });
      }

      const result = await runPlanRunEpilogue({
        planRunId: 'adhoc-9201-9202',
        stories: [9201, 9202],
        provider: rollupProvider(comments),
        config,
        cwd: process.cwd(),
      });

      const rollup = result.results.find((r) => r.kind === 'follow-up-rollup');
      assert.equal(rollup.signalCount, 2);
      assert.deepEqual(rollup.discarded, [], 'no longer below the threshold');

      const body = comments.find((c) => /### follow-ups/.test(c.body))?.body;
      assert.match(body, /Actionable \(not auto-filed\)/);
      assert.match(body, /framework: Friction: tool-degraded recurred 2 times/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Story #4850 — the roll-up's own numbers must say which corpus produced them.
 *
 * The gather reduces over the whole surviving recurrence window on purpose, so
 * the epilogue can no longer claim the occurrences happened in the run it
 * happens to be closing, and it must report the age bound it applied — a
 * `signalCount` alone cannot distinguish a 30-day window that aged forty rows
 * out from a corpus with nothing older in it.
 */
describe('follow-up-rollup — the window is reported and the run is an input (Story #4850)', () => {
  function rollupProvider(comments) {
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

  it('AC-5: reports the window bound and what it excluded', async () => {
    const comments = [];
    const tempRoot = makeTempDir('rollup-window-');
    const config = {
      github: { owner: 'o', repo: 'r' },
      project: { paths: { tempRoot } },
      delivery: { feedbackLoop: { retroProposals: false } },
    };
    try {
      await emitRuntimeFriction({
        storyId: 9301,
        category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
        tool: 'native-review-lint',
        details: { surface: 'scoped-lint' },
        config,
      });

      const result = await runPlanRunEpilogue({
        planRunId: 'adhoc-9301-9302',
        stories: [9301, 9302],
        provider: rollupProvider(comments),
        config,
        cwd: process.cwd(),
      });

      const rollup = result.results.find((r) => r.kind === 'follow-up-rollup');
      assert.equal(rollup.frictionWindow.days, 30, 'the default bound applies');
      assert.ok(
        Number.isFinite(Date.parse(rollup.frictionWindow.cutoff)),
        'the cutoff is a readable instant, not prose',
      );
      assert.equal(rollup.frictionWindow.excludedStale, 0);
      assert.equal(rollup.frictionWindow.excludedUnparseable, 0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  /**
   * AC-6 — the epilogue used to compose with the primary Story's numeric id
   * standing in for the run, then rewrite the rendered title and body by regex
   * over a `plan-run \d+` substring. The token is an input now: the rendered
   * text carries the real (non-numeric) run token, which no `\d+` patch could
   * ever have produced, and the primary Story id never appears as a run id.
   */
  it('AC-6: the rendered proposal carries the run token with no regex patch', async () => {
    const comments = [];
    const tempRoot = makeTempDir('rollup-run-token-');
    const config = {
      github: { owner: 'o', repo: 'r' },
      project: { paths: { tempRoot } },
      delivery: { feedbackLoop: { retroProposals: false } },
    };
    try {
      for (const storyId of [9401, 9402]) {
        await emitRuntimeFriction({
          storyId,
          category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
          tool: 'native-review-lint',
          details: { surface: 'scoped-lint' },
          config,
        });
      }

      await runPlanRunEpilogue({
        planRunId: 'adhoc-9401-9402',
        stories: [9401, 9402],
        provider: rollupProvider(comments),
        config,
        cwd: process.cwd(),
      });

      const body = comments.find((c) => /### follow-ups/.test(c.body))?.body;
      assert.match(body, /in plan-run adhoc-9401-9402/);
      assert.match(body, /Triggering run: plan-run adhoc-9401-9402/);
      assert.doesNotMatch(
        body,
        /plan-run 9401\b/,
        'the primary Story id must never be rendered as the run id',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  /**
   * The cross-run case is where the pre-#4850 title lied: the corpus spans
   * Stories the run never delivered, and the body's own evidence block said so
   * while the title asserted the run as the scope.
   */
  it('AC-1: a corpus spanning Stories outside the run is titled by its window', async () => {
    const comments = [];
    const tempRoot = makeTempDir('rollup-foreign-');
    const config = {
      github: { owner: 'o', repo: 'r' },
      project: { paths: { tempRoot } },
      delivery: { feedbackLoop: { retroProposals: false } },
    };
    try {
      // 9501 is foreign — a Story from an earlier run whose stream survives.
      for (const storyId of [9501, 9502]) {
        await emitRuntimeFriction({
          storyId,
          category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
          tool: 'native-review-lint',
          details: { surface: 'scoped-lint' },
          config,
        });
      }

      await runPlanRunEpilogue({
        planRunId: 'adhoc-9502-9503',
        stories: [9502, 9503],
        provider: rollupProvider(comments),
        config,
        cwd: process.cwd(),
      });

      const body = comments.find((c) => /### follow-ups/.test(c.body))?.body;
      assert.match(
        body,
        /recurred 2 times across 2 Stories \(\d{4}-\d\d-\d\d\)/,
      );
      assert.doesNotMatch(
        body,
        /recurred 2 times in plan-run/,
        'the count did not happen in the triggering run and must not say so',
      );
      // The run is still named — as the trigger, not as the scope.
      assert.match(body, /Triggering run: plan-run adhoc-9502-9503/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Story #4828 — the reporting layer is where this is asserted, deliberately.
 *
 * The measured failure was a roll-up that gathered nine signals, composed one
 * proposal at threshold, failed every filing attempt, and reported
 * `{signalCount: 9, storyCount: 2, filed: 0, discarded: []}`. Every number in
 * that envelope is correct. Nothing in it says the loop broke, because the
 * step result reported what went in and what came out and nothing about what
 * happened in between.
 *
 * Asserting the fix only at the routing layer would leave the next routing
 * regression free to render as success again — which is exactly how this
 * failure mode survived being fixed twice already (#4578 for zero signals,
 * #4824 for all-discarded). So these tests read the step result and the
 * rendered comment.
 */
describe('follow-up-rollup — zero proposals from N signals (Story #4828)', () => {
  function rollupProvider(comments) {
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

  it('flags a corpus that produced no proposal at all, and names its categories', async () => {
    const comments = [];
    const tempRoot = makeTempDir('rollup-zero-proposal-');
    const config = {
      github: { owner: 'o', repo: 'r' },
      project: { paths: { tempRoot } },
    };
    try {
      // A close that failed and then landed: the incident and its recovery
      // marker net each other out, so signals exist and nothing routes.
      for (const storyId of [9301, 9302]) {
        await emitRuntimeFriction({
          storyId,
          category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
          tool: 'single-story-close',
          details: { phase: 'push' },
          config,
        });
        await emitRuntimeFriction({
          storyId,
          category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
          tool: 'runPostLandTail',
          details: { recovered: true },
          config,
        });
      }

      const result = await runPlanRunEpilogue({
        planRunId: 'adhoc-9301-9302',
        stories: [9301, 9302],
        provider: rollupProvider(comments),
        config,
        cwd: process.cwd(),
      });

      const rollup = result.results.find((r) => r.kind === 'follow-up-rollup');
      assert.equal(rollup.signalCount, 4, 'the corpus was not empty');
      assert.equal(rollup.proposalCount, 0);
      assert.deepEqual(rollup.discarded, []);
      assert.equal(rollup.filed, 0);
      assert.equal(
        rollup.zeroProposalSuspect,
        true,
        'signals in and nothing out is a routing outcome the roll-up must state',
      );
      assert.equal(
        rollup.emptyRollupSuspect,
        false,
        'the #4578 flag means zero signals — a non-empty corpus is a different shape',
      );
      assert.deepEqual(rollup.categories, [
        { category: 'close-failed', occurrences: 4 },
      ]);

      const body = comments.find((c) => /### follow-ups/.test(c.body))?.body;
      assert.match(body, /4 friction signals gathered, 0 proposals produced/);
      assert.match(body, /`close-failed` ×4/);
      assert.doesNotMatch(
        body,
        /nothing to follow up/,
        'the reassuring line is what made this shape invisible',
      );
      assert.match(body, /"zeroProposalSuspect": true/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('flags a proposal at threshold that the filer failed to file', async () => {
    const comments = [];
    const tempRoot = makeTempDir('rollup-unfiled-');
    const config = {
      github: { owner: 'o', repo: 'r' },
      project: { paths: { tempRoot } },
    };
    try {
      for (const storyId of [9401, 9402]) {
        await emitRuntimeFriction({
          storyId,
          category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
          tool: 'native-review-lint',
          details: { surface: 'scoped-lint', reason: 'no parseable output' },
          config,
        });
      }

      // The filer as it actually behaved: every `gh issue create` rejected
      // over a label the repo did not carry.
      const result = await runPlanRunEpilogue({
        planRunId: 'adhoc-9401-9402',
        stories: [9401, 9402],
        provider: rollupProvider(comments),
        config,
        cwd: process.cwd(),
        graduateFn: async () => ({
          filed: [],
          skipped: [{ reason: 'label-ensure-failed' }],
          errors: [
            'gh label create "friction::tool-degraded" in o/r failed: HTTP 403',
          ],
        }),
      });

      const rollup = result.results.find((r) => r.kind === 'follow-up-rollup');
      assert.equal(rollup.signalCount, 2);
      assert.equal(rollup.proposalCount, 1, 'the bucket cleared the threshold');
      assert.equal(rollup.filed, 0);
      assert.equal(
        rollup.unfiledProposalSuspect,
        true,
        'a proposal that reached the filer and did not land is a broken loop',
      );
      assert.deepEqual(rollup.filingSkipped, ['label-ensure-failed']);
      assert.equal(rollup.filingErrors.length, 1);
      assert.match(rollup.filingErrors[0], /gh label create/);

      const body = comments.find((c) => /### follow-ups/.test(c.body))?.body;
      assert.match(
        body,
        /1 actionable proposal\(s\) reached the filer and none were filed/,
      );
      assert.match(body, /"unfiledProposalSuspect": true/);
      assert.match(body, /"signalCount": 2/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Story #5139 — the container Epic closes once every child lands.
 *
 * This is the ONE completion cascade v2 reintroduces, so its boundaries
 * matter more than its happy path: it must not close an Epic with an
 * outstanding child, and it must not touch an Epic this run never advanced.
 */
describe('epic-close — the epilogue reports containers, it does not derive them', () => {
  // Read-only since Story #5280. Every child state change is now a rollup
  // edge, so by the time the last Story of a run has landed its container was
  // already derived from a complete child set by that Story's own land tail.
  // Re-deriving here asked the same question twice and put a second writer on
  // the same issue; what the step is *for* is the report.
  function epicProvider({ parents = new Map(), updates = [] } = {}) {
    return {
      updates,
      getParentIssue: async (storyId) => parents.get(Number(storyId)) ?? null,
      getTicket: async () => null,
      getTicketComments: async () => [],
      postComment: async () => ({ commentId: 1 }),
      deleteComment: async () => {},
      updateTicket: async (id, mutations) => {
        updates.push({ id, mutations });
      },
    };
  }

  const container = (id, state = 'open') => ({
    id,
    labels: ['type::epic'],
    state,
    body: '## Stories\n',
  });

  const runWith = (provider, stories = [1, 2]) =>
    runPlanRunEpilogue({
      planRunId: 'run-e',
      stories,
      provider,
      config: { github: { owner: 'o', repo: 'r' } },
      cwd: process.cwd(),
    });

  it('reports a container the land tails already closed, and writes nothing', async () => {
    const provider = epicProvider({
      parents: new Map([
        [1, container(90, 'closed')],
        [2, container(90, 'closed')],
      ]),
    });
    const result = await runWith(provider);
    const step = result.results.find((r) => r.kind === 'epic-close');

    assert.deepEqual(step.closed, [90]);
    assert.deepEqual(step.pending, []);
    assert.deepEqual(
      provider.updates,
      [],
      'the epilogue is a reporting tail — it must not write to a container',
    );
  });

  it('reports a container a land tail declined to close as still open', async () => {
    // A real signal: the tail's own rollup outcome says why it withheld.
    const provider = epicProvider({
      parents: new Map([[1, container(91, 'open')]]),
    });
    // Two Stories, always: a one-Story run reports `applicable: false` and
    // never reaches the epilogue at all.
    const step = (await runWith(provider, [1, 2])).results.find(
      (r) => r.kind === 'epic-close',
    );

    assert.deepEqual(step.closed, []);
    assert.deepEqual(step.pending, [91]);
  });

  it('reports a container shared by two siblings exactly once', async () => {
    const provider = epicProvider({
      parents: new Map([
        [1, container(90, 'closed')],
        [2, container(90, 'closed')],
      ]),
    });
    const step = (await runWith(provider)).results.find(
      (r) => r.kind === 'epic-close',
    );

    assert.deepEqual(step.closed, [90], 'one entry, not one per sibling');
  });

  it('ignores a malformed Story id in the delivered set', async () => {
    const provider = epicProvider({
      parents: new Map([[1, container(90, 'closed')]]),
    });
    const step = (await runWith(provider, ['not-a-number', 0, 1])).results.find(
      (r) => r.kind === 'epic-close',
    );

    assert.deepEqual(step.closed, [90]);
  });

  it('omits a Story whose parent is not a container Epic', async () => {
    const provider = epicProvider({
      parents: new Map([
        [1, { id: 77, labels: ['type::story'], state: 'closed', body: '' }],
      ]),
    });
    const step = (await runWith(provider, [1, 2])).results.find(
      (r) => r.kind === 'epic-close',
    );

    assert.deepEqual(step, { kind: 'epic-close', closed: [], pending: [] });
  });

  it('omits a container it could not read rather than guessing at it', async () => {
    const provider = epicProvider();
    provider.getParentIssue = async () => {
      throw new Error('search down');
    };
    const step = (await runWith(provider)).results.find(
      (r) => r.kind === 'epic-close',
    );

    assert.deepEqual(step, { kind: 'epic-close', closed: [], pending: [] });
  });

  it('degrades to a no-op on a provider with no parent port at all', async () => {
    const provider = epicProvider();
    provider.getParentIssue = undefined;
    const step = (await runWith(provider)).results.find(
      (r) => r.kind === 'epic-close',
    );

    assert.deepEqual(step, { kind: 'epic-close', closed: [], pending: [] });
  });
});
