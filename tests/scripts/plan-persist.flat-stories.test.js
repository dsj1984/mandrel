/**
 * v2 Stage 3 — flat Story persist (no Epic, no deliveryShape).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../.agents/scripts/lib/label-constants.js';
import { appendPlanMetric } from '../../.agents/scripts/lib/orchestration/plan-metrics.js';
import {
  makeDefaultFanOutCounter,
  resolveBaseBranchRef,
  validateTickets,
} from '../../.agents/scripts/lib/orchestration/plan-persist/persist-helpers.js';
import {
  reapStalePlanDirs,
  runPlanPersist,
} from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import {
  planStoryFingerprint,
  sanitizeAuthoredLabels,
} from '../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import { PLAN_SUMMARY_COMMENT_TYPE } from '../../.agents/scripts/lib/orchestration/plan-persist/summary.js';
import { resolveSourceTicketIds } from '../../.agents/scripts/lib/orchestration/plan-persist/supersede-ops.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

function ticket(slug) {
  const acceptance = [`${slug} done`];
  const verify = ['npm test (validate)'];
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    acceptance,
    verify,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [
        {
          path: 'tests/scripts/plan-persist.flat-stories.test.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance,
      verify,
      reason_to_exist: `Ship ${slug}`,
    }),
  };
}

/**
 * A `ticket()` whose authored content varies independently of slug/title —
 * the axis the resume fingerprint has to be sensitive to.
 */
function ticketWithGoal(slug, goal) {
  const acceptance = [`${slug} done`];
  return {
    ...ticket(slug),
    body: serialize({
      goal,
      changes: [
        {
          path: 'tests/scripts/plan-persist.flat-stories.test.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance,
      verify: ['npm test (validate)'],
      reason_to_exist: `Ship ${slug}`,
    }),
  };
}

function fakeProvider({ sources = [], createHook = null } = {}) {
  const issues = new Map();
  const comments = [];
  const updates = [];
  let nextId = 5000;
  for (const source of sources) {
    issues.set(source.id, {
      id: source.id,
      title: source.title ?? `Source ${source.id}`,
      body: source.body ?? '',
      labels: [],
      state: source.state ?? 'open',
    });
  }
  return {
    issues,
    comments,
    updates,
    async createIssue({ title, body, labels }) {
      if (createHook) await createHook({ title, body, labels });
      const id = nextId++;
      issues.set(id, { id, title, body, labels: [...labels] });
      return { id, url: `https://example.test/${id}` };
    },
    async getTicket(id) {
      const issue = issues.get(id);
      if (!issue) throw new Error(`ticket #${id} not found`);
      return { ...issue, state: issue.state ?? 'open' };
    },
    async listIssuesByLabel({ state, labels }) {
      return [...issues.values()].filter(
        (issue) =>
          (issue.state ?? 'open') === state &&
          (issue.labels ?? []).includes(labels),
      );
    },
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
      const issue = issues.get(id);
      if (!issue) throw new Error(`ticket #${id} not found`);
      // Mirror the real provider's `{ labels: { add, remove } }` mutation
      // shape rather than blind-assigning it over `issue.labels`.
      const { labels: labelMutations, ...rest } = mutations;
      Object.assign(issue, rest);
      if (labelMutations) {
        const next = new Set(issue.labels ?? []);
        for (const l of labelMutations.remove ?? []) next.delete(l);
        for (const l of labelMutations.add ?? []) next.add(l);
        issue.labels = [...next];
      }
    },
    async getTicketComments(issueNumber) {
      return comments.filter((c) => c.issueNumber === issueNumber);
    },
    async postComment(issueNumber, payload) {
      const body = typeof payload === 'string' ? payload : payload.body;
      const id = comments.length + 1;
      comments.push({ id, issueNumber, body });
      return { commentId: id, id };
    },
    async deleteComment(id) {
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) comments.splice(idx, 1);
    },
  };
}

/**
 * The supersede close is the only thing these assertions are about, but
 * `provider.updates` also records the terminal `agent::ready` flip persist
 * now performs on every created Story (Story #4541). Narrow to the state
 * mutations so a close assertion stays a close assertion.
 */
function closeUpdates(provider) {
  return provider.updates.filter((u) => u.mutations.state !== undefined);
}

describe('base-branch resolution (Story #4541)', () => {
  // The gates read `config.baseBranch` — a key the canonical resolver never
  // emits (it lives at `project.baseBranch`) — so every freshness /
  // file-assumption / fan-out probe silently targeted the literal `main`
  // regardless of configuration. Benign in a repo whose base branch IS
  // main; wrong for any consumer that configured something else.
  it('resolves the canonical project.baseBranch', () => {
    assert.equal(
      resolveBaseBranchRef({ project: { baseBranch: 'develop' } }),
      'develop',
    );
  });

  it('falls back to the legacy flat settings bag, then to main', () => {
    assert.equal(resolveBaseBranchRef({ baseBranch: 'trunk' }), 'trunk');
    assert.equal(resolveBaseBranchRef({}), 'main');
    assert.equal(resolveBaseBranchRef(undefined), 'main');
  });

  it('prefers project.baseBranch over a stale flat key', () => {
    assert.equal(
      resolveBaseBranchRef({
        baseBranch: 'stale',
        project: { baseBranch: 'develop' },
      }),
      'develop',
    );
  });

  it('threads the configured branch into the probes, not the literal main', () => {
    // Observable end-to-end: the freshness gate names the ref it probed.
    const undeclared = ticket('probe');
    undeclared.acceptance = [
      'The change is consistent with `.agents/scripts/does-not-exist.js`.',
    ];
    assert.throws(
      () =>
        validateTickets([undeclared], {
          project: { baseBranch: 'a-branch-that-does-not-exist' },
        }),
      /do not exist at a-branch-that-does-not-exist/,
    );
  });
});

describe('fan-out probe — importers, not basename word matches (Story #4547)', () => {
  // The predecessor counter grepped the deleted file's basename stem as a
  // bare word across the whole tree. A module named `notification` reported
  // 59 call sites drawn from prose and unrelated schemas while having zero
  // real importers — and the gate that fired on that number told the
  // operator to split a migration that did not exist, leaving the override
  // as the only exit. These fixtures pin the number to real coupling.

  /**
   * A `git grep -n -E` that actually greps: the fixture tree is matched
   * against the probe's own pattern, so the assertions below exercise the
   * real regex rather than a canned hit list.
   */
  function fakeGit(tree) {
    return {
      gitSpawn(_cwd, ...args) {
        const [, , , , pattern, ref] = args;
        const re = new RegExp(pattern.replaceAll('[[:space:]]', '\\s'));
        const out = [];
        for (const [file, content] of Object.entries(tree)) {
          content.split('\n').forEach((text, idx) => {
            if (re.test(text)) out.push(`${ref}:${file}:${idx + 1}:${text}`);
          });
        }
        return {
          status: out.length > 0 ? 0 : 1,
          stdout: out.join('\n'),
          stderr: '',
        };
      },
    };
  }

  function probe(tree, path, { baseBranchRef = 'main' } = {}) {
    return makeDefaultFanOutCounter({
      baseBranchRef,
      cwd: '/repo',
      git: fakeGit(tree),
    })({ path });
  }

  it('reports zero for a generic basename that no code imports', () => {
    const result = probe(
      {
        '.agents/docs/SDLC.md':
          'The post-merge notification phase fires after the merge lands.',
        '.agents/schemas/agentrc.schema.json':
          '  "notification": { "type": "object" },',
        '.agents/scripts/lib/close.js':
          "// notification is sent here\nimport { land } from './land.js';",
      },
      '.agents/scripts/lib/notification.js',
    );
    assert.equal(result.count, 0);
    assert.deepEqual(result.files, []);
  });

  it('counts the files that genuinely import the module', () => {
    const result = probe(
      {
        '.agents/scripts/lib/a.js':
          "import { notify } from './notification.js';",
        '.agents/scripts/lib/nested/b.js':
          "import { notify } from '../notification.js';",
        '.agents/scripts/c.js': "const n = require('./lib/notification');",
        '.agents/docs/SDLC.md': 'Prose about notification handling.',
      },
      '.agents/scripts/lib/notification.js',
    );
    assert.equal(result.count, 3);
    assert.deepEqual(result.files, [
      '.agents/scripts/c.js',
      '.agents/scripts/lib/a.js',
      '.agents/scripts/lib/nested/b.js',
    ]);
  });

  it('does not count a same-basename module in another directory', () => {
    const result = probe(
      {
        '.agents/scripts/x.js': "import { n } from './b/notification.js';",
      },
      '.agents/scripts/a/notification.js',
    );
    assert.equal(result.count, 0);
  });

  it('probes a stem shorter than three characters instead of reporting zero', () => {
    // The predecessor bailed out at `stem.length < 3` without probing at
    // all — silently under-reporting a real deletion as safe.
    const result = probe(
      {
        '.agents/scripts/lib/reader.js': "import { q } from './db.js';",
        '.agents/scripts/lib/writer.js': "import { q } from './db.js';",
      },
      '.agents/scripts/lib/db.js',
    );
    assert.equal(result.count, 2);
    assert.deepEqual(result.files, [
      '.agents/scripts/lib/reader.js',
      '.agents/scripts/lib/writer.js',
    ]);
  });

  it('resolves an extensionless directory-index specifier', () => {
    const result = probe(
      { '.agents/scripts/x.js': "import { f } from './foo';" },
      '.agents/scripts/foo/index.js',
    );
    assert.equal(result.count, 1);
    assert.deepEqual(result.files, ['.agents/scripts/x.js']);
  });

  it("excludes the deleted module's own self-references", () => {
    const result = probe(
      {
        '.agents/scripts/lib/notification.js':
          '// see ./notification.js\nexport const n = 1;',
      },
      '.agents/scripts/lib/notification.js',
    );
    assert.equal(result.count, 0);
  });

  it('reports a probe that survives a paste into a shell', () => {
    // The reported probe is the operator's route to checking the number at
    // any count, so "looks like a git command" is not the bar — it has to
    // still be the same argv after the shell has had it. Unquoted, the
    // ERE's `(`, `|` and `[[:space:]]` are glob metacharacters: zsh fails
    // the paste with `no matches found` AND exits 0, so the gate's own
    // audit trail would read as "zero importers".
    const result = probe(
      { '.agents/scripts/x.js': "import { n } from './lib/notification.js';" },
      '.agents/scripts/lib/notification.js',
    );
    const argv = execFileSync(
      'sh',
      ['-c', `printf '%s\\n' ${result.probe.replace(/^git /, '')}`],
      { encoding: 'utf-8' },
    )
      .split('\n')
      .filter((l) => l.length > 0);

    assert.deepEqual(argv.slice(0, 4), ['grep', '-n', '-E', '--full-name']);
    assert.equal(argv.length, 6);
    // The pattern reaches git as ONE intact argv entry, unmangled.
    assert.match(argv[4], /^\(from\|require\|import\)\[\[:space:\]\]/);
    assert.match(argv[4], /notification\\\.js\|notification/);
    assert.equal(argv[5], 'main');
  });

  it('reports the probe that produced the number, against the configured ref', () => {
    // AC: the figure must be checkable, not merely trusted.
    const result = probe(
      { '.agents/scripts/x.js': "import { n } from './lib/notification.js';" },
      '.agents/scripts/lib/notification.js',
      { baseBranchRef: 'develop' },
    );
    assert.match(result.probe, /^git grep -n -E /);
    assert.match(result.probe, /develop$/);
    assert.deepEqual(result.files, ['.agents/scripts/x.js']);
  });

  it('maps an empty grep (exit 1) to zero rather than a failure', () => {
    const result = probe({}, '.agents/scripts/lib/gone.js');
    assert.equal(result.count, 0);
    assert.deepEqual(result.files, []);
  });
});

describe('runPlanPersist — flat Story ops', () => {
  it('creates one Story by default with agent::ready and plan-summary', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [ticket('solo')],
        techSpecContent: '## Overview\n\nSmall folded spec.',
      },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.equal(result.stories.length, 1);
    assert.equal(result.primaryStoryId, result.stories[0].id);
    // Story #4692: the cohort grouping label is applied for N=1 too, and the
    // envelope carries it.
    assert.match(result.planRunLabel, /^plan-run::[0-9a-f]{8}$/);

    const issue = provider.issues.get(result.primaryStoryId);
    assert.ok(issue.labels.includes(TYPE_LABELS.STORY));
    assert.ok(issue.labels.includes(AGENT_LABELS.READY));
    assert.ok(issue.labels.includes(result.planRunLabel));
    assert.match(issue.body, /## Spec/);

    const bodies = provider.comments.map((c) => c.body).join('\n');
    assert.match(bodies, /Plan Summary/);
    // Story #4542: persist writes no risk artifact at all — neither the
    // per-Story `risk-verdict` comment nor a risk line on the summary.
    assert.doesNotMatch(bodies, /risk-verdict/);
    void PLAN_SUMMARY_COMMENT_TYPE;
  });

  it('creates Stories WITHOUT agent::ready and flips them only after the checkpoints land', async () => {
    // Story #4541: issues used to be born agent::ready in the creating POST
    // while story-plan-state was upserted afterwards, so a /deliver that picked
    // a Story up inside that window read a null checkpoint.
    // Ready must mean fully persisted.
    const labelsAtCreate = [];
    const provider = fakeProvider({
      createHook: ({ labels }) => labelsAtCreate.push([...labels]),
    });

    // Record the ordering of every write against the created Story.
    const order = [];
    const { postComment } = provider;
    provider.postComment = async (issueNumber, payload) => {
      const body = typeof payload === 'string' ? payload : payload.body;
      if (body.includes('story-plan-state')) order.push('checkpoint');
      return postComment(issueNumber, payload);
    };
    const { updateTicket } = provider;
    provider.updateTicket = async (id, mutations) => {
      if (mutations.labels?.add?.includes(AGENT_LABELS.READY)) {
        order.push('ready');
      }
      return updateTicket(id, mutations);
    };

    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [ticket('solo')] },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.equal(labelsAtCreate.length, 1);
    assert.ok(
      labelsAtCreate[0].includes(TYPE_LABELS.STORY),
      'the creating POST carries type::story',
    );
    assert.ok(
      !labelsAtCreate[0].includes(AGENT_LABELS.READY),
      'the creating POST must not carry agent::ready',
    );
    assert.deepEqual(
      labelsAtCreate[0].filter((l) => l.startsWith('plan-run::')),
      [result.planRunLabel],
      'the creating POST carries the cohort grouping label (Story #4692)',
    );
    assert.equal(order.at(-1), 'ready', 'the ready flip must be terminal');
    assert.ok(order.includes('checkpoint'));
    // And the end state is still a ready Story.
    assert.ok(
      provider.issues
        .get(result.primaryStoryId)
        .labels.includes(AGENT_LABELS.READY),
    );
  });

  it('resumes a cohort after a mid-creation failure instead of duplicating', async () => {
    // Story #4541: createIssue is a sequential loop with no dedup lookup, so
    // a 502 at story k of N left 1..k-1 live and a retry recreated every
    // story. Retry alone cannot fix this (a POST whose response is lost
    // double-creates), so idempotency is the load-bearing half.
    const stories = [ticket('alpha'), ticket('beta'), ticket('gamma')];

    // First run: blow up on the third createIssue.
    let creates = 0;
    const provider = fakeProvider({
      createHook: () => {
        creates += 1;
        if (creates === 3) throw new Error('502 Bad Gateway');
      },
    });
    await assert.rejects(
      () =>
        runPlanPersist({
          provider,
          artifacts: { stories },
          config: {},
          opts: { skipCleanup: true },
        }),
      /502 Bad Gateway/,
    );
    assert.equal(provider.issues.size, 2, 'two Stories are live and stranded');
    // Crucially they are NOT deliverable — no agent::ready reached them.
    for (const issue of provider.issues.values()) {
      assert.ok(
        !issue.labels.includes(AGENT_LABELS.READY),
        'a stranded Story must not be picked up by /deliver',
      );
    }

    // Second run: same authored artifacts, no transient failure.
    const strandedIds = [...provider.issues.keys()];
    const result = await runPlanPersist({
      provider,
      artifacts: { stories },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.equal(
      provider.issues.size,
      3,
      'the resume must complete the cohort, not create a second copy',
    );
    assert.equal(result.stories.length, 3);
    // The two survivors were adopted by id, not recreated.
    const adopted = result.stories.filter((s) => s.adopted).map((s) => s.id);
    assert.deepEqual(adopted.sort(), strandedIds.sort());
    // Every Story — adopted and new — ends up ready with its checkpoint.
    for (const story of result.stories) {
      assert.ok(
        provider.issues.get(story.id).labels.includes(AGENT_LABELS.READY),
      );
    }
  });

  it('does not adopt a same-named Story whose authored content drifted', async () => {
    // The resume fingerprint used to be sha256(slug + NUL + title), matched
    // against every open type::story. So an operator who edited stories.json
    // and re-ran got the *stale* Story adopted: body and Spec never rewritten,
    // and this run's checkpoints/ready-flip landing on the pre-edit content.
    const provider = fakeProvider();
    const first = await runPlanPersist({
      provider,
      artifacts: { stories: [ticketWithGoal('alpha', 'Original goal.')] },
      config: {},
      opts: { skipCleanup: true },
    });
    const staleId = first.primaryStoryId;

    // Same slug, same title — only the authored content differs.
    const second = await runPlanPersist({
      provider,
      artifacts: { stories: [ticketWithGoal('alpha', 'REVISED goal.')] },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.notEqual(
      second.primaryStoryId,
      staleId,
      'an edited Story must not silently adopt the pre-edit issue',
    );
    assert.equal(second.stories[0].adopted, false);
    assert.match(
      provider.issues.get(second.primaryStoryId).body,
      /REVISED goal/,
      'the new Story carries the authored content',
    );
    assert.doesNotMatch(
      provider.issues.get(staleId).body,
      /REVISED goal/,
      'adoption never rewrites a body, so the stale Story stays as it was',
    );
  });

  it('still adopts when the authored content is unchanged (resume, not duplicate)', async () => {
    // Positive control for the tightening above: identical artifacts must
    // still resume, or the fingerprint would be useless.
    const provider = fakeProvider();
    const stories = [ticketWithGoal('alpha', 'Original goal.')];
    const first = await runPlanPersist({
      provider,
      artifacts: { stories },
      config: {},
      opts: { skipCleanup: true },
    });
    const second = await runPlanPersist({
      provider,
      artifacts: { stories },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.equal(second.primaryStoryId, first.primaryStoryId);
    assert.equal(second.stories[0].adopted, true);
    assert.equal(provider.issues.size, 1, 'no duplicate was minted');
  });

  it('applies sanitized authored labels and drops runtime-owned axes', async () => {
    // Story #4541: labels[] was described as required by the descriptor and
    // the prompt schema but never read. Apply it, or stop asking — this is
    // the "apply it" half.
    const provider = fakeProvider();
    const authored = ticket('labelled');
    authored.labels = [
      'type::story',
      'area::planning',
      'agent::done', // runtime-owned lifecycle axis
      'persona::architect', // retired axis
      '', // malformed
    ];

    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [authored] },
      config: {},
      opts: { skipCleanup: true },
    });

    const { labels } = provider.issues.get(result.primaryStoryId);
    assert.ok(labels.includes(TYPE_LABELS.STORY));
    assert.ok(labels.includes('area::planning'), 'authored label is applied');
    assert.ok(!labels.includes('agent::done'), 'agent::* is runtime-owned');
    assert.ok(!labels.includes('persona::architect'), 'persona::* is retired');
    assert.ok(!labels.includes(''));
  });

  it('renders the plan-metrics line in the summary, scoped to this run', async () => {
    // Story #4541: readPlanMetrics is declared (epicId, config) but was
    // called with config first, so the ledger path resolver got the config
    // object as an epicId and threw its guard on every run — a throw the
    // call site swallowed into a silently absent summary line.
    //
    // An ABSOLUTE per-test tempRoot keeps this off the real checkout's
    // shared standalone ledger (which would both poison it and make the
    // assertion depend on the host's plan history).
    const workRoot = mkdtempSync(path.join(tmpdir(), 'plan-metrics-'));
    try {
      const config = { project: { paths: { tempRoot: workRoot } } };
      // A pre-existing record from a *previous* plan run: the scoped
      // summary must not count it.
      await appendPlanMetric(
        {
          cli: 'plan-persist',
          mode: 'persist',
          startedAt: '2020-01-01T00:00:00.000Z',
          endedAt: '2020-01-01T00:00:01.000Z',
          ok: true,
        },
        config,
      );

      const provider = fakeProvider();
      await runPlanPersist({
        provider,
        artifacts: { stories: [ticket('metrics')] },
        config,
        opts: { skipCleanup: true },
      });

      const summary = provider.comments.find((c) =>
        c.body.includes('Plan Summary'),
      );
      const line = summary.body
        .split('\n')
        .find((l) => l.includes('critic skip'));
      assert.ok(
        line,
        `plan-metrics line missing from summary:\n${summary.body}`,
      );
      // This run's own critic skips ARE counted — the line describes work
      // that just happened, which is the point. Reachability is the only
      // skip persist still records: Story #4592 moved the consolidation +
      // pre-mortem evaluation out to the `plan-critics.js` CLI, which runs
      // between Author and Persist where a dispatch verdict still has a
      // re-author loop to route to.
      assert.match(line, /1 critic skip/);
      assert.match(line, /reachability ×1/);
      // The run being summarized counts itself. `recordPlanInvocation`
      // appends its record in a `finally` that fires only once runPlanPersist
      // resolves — long after this comment body is composed — so reading the
      // ledger alone summarized every run *except* this one and reported
      // "0 invocation(s)" onto the very comment reporting it. The in-flight
      // record is folded in to close that ordering gap.
      assert.match(line, /1 invocation\(s\)/);
      assert.match(line, /plan-persist ×1/);
      // ...and the 2020 invocation from a previous plan run is still NOT
      // counted: without the `since` filter this would read "2 invocation(s)",
      // attributing someone else's plan to this one.
      assert.doesNotMatch(line, /2 invocation\(s\)/);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('reports degraded file-assumption findings as ambiguous, not clean', async () => {
    // The posted summary hard-coded `freshness: { stale: 0, ambiguous: 0 }`,
    // so it read "Spec freshness: clean" even on the one run where the gate
    // had given up: an unresolvable base ref downgrades its mismatches to
    // warnings, and the comment then asserted a clean result precisely where
    // it had the least evidence for one.
    //
    // The downgrade is reachable because the two halves resolve the ref
    // differently: validateTickets reads `config` (→ a ref where the file
    // exists, so the mismatch is found), while the gate's probe prefers
    // `settings.baseBranch` (→ unresolvable, so the finding cannot be
    // trusted).
    //
    // validateTickets' half is pinned to `HEAD`, NOT the ambient `main`:
    // `resolveBaseBranchRef` falls through to the literal `main`, which
    // resolves in a local clone/worktree but NOT on a CI `actions/checkout`
    // (a detached HEAD where only `origin/main` exists) — there the
    // `git cat-file -e main:<path>` probe fails, no mismatch is found, and
    // the finding never becomes ambiguous. `HEAD` always resolves and the
    // committed file is present at it, so the mismatch is found in both
    // environments. The flat `config.baseBranch` key routes ONLY to
    // validateTickets (`resolveBaseBranchRef`); the gate reads
    // `config.project.baseBranch ?? settings.baseBranch`, so it still probes
    // the unresolvable `settings.baseBranch` and the divergence holds.
    const mismatched = ticket('drifted');
    mismatched.body = serialize({
      goal: 'Goal of drifted.',
      changes: [
        {
          // This file exists at HEAD, so declaring it as `creates` is a
          // genuine assumption mismatch.
          path: 'tests/scripts/plan-persist.flat-stories.test.js',
          assumption: 'creates',
        },
      ],
      acceptance: ['drifted done'],
      verify: ['npm test (validate)'],
      reason_to_exist: 'Ship drifted',
    });

    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [mismatched] },
      config: { baseBranch: 'HEAD' },
      settings: { baseBranch: 'definitely-not-a-real-branch' },
      opts: { skipCleanup: true },
    });

    assert.deepEqual(
      result.freshness,
      { stale: 0, ambiguous: 1 },
      'an unverifiable finding is ambiguous — it is not confirmed stale, ' +
        'and it is certainly not clean',
    );
    const summary = provider.comments.find((c) =>
      c.body.includes('Plan Summary'),
    );
    const line = summary.body
      .split('\n')
      .find((l) => l.includes('Spec freshness'));
    assert.match(line, /0 stale \/ 1 ambiguous/);
    assert.doesNotMatch(line, /clean/);
  });

  it('reports freshness clean when the gate ran and found nothing', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [ticket('tidy')] },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.deepEqual(result.freshness, { stale: 0, ambiguous: 0 });
    const summary = provider.comments.find((c) =>
      c.body.includes('Plan Summary'),
    );
    assert.match(summary.body, /Spec freshness: clean/);
  });

  it('rejects hard model-capacity findings before issue creation', async () => {
    const provider = fakeProvider();
    // Authored-tokens-only mass: pad Spec above hardSessionTokens: 100.
    const oversized = ticket('oversized');
    const verboseSpec = 'x'.repeat(1200);
    oversized.body = serialize({
      goal: 'A cohesive but oversized session.',
      spec: verboseSpec,
      changes: [
        {
          path: 'tests/scripts/plan-persist.flat-stories.test.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance: oversized.acceptance,
      verify: oversized.verify,
      reason_to_exist: 'Prove hard capacity is enforced',
    });

    await assert.rejects(
      () =>
        runPlanPersist({
          provider,
          artifacts: {
            stories: [oversized],
          },
          opts: {
            modelCapacity: { hardSessionTokens: 100, softSessionTokens: 50 },
            skipCleanup: true,
          },
        }),
      /ticket validation failed.*oversized/s,
    );
    assert.equal(provider.issues.size, 0);
  });

  it('applies exactly one shared plan-run cohort label to N>1 Stories (Story #4692)', async () => {
    // The label groups the Stories one persist run authored — metadata only,
    // for filtering/traceability. It is NOT a delivery input: /deliver takes
    // ids and resolves the graph from live state, and ordering lives in the
    // blocked-by footers.
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [ticket('one'), ticket('two')],
      },
      opts: { skipCleanup: true },
    });
    assert.equal(result.stories.length, 2);
    assert.match(result.planRunLabel, /^plan-run::[0-9a-f]{8}$/);
    for (const s of result.stories) {
      const issue = provider.issues.get(s.id);
      assert.deepEqual(
        issue.labels.filter((l) => l.startsWith('plan-run::')),
        [result.planRunLabel],
        'every Story carries the one shared cohort label',
      );
      const storyComments = provider.comments
        .filter((comment) => comment.issueNumber === s.id)
        .map((comment) => comment.body)
        .join('\n');
      assert.doesNotMatch(storyComments, /risk-verdict/);
      assert.match(storyComments, /story-plan-state/);
    }
  });

  it('drops an author-supplied plan-run:: label — the runtime owns that axis (Story #4692)', async () => {
    const provider = fakeProvider();
    const authored = ticket('owned');
    authored.labels = ['type::story', 'plan-run::hand-authored', 'area::x'];
    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [authored] },
      opts: { skipCleanup: true },
    });
    const { labels } = provider.issues.get(result.primaryStoryId);
    assert.ok(labels.includes('area::x'), 'benign authored label survives');
    assert.ok(
      !labels.includes('plan-run::hand-authored'),
      'the hand-authored plan-run label is dropped',
    );
    assert.deepEqual(
      labels.filter((l) => l.startsWith('plan-run::')),
      [result.planRunLabel],
      'only the runtime-derived cohort label is present',
    );
  });
});

describe('runPlanPersist — ceremony-lite route marker (Story #4707)', () => {
  const liteEnvelope = {
    complexityRoute: {
      route: 'lite',
      reasons: ['trivial single-artifact scope'],
      threshold: { enabled: true, maxSeedWords: 150, maxArtifacts: 1 },
      preserves: {
        storyTicket: true,
        prToMain: true,
        repoGates: true,
        securityBaseline: true,
      },
      advisory: true,
    },
  };
  const fullEnvelope = {
    complexityRoute: {
      ...liteEnvelope.complexityRoute,
      route: 'full',
      reasons: ['not a trivial scope'],
    },
  };

  it('a lite verdict persists the route::lite marker and ledgers the route on the checkpoint (AC-3)', async () => {
    const labelsAtCreate = [];
    const provider = fakeProvider({
      createHook: ({ labels }) => labelsAtCreate.push([...labels]),
    });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [ticket('solo')],
        planContextEnvelope: liteEnvelope,
      },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.equal(result.route.route, 'lite');
    assert.equal(result.route.downgraded, null);
    assert.ok(
      labelsAtCreate[0].includes('route::lite'),
      'the creating POST carries the route marker',
    );
    // Ledgered on plan state: the story-plan-state checkpoint carries the
    // route block, readable by /deliver alongside the label.
    const checkpoint = provider.comments
      .map((c) => c.body)
      .find((b) => b.includes('story-plan-state'));
    assert.match(checkpoint, /"route": "lite"/);
  });

  it('a full verdict persists NO route marker and no checkpoint route block (AC-3)', async () => {
    const labelsAtCreate = [];
    const provider = fakeProvider({
      createHook: ({ labels }) => labelsAtCreate.push([...labels]),
    });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [ticket('solo')],
        planContextEnvelope: fullEnvelope,
      },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.equal(result.route.route, 'full');
    assert.ok(
      labelsAtCreate[0].every((l) => !l.startsWith('route::')),
      'a full-routed Story carries no route marker',
    );
    const checkpoint = provider.comments
      .map((c) => c.body)
      .find((b) => b.includes('story-plan-state'));
    assert.doesNotMatch(checkpoint, /"route"/);
  });

  it('a planner downgrade needs a recorded reason, which is persisted on the checkpoint (AC-2)', async () => {
    const labelsAtCreate = [];
    const provider = fakeProvider({
      createHook: ({ labels }) => labelsAtCreate.push([...labels]),
    });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [ticket('solo')],
        planContextEnvelope: fullEnvelope,
      },
      config: {},
      opts: {
        skipCleanup: true,
        routeDowngradeReason: 'single trivial artifact despite verbose seed',
      },
    });

    assert.equal(result.route.route, 'lite');
    assert.deepEqual(result.route.downgraded, {
      from: 'full',
      reason: 'single trivial artifact despite verbose seed',
    });
    assert.ok(labelsAtCreate[0].includes('route::lite'));
    const checkpoint = provider.comments
      .map((c) => c.body)
      .find((b) => b.includes('story-plan-state'));
    assert.match(checkpoint, /"route": "lite"/);
    assert.match(
      checkpoint,
      /single trivial artifact despite verbose seed/,
      'the recorded downgrade reason is ledgered on plan state',
    );
  });

  it('absent a recorded reason the deterministic verdict stands (AC-2)', async () => {
    for (const routeDowngradeReason of [undefined, null, '', '   ']) {
      const labelsAtCreate = [];
      const provider = fakeProvider({
        createHook: ({ labels }) => labelsAtCreate.push([...labels]),
      });
      const result = await runPlanPersist({
        provider,
        artifacts: {
          stories: [ticket('solo')],
          planContextEnvelope: fullEnvelope,
        },
        config: {},
        opts: { skipCleanup: true, routeDowngradeReason },
      });
      assert.equal(result.route.route, 'full');
      assert.ok(labelsAtCreate[0].every((l) => !l.startsWith('route::')));
    }
  });

  it('no captured envelope means no verdict to downgrade — the plan persists as full', async () => {
    const labelsAtCreate = [];
    const provider = fakeProvider({
      createHook: ({ labels }) => labelsAtCreate.push([...labels]),
    });
    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [ticket('solo')] },
      config: {},
      opts: { skipCleanup: true, routeDowngradeReason: 'orphan reason' },
    });
    assert.equal(result.route, null);
    assert.ok(labelsAtCreate[0].every((l) => !l.startsWith('route::')));
  });
});

describe('runPlanPersist — superseded source tickets (Story #4535)', () => {
  function supersedingTicket(slug, supersedes) {
    return { ...ticket(slug), supersedes };
  }

  function sourceComments(provider, id) {
    return provider.comments
      .filter((comment) => comment.issueNumber === id)
      .map((comment) => comment.body)
      .join('\n');
  }

  it('comments naming the claiming Story and closes as not_planned', async () => {
    const provider = fakeProvider({
      sources: [{ id: 900, title: 'Old idea' }],
    });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [900])],
      },
      opts: { skipCleanup: true, sourceTicketIds: [900] },
    });

    const storyId = result.primaryStoryId;
    assert.deepEqual(result.supersede.closed, [900]);
    assert.deepEqual(result.supersede.failed, []);

    const body = sourceComments(provider, 900);
    assert.match(body, new RegExp(`Superseded by #${storyId}`));
    assert.match(body, /Story solo/);
    assert.match(body, /superseded-by/);
    // Names the specific Story, not a blanket plan-run reference.
    assert.doesNotMatch(body, /superseded by this plan-run/i);

    assert.deepEqual(closeUpdates(provider), [
      { id: 900, mutations: { state: 'closed', state_reason: 'not_planned' } },
    ]);
    assert.equal(provider.issues.get(900).state, 'closed');
  });

  it('renders the per-supersede note authored on the Story', async () => {
    const provider = fakeProvider({ sources: [{ id: 901 }] });
    await runPlanPersist({
      provider,
      artifacts: {
        stories: [
          supersedingTicket('solo', [
            {
              id: 901,
              note: 'The filed fix is provably inert — recorded here.',
            },
          ]),
        ],
      },
      opts: { skipCleanup: true, sourceTicketIds: [901] },
    });

    assert.match(
      sourceComments(provider, 901),
      /The filed fix is provably inert — recorded here\./,
    );
  });

  it('maps each source to exactly one Story when N>1', async () => {
    const provider = fakeProvider({ sources: [{ id: 910 }, { id: 911 }] });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [
          supersedingTicket('one', [910]),
          supersedingTicket('two', [911]),
        ],
      },
      opts: { skipCleanup: true, sourceTicketIds: [910, 911] },
    });

    const byslug = new Map(result.stories.map((s) => [s.slug, s.id]));
    assert.match(
      sourceComments(provider, 910),
      new RegExp(`Superseded by #${byslug.get('one')}`),
    );
    assert.match(
      sourceComments(provider, 911),
      new RegExp(`Superseded by #${byslug.get('two')}`),
    );
    // Story #4540: the supersede comment used to list the batch label for
    // N>1. The label is retired, so it must not appear for any N.
    assert.doesNotMatch(sourceComments(provider, 910), /plan-run/);
  });

  it('fails closed on a partial supersede map before creating any Story', async () => {
    const provider = fakeProvider({ sources: [{ id: 920 }, { id: 921 }] });
    await assert.rejects(
      () =>
        runPlanPersist({
          provider,
          artifacts: {
            stories: [supersedingTicket('solo', [920])],
          },
          opts: { skipCleanup: true, sourceTicketIds: [920, 921] },
        }),
      /supersede partition failed[\s\S]*#921 is not claimed/,
    );
    // Nothing was created: only the two pre-seeded sources remain.
    assert.equal(provider.issues.size, 2);
    assert.deepEqual(closeUpdates(provider), []);
  });

  it('rejects a Story claiming a ticket that was not a source', async () => {
    const provider = fakeProvider({ sources: [{ id: 930 }] });
    await assert.rejects(
      () =>
        runPlanPersist({
          provider,
          artifacts: {
            stories: [supersedingTicket('solo', [930, 999])],
          },
          opts: { skipCleanup: true, sourceTicketIds: [930] },
        }),
      /#999, which was not passed to --tickets/,
    );
    assert.equal(provider.issues.size, 1);
  });

  it('--no-close-superseded leaves sources open but still creates Stories', async () => {
    const provider = fakeProvider({ sources: [{ id: 940 }] });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [940])],
      },
      opts: {
        skipCleanup: true,
        sourceTicketIds: [940],
        closeSuperseded: false,
      },
    });

    assert.equal(result.stories.length, 1);
    assert.equal(result.supersede.enabled, false);
    assert.equal(result.supersede.reason, 'disabled-by-flag');
    assert.equal(sourceComments(provider, 940), '');
    assert.deepEqual(closeUpdates(provider), []);
    assert.equal(provider.issues.get(940).state, 'open');
  });

  it('--dry-run writes nothing and reports what it would have done', async () => {
    const provider = fakeProvider({ sources: [{ id: 950 }] });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [950])],
      },
      opts: { skipCleanup: true, sourceTicketIds: [950], dryRun: true },
    });

    assert.equal(result.supersede.dryRun, true);
    // Reported by slug: dry-run creates no issue, so the only Story
    // identifier that means anything here is the slug.
    assert.deepEqual(result.supersede.planned, [
      { ticket: 950, storySlug: 'solo' },
    ]);
    assert.deepEqual(result.supersede.closed, []);
    assert.equal(sourceComments(provider, 950), '');
    assert.deepEqual(closeUpdates(provider), []);
    assert.equal(provider.issues.get(950).state, 'open');
  });

  it('skips an already-closed source rather than re-commenting', async () => {
    const provider = fakeProvider({
      sources: [{ id: 960, state: 'closed' }],
    });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [960])],
      },
      opts: { skipCleanup: true, sourceTicketIds: [960] },
    });

    assert.deepEqual(result.supersede.closed, []);
    assert.deepEqual(result.supersede.skipped, [
      { ticket: 960, reason: 'already-closed' },
    ]);
    assert.equal(sourceComments(provider, 960), '');
    assert.deepEqual(closeUpdates(provider), []);
  });

  it('skips an inaccessible source without failing the run', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [970])],
      },
      opts: { skipCleanup: true, sourceTicketIds: [970] },
    });

    assert.equal(result.stories.length, 1);
    assert.deepEqual(result.supersede.closed, []);
    assert.equal(result.supersede.skipped[0].ticket, 970);
    assert.match(result.supersede.skipped[0].reason, /inaccessible/);
  });

  it('reports a close failure without failing the run or orphaning Stories', async () => {
    const provider = fakeProvider({ sources: [{ id: 980 }, { id: 981 }] });
    provider.updateTicket = async (id) => {
      if (id === 980) throw new Error('403 forbidden');
      provider.issues.get(id).state = 'closed';
    };

    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [980, 981])],
      },
      opts: { skipCleanup: true, sourceTicketIds: [980, 981] },
    });

    // The Story survives — bookkeeping never fails the run.
    assert.equal(result.stories.length, 1);
    assert.ok(provider.issues.get(result.primaryStoryId));
    assert.deepEqual(result.supersede.closed, [981]);
    assert.deepEqual(result.supersede.failed, [
      { ticket: 980, reason: '403 forbidden' },
    ]);
  });

  it('runs no close phase in seed mode (no source tickets)', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [ticket('solo')] },
      opts: { skipCleanup: true },
    });

    assert.equal(result.stories.length, 1);
    assert.equal(result.supersede.enabled, false);
    assert.equal(result.supersede.reason, 'no-source-tickets');
    assert.equal(result.supersede.sourceTicketOrigin, 'none');
    assert.deepEqual(closeUpdates(provider), []);
  });

  // Story #4554 — the flagless path. `--source-tickets` is never passed; the
  // ids come off the plan-context envelope the run already emitted.
  it('closes the source ticket when the ids were derived from the envelope, with no --source-tickets flag', async () => {
    const provider = fakeProvider({ sources: [{ id: 4525, title: 'Old' }] });
    const { ids, origin } = resolveSourceTicketIds({
      envelope: {
        mode: 'tickets',
        sourceTickets: [{ id: 4525, title: 'Old', body: '' }],
      },
    });

    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [4525])],
      },
      opts: {
        skipCleanup: true,
        sourceTicketIds: ids,
        sourceTicketOrigin: origin,
      },
    });

    assert.equal(result.supersede.sourceTicketOrigin, 'envelope');
    assert.deepEqual(result.supersede.closed, [4525]);
    assert.equal(provider.issues.get(4525).state, 'closed');
  });

  // The vacuous-pass hole itself: an envelope-derived source set turns a
  // forgotten `supersedes[]` into the loud partition error it always should
  // have been, instead of an empty-set pass that reported success.
  it('fail-closes rather than partitioning an empty set when the envelope has sources the Stories do not claim', async () => {
    const provider = fakeProvider({ sources: [{ id: 4525 }] });
    const { ids } = resolveSourceTicketIds({
      envelope: { mode: 'tickets', sourceTickets: [{ id: 4525 }] },
    });

    await assert.rejects(
      runPlanPersist({
        provider,
        artifacts: { stories: [ticket('solo')] },
        opts: { skipCleanup: true, sourceTicketIds: ids },
      }),
      /#4525 is not claimed by any Story/,
    );
    // Fail-closed means fail *before* any GitHub write.
    assert.deepEqual(closeUpdates(provider), []);
  });
});

describe('sanitizeAuthoredLabels (Story #4541)', () => {
  it('always guarantees type::story and dedupes', () => {
    assert.deepEqual(sanitizeAuthoredLabels(undefined, 's'), [
      TYPE_LABELS.STORY,
    ]);
    assert.deepEqual(sanitizeAuthoredLabels([], 's'), [TYPE_LABELS.STORY]);
    assert.deepEqual(sanitizeAuthoredLabels(['area::x', 'area::x'], 's'), [
      TYPE_LABELS.STORY,
      'area::x',
    ]);
  });

  it('drops the axes the runtime owns and the retired persona axis', () => {
    assert.deepEqual(
      sanitizeAuthoredLabels(
        ['agent::ready', 'type::epic', 'persona::qa', 'area::planning'],
        's',
      ),
      [TYPE_LABELS.STORY, 'area::planning'],
    );
  });

  it('drops hand-authored route::* entries — the route axis is runtime-derived (Story #4707)', () => {
    assert.deepEqual(
      sanitizeAuthoredLabels(['route::lite', 'route::full', 'area::x'], 's'),
      [TYPE_LABELS.STORY, 'area::x'],
    );
  });

  it('drops malformed entries rather than posting them', () => {
    assert.deepEqual(
      sanitizeAuthoredLabels(['  ', 42, null, 'x'.repeat(51), 'ok'], 's'),
      [TYPE_LABELS.STORY, 'ok'],
    );
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(sanitizeAuthoredLabels(['  area::x  '], 's'), [
      TYPE_LABELS.STORY,
      'area::x',
    ]);
  });
});

describe('planStoryFingerprint (Story #4541)', () => {
  it('is deterministic across runs over the same authored artifacts', () => {
    const story = { slug: 'alpha', title: 'Story alpha' };
    assert.equal(
      planStoryFingerprint(story),
      planStoryFingerprint({ ...story }),
    );
  });

  it('distinguishes different slugs and titles', () => {
    const base = planStoryFingerprint({ slug: 'alpha', title: 'T' });
    assert.notEqual(base, planStoryFingerprint({ slug: 'beta', title: 'T' }));
    assert.notEqual(base, planStoryFingerprint({ slug: 'alpha', title: 'U' }));
  });

  it('depends on the body — a same-named Story with different content is not the same Story', () => {
    // The safety property of adoption: a fingerprint hit must mean "this open
    // Story is byte-identical to what we would author". Keying on slug+title
    // alone let an unrelated later plan adopt (and never rewrite) a stale
    // Story, and let an edited stories.json resume onto its own pre-edit body.
    assert.notEqual(
      planStoryFingerprint({ slug: 'a', title: 'T', body: 'one' }),
      planStoryFingerprint({ slug: 'a', title: 'T', body: 'two' }),
    );
  });

  it('is stable across a run and its resume (assembled body, slug depends_on)', () => {
    // The rationale that kept the body out was that creation substitutes real
    // issue ids into depends_on footers. It does — but only into the *posted*
    // body, in renderStoryBodyForCreate. The fingerprint is taken over the
    // assembled body, which is a pure function of stories.json, so a resume
    // reproduces it exactly.
    const assembled = { slug: 'a', title: 'T', body: 'goal\n\nblocked by b' };
    assert.equal(
      planStoryFingerprint(assembled),
      planStoryFingerprint({ ...assembled }),
    );
  });

  it('treats a missing body as empty rather than throwing', () => {
    assert.equal(
      planStoryFingerprint({ slug: 'a', title: 'T' }),
      planStoryFingerprint({ slug: 'a', title: 'T', body: '' }),
    );
  });
});

describe('reapStalePlanDirs (Story #4541)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('reaps abandoned plan dirs, keeps fresh ones and non-plan dirs', async () => {
    const workRoot = mkdtempSync(path.join(tmpdir(), 'plan-reap-'));
    try {
      const config = { project: { paths: { tempRoot: workRoot } } };
      const make = (name, ageMs) => {
        const dir = path.join(workRoot, name);
        mkdirSync(dir, { recursive: true });
        const when = new Date(Date.now() - ageMs);
        utimesSync(dir, when, when);
        return dir;
      };
      const stale = make('plan-abandoned', 30 * DAY);
      const fresh = make('plan-in-progress', 1 * DAY);
      const current = make('plan-current', 30 * DAY);
      const unrelated = make('epic-4541', 30 * DAY);

      const { reaped } = await reapStalePlanDirs({ config, keepDir: current });

      assert.deepEqual(reaped, [stale]);
      assert.equal(existsSync(stale), false);
      assert.equal(existsSync(fresh), true, 'a live run must survive');
      assert.equal(existsSync(current), true, 'this run keeps its own dir');
      assert.equal(existsSync(unrelated), true, 'only plan-* is in scope');
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('is a silent no-op when the temp root does not exist', async () => {
    const missing = path.join(tmpdir(), 'plan-reap-absent-does-not-exist');
    assert.deepEqual(
      await reapStalePlanDirs({
        config: { project: { paths: { tempRoot: missing } } },
      }),
      { reaped: [] },
    );
  });
});
