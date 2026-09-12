/**
 * v2 Stage 3 — flat Story persist (no Epic, no deliveryShape).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createGh,
  GhExecError,
  GhRateLimitError,
} from '../../.agents/scripts/lib/gh-exec.js';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../.agents/scripts/lib/label-constants.js';
import { appendPlanMetric } from '../../.agents/scripts/lib/orchestration/plan-metrics.js';
import {
  resolveBaseBranchRef,
  resolveProbeRef,
  validateTickets,
} from '../../.agents/scripts/lib/orchestration/plan-persist/persist-helpers.js';
import {
  reapStalePlanDirs,
  runPlanPersist,
} from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import {
  assemblePlanStories,
  createStoryIssues,
  markStoriesReady,
  planStoryFingerprint,
  sanitizeAuthoredLabels,
} from '../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import { PLAN_SUMMARY_COMMENT_TYPE } from '../../.agents/scripts/lib/orchestration/plan-persist/summary.js';
import { resolveSourceTicketIds } from '../../.agents/scripts/lib/orchestration/plan-persist/supersede-ops.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { FANOUT_CONCURRENCY } from '../../.agents/scripts/lib/util/concurrent-map.js';
import { TicketGateway } from '../../.agents/scripts/providers/github/tickets.js';

/**
 * Story sizes for the fan-out guards below. Every assertion about *how* a
 * fan-out behaves — abandonment, phase ordering — has to run above the bound,
 * because at or below it `concurrentMap` dispatches the whole set up front and
 * the behaviour under test cannot occur. Derived from the bound rather than
 * hard-coded, so a re-tune cannot silently make these guards inert again
 * (Story #4961).
 */
const ABOVE_FANOUT_BOUND = FANOUT_CONCURRENCY + 1;

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

  it('probes origin/<base> when the checkout carries no local base branch', () => {
    // A CI pull-request checkout is detached with only `origin/main`
    // fetched. Probing the bare name there reads every path as absent —
    // which turned each bare-path repair into a `creates` and every
    // declared path into a stale reference on the first #5312 CI run.
    const git = (cwd, ...args) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    const upstream = makeTempDir('probe-ref-upstream-');
    git(upstream, 'init', '-q', '-b', 'main');
    git(upstream, 'config', 'user.email', 'test@example.com');
    git(upstream, 'config', 'user.name', 'Test');
    mkdirSync(path.join(upstream, 'src'));
    writeFileSync(path.join(upstream, 'src', 'tracked.js'), 'x\n');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-q', '-m', 'seed');
    git(upstream, 'checkout', '-q', '-b', 'story-1');
    const clone = path.join(makeTempDir('probe-ref-clone-'), 'repo');
    git(tmpdir(), 'clone', '-q', '--branch', 'story-1', upstream, clone);

    assert.equal(
      resolveProbeRef({ baseBranch: 'main', cwd: clone }),
      'origin/main',
      'no local main, so the tracking ref is the probe target',
    );
    assert.equal(
      resolveProbeRef({ baseBranch: 'main', cwd: upstream }),
      'main',
      'a local branch wins when it exists',
    );
    assert.equal(
      resolveProbeRef({ baseBranch: 'nope', cwd: clone }),
      'nope',
      'a name that resolves nowhere is left for the probe to report',
    );

    // End to end: a bare-path bullet naming a tracked file repairs to
    // refactors-existing in the clone, and the declared path probes clean.
    const bare = ticket('clone');
    bare.body = serialize({
      goal: 'Goal of clone.',
      changes: [{ path: 'src/tracked.js', assumption: 'refactors-existing' }],
      acceptance: bare.acceptance,
      verify: bare.verify,
    }).replace('`src/tracked.js` — refactors-existing', 'src/tracked.js');
    const validated = validateTickets([bare], {}, { cwd: clone });
    assert.deepEqual(validated.errors, []);
    assert.deepEqual(validated.warnings, []);
    assert.equal(validated.repairs.length, 1);
    assert.equal(validated.repairs[0].assumption, 'refactors-existing');
  });

  it('threads the configured branch into the probes, not the literal main', () => {
    // Observable end-to-end: the freshness warning names the ref it probed
    // (Story #5312 demoted the gate from a throw to a listed warning).
    const undeclared = ticket('probe');
    undeclared.acceptance = [
      'The change is consistent with `.agents/scripts/does-not-exist.js`.',
    ];
    const validated = validateTickets([undeclared], {
      project: { baseBranch: 'a-branch-that-does-not-exist' },
    });
    assert.deepEqual(validated.errors, []);
    assert.ok(
      validated.warnings.some((w) =>
        /does not exist at a-branch-that-does-not-exist/.test(w),
      ),
      JSON.stringify(validated.warnings),
    );
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

  it('omits the cohort-filter epilogue line when the label ensure was refused', async () => {
    // Story #5201: both descriptions persist shipped exceeded GitHub's
    // 100-character cap, so `gh label create` 422'd on every run — and the
    // epilogue advertised `filter with label:plan-run::…` for a label that
    // does not exist. Two facts, one of which was being dropped: the derived
    // id (still reported) and whether it actually landed (now gating the
    // line).
    const refusal = new GhExecError('gh-exec: gh exited with code 1', {
      args: ['label', 'create'],
      stderr:
        'HTTP 422: Validation Failed (https://api.github.com/repos/o/r/labels)\n' +
        'description is too long (maximum is 100 characters)',
    });
    const provider = fakeProvider();
    provider.ensureLabels = async () => {
      throw refusal;
    };

    const lines = [];
    const { log, error, warn } = console;
    // Logger fans out across all three sinks (`info` → log, `warn` → warn,
    // and `routeAllOutputToStderr` → error), so capture every one or the
    // assertion depends on which sink a level happens to use today.
    console.log = (msg) => lines.push(String(msg));
    console.error = (msg) => lines.push(String(msg));
    console.warn = (msg) => lines.push(String(msg));
    let result;
    try {
      result = await runPlanPersist({
        provider,
        artifacts: { stories: [ticket('solo')] },
        config: {},
        opts: { skipCleanup: true },
      });
    } finally {
      console.log = log;
      console.error = error;
      console.warn = warn;
    }

    const output = lines.join('\n');
    assert.doesNotMatch(
      output,
      /Cohort grouping label:/,
      'a refused label must not be advertised as a filter',
    );
    assert.match(
      output,
      /description is too long \(maximum is 100 characters\)/,
      "the degrade warning carries gh's own reason, not just the exit status",
    );
    // The derived id survives in the envelope either way — a resumed persist
    // re-derives the identical label, so callers still need to see it.
    assert.match(result.planRunLabel, /^plan-run::[0-9a-f]{8}$/);
    assert.equal(result.stories.length, 1, 'the Stories are still created');
  });

  it('prints the cohort-filter epilogue line when the ensure succeeded', async () => {
    // The other half of the gate: a label that really exists is still
    // advertised, so the fix suppresses a false claim rather than the
    // affordance.
    const provider = fakeProvider();
    provider.ensureLabels = async (defs) => ({
      created: defs.map((d) => d.name),
      skipped: [],
      missing: [],
    });

    const lines = [];
    const { log, error, warn } = console;
    // Logger fans out across all three sinks (`info` → log, `warn` → warn,
    // and `routeAllOutputToStderr` → error), so capture every one or the
    // assertion depends on which sink a level happens to use today.
    console.log = (msg) => lines.push(String(msg));
    console.error = (msg) => lines.push(String(msg));
    console.warn = (msg) => lines.push(String(msg));
    let result;
    try {
      result = await runPlanPersist({
        provider,
        artifacts: { stories: [ticket('solo')] },
        config: {},
        opts: { skipCleanup: true },
      });
    } finally {
      console.log = log;
      console.error = error;
      console.warn = warn;
    }

    assert.match(
      lines.join('\n'),
      new RegExp(`Cohort grouping label: ${result.planRunLabel}`),
    );
  });

  it('creates Stories WITHOUT agent::ready and flips them only after the checkpoints land', async () => {
    // Story #4541: issues used to be born agent::ready in the creating POST
    // while story-plan-state was upserted afterwards, so a /mandrel-deliver that picked
    // a Story up inside that window read a null checkpoint.
    // Ready must mean fully persisted.
    //
    // Story #4961 — run ABOVE the fan-out bound. This used to run at N=1 and
    // assert `order.at(-1) === 'ready'`, which is true of a single Story
    // however the two phases interleave; only a run wider than the bound can
    // expose a ready flip that overlaps a still-pending checkpoint.
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

    const stories = Array.from({ length: ABOVE_FANOUT_BOUND }, (_, i) =>
      ticket(`story-${i}`),
    );
    const result = await runPlanPersist({
      provider,
      artifacts: { stories },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.equal(labelsAtCreate.length, ABOVE_FANOUT_BOUND);
    for (const labels of labelsAtCreate) {
      assert.ok(
        labels.includes(TYPE_LABELS.STORY),
        'the creating POST carries type::story',
      );
      assert.ok(
        !labels.includes(AGENT_LABELS.READY),
        'the creating POST must not carry agent::ready',
      );
      assert.deepEqual(
        labels.filter((l) => l.startsWith('plan-run::')),
        [result.planRunLabel],
        'the creating POST carries the cohort grouping label (Story #4692)',
      );
    }
    assert.equal(
      order.filter((e) => e === 'checkpoint').length,
      ABOVE_FANOUT_BOUND,
    );
    assert.equal(order.filter((e) => e === 'ready').length, ABOVE_FANOUT_BOUND);
    assert.ok(
      order.lastIndexOf('checkpoint') < order.indexOf('ready'),
      `every checkpoint must land before the first ready flip (${order.join(',')})`,
    );
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
        'a stranded Story must not be picked up by /mandrel-deliver',
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
    const workRoot = makeTempDir('plan-metrics-');
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

  it('reports a footprint probe the base branch disagreed with as stale, not clean (Story #5312)', async () => {
    // The posted summary used to hard-code `freshness: { stale: 0, ambiguous: 0 }`,
    // so it read "Spec freshness: clean" even when the gate had something to
    // say. Since Story #5312 a `creates` on a path that exists at base is a
    // warning the persist proceeds past — and the summary counts it as stale
    // rather than asserting a clean result it has the least evidence for.
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
    });

    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [mismatched] },
      // `HEAD` always resolves and the committed file is present at it, so
      // the mismatch is found on a CI `actions/checkout` too.
      config: { baseBranch: 'HEAD' },
      opts: { skipCleanup: true },
    });

    assert.deepEqual(result.freshness, { stale: 1, ambiguous: 0 });
    assert.equal(result.stories.length, 1, 'the persist proceeded');
    assert.ok(
      result.warnings.some((w) => /already exists at the base branch/.test(w)),
      JSON.stringify(result.warnings),
    );
    const summary = provider.comments.find((c) =>
      c.body.includes('Plan Summary'),
    );
    const line = summary.body
      .split('\n')
      .find((l) => l.includes('Spec freshness'));
    assert.match(line, /1 stale \/ 0 ambiguous/);
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

  it('applies exactly one shared plan-run cohort label to N>1 Stories (Story #4692)', async () => {
    // The label groups the Stories one persist run authored — metadata only,
    // for filtering/traceability. It is NOT a delivery input: /mandrel-deliver takes
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
    const workRoot = makeTempDir('plan-reap-');
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

// ---------------------------------------------------------------------------
// Story #4952 — the independent per-Story write loops run under bounded
// concurrency; the loop that is NOT independent stays serial.
// ---------------------------------------------------------------------------

/**
 * Wrap a provider method so the test can observe how many calls are in flight
 * at once, and hold each call open long enough for overlap to be visible.
 *
 * A serial loop can never exceed a peak of 1; a bounded fan-out must exceed 1
 * and must never exceed its bound.
 */
function trackInFlight(target, method, { hold = 5 } = {}) {
  const original = target[method].bind(target);
  const state = { peak: 0, inFlight: 0, calls: [] };
  target[method] = async (...args) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    state.calls.push(args[0]);
    try {
      await new Promise((resolve) => setTimeout(resolve, hold));
      return await original(...args);
    } finally {
      state.inFlight -= 1;
    }
  };
  return state;
}

describe('markStoriesReady — bounded concurrency (Story #4952)', () => {
  it('flips every Story concurrently, under the bound, in created order', async () => {
    const provider = fakeProvider();
    const created = Array.from({ length: 9 }, (_, i) => ({
      id: 7000 + i,
      slug: `story-${i}`,
    }));
    for (const story of created) {
      provider.issues.set(story.id, { id: story.id, labels: [] });
    }

    const flips = trackInFlight(provider, 'updateTicket');
    const { readied } = await markStoriesReady({ provider, created });

    assert.deepEqual(
      readied,
      created.map((s) => s.id),
      'readied[] follows created[] order, as the serial loop produced it',
    );
    assert.ok(flips.peak > 1, `expected concurrent flips, peak=${flips.peak}`);
    assert.ok(
      flips.peak <= 4,
      `expected a bounded fan-out, peak=${flips.peak}`,
    );
    for (const story of created) {
      assert.ok(
        provider.issues.get(story.id).labels.includes(AGENT_LABELS.READY),
      );
    }
  });

  it('collects every failure instead of fast-failing on the first one', async () => {
    // The contract the conversion must not lose: the closing error names the
    // COMPLETE set of ids that still need the label by hand, so every Story is
    // attempted even after an earlier PATCH rejects. concurrentMap's
    // first-rejection-wins policy would abandon the rest.
    //
    // Story #4961 — sized ABOVE the bound on purpose. At n <= concurrency every
    // unit is dispatched before the first rejection can be observed, so an
    // implementation that DID abandon the remainder would still attempt all of
    // them and this assertion could never fail. The failures are seeded in the
    // first dispatched window so the abandoned tail is the one being counted.
    const provider = fakeProvider();
    const size = ABOVE_FANOUT_BOUND + 4;
    const created = Array.from({ length: size }, (_, i) => ({
      id: 7100 + i,
      slug: `story-${i}`,
    }));
    assert.ok(
      created.length > FANOUT_CONCURRENCY,
      'the guard is only meaningful above the fan-out bound',
    );
    for (const story of created) {
      provider.issues.set(story.id, { id: story.id, labels: [] });
    }
    const failing = new Set([7100, 7102]);
    const attempted = [];
    provider.updateTicket = async (id) => {
      attempted.push(id);
      // Yield so the first rejections land while later units are still
      // undispatched — the exact window an abandoning implementation loses.
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (failing.has(id)) {
        throw new Error(`boom ${id}`);
      }
      provider.issues.get(id).labels.push(AGENT_LABELS.READY);
    };

    await assert.rejects(
      () => markStoriesReady({ provider, created }),
      (err) => {
        assert.match(err.message, /#7100 \(story-0\): boom 7100/);
        assert.match(err.message, /#7102 \(story-2\): boom 7102/);
        assert.match(err.message, /2 Story\(ies\) were created/);
        return true;
      },
    );
    assert.deepEqual(
      attempted.sort((a, b) => a - b),
      created.map((s) => s.id),
      'the first failure must not abandon the remaining flips',
    );
    // Every Story that could be flipped still was — including the tail an
    // abandoning fan-out would never have reached.
    for (const story of created) {
      if (failing.has(story.id)) continue;
      assert.ok(
        provider.issues.get(story.id).labels.includes(AGENT_LABELS.READY),
        `#${story.id} must still have been flipped`,
      );
    }
  });

  it('keeps collecting every failure when the flips run through the real retrying write path (Story #4961)', async () => {
    // The two halves of this Story meet here: the ready flip now goes through
    // `withTransientRetry` inside TicketGateway, and `markStoriesReady` must
    // still report the COMPLETE failure set on the other side of it. Driven
    // through the real gateway rather than a hand-rolled fake, so the retry is
    // the production one.
    //
    // #7200 is rate-limited once and then succeeds — it must NOT appear as a
    // failure. #7201 is refused permanently — it must, and on the first
    // attempt, because a permanent error is not retry-eligible.
    const rateLimitedOnce = new Set([7200]);
    const calls = [];
    const exec = async ({ args }) => {
      const id = Number(args[3].match(/issues\/(\d+)/)[1]);
      calls.push(id);
      if (rateLimitedOnce.has(id)) {
        rateLimitedOnce.delete(id);
        throw new GhRateLimitError('gh-exec: gh API rate limit exceeded');
      }
      if (id === 7201) {
        throw new GhExecError('gh-exec: gh exited with code 422: refused');
      }
      return { stdout: '{}', stderr: '', code: 0 };
    };
    const provider = new TicketGateway({
      gh: createGh(exec),
      owner: 'o',
      repo: 'r',
    });
    const created = [
      { id: 7200, slug: 'retried' },
      { id: 7201, slug: 'refused' },
      { id: 7202, slug: 'clean' },
    ];

    await assert.rejects(
      () => markStoriesReady({ provider, created }),
      (err) => {
        assert.match(err.message, /#7201 \(refused\): .*refused/);
        assert.doesNotMatch(
          err.message,
          /#7200/,
          'a retried-then-successful flip is not a failure',
        );
        assert.match(err.message, /1 Story\(ies\) were created/);
        return true;
      },
    );
    assert.deepEqual(
      calls.filter((id) => id === 7200).length,
      2,
      'the rate-limited flip was retried',
    );
    assert.equal(
      calls.filter((id) => id === 7201).length,
      1,
      'the permanent refusal was not retried',
    );
    assert.ok(calls.includes(7202), 'the remaining flip was still attempted');
  });
});

describe('createStoryIssues — deliberately serial (Story #4952 AC-3)', () => {
  it('creates dependency-ordered Stories one at a time so idBySlug is filled in order', async () => {
    // NOT an independent fan-out: renderStoryBodyForCreate resolves a Story's
    // depends_on slugs against ids its siblings were just minted with, and
    // idBySlug fills in loop order. Concurrent creation would render
    // `#undefined` dependency refs.
    const provider = fakeProvider();
    const creates = trackInFlight(provider, 'createIssue');

    const { stories } = assemblePlanStories([
      { ...ticket('base'), depends_on: [] },
      { ...ticket('middle'), depends_on: ['base'] },
      { ...ticket('leaf'), depends_on: ['middle'] },
    ]);
    const { created } = await createStoryIssues({ provider, stories });

    assert.equal(
      creates.peak,
      1,
      `createStoryIssues must stay serial, peak=${creates.peak}`,
    );
    assert.deepEqual(
      created.map((s) => s.slug),
      ['base', 'middle', 'leaf'],
      'creation follows the dependency order',
    );

    const idBySlug = new Map(created.map((s) => [s.slug, s.id]));
    const middleBody = provider.issues.get(idBySlug.get('middle')).body;
    const leafBody = provider.issues.get(idBySlug.get('leaf')).body;
    assert.match(middleBody, new RegExp(`#${idBySlug.get('base')}`));
    assert.match(leafBody, new RegExp(`#${idBySlug.get('middle')}`));
    assert.doesNotMatch(middleBody, /#undefined/);
    assert.doesNotMatch(leafBody, /#undefined/);
  });
});

describe('persist write loops — concurrent, ordering preserved (Story #4952)', () => {
  it('fans the checkpoints out but lands every one before the first ready flip', async () => {
    // Story #4541's invariant survives the fan-out: agent::ready still means
    // "fully persisted", so no phase may overlap the next. Sized above the
    // bound (Story #4961) so the checkpoint phase cannot be dispatched in a
    // single window — a leaked ready flip has somewhere to interleave.
    const provider = fakeProvider();
    const order = [];
    let checkpointsInFlight = 0;
    let checkpointPeak = 0;

    const { postComment } = provider;
    provider.postComment = async (issueNumber, payload) => {
      const body = typeof payload === 'string' ? payload : payload.body;
      if (body.includes('story-plan-state')) {
        checkpointsInFlight += 1;
        checkpointPeak = Math.max(checkpointPeak, checkpointsInFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        checkpointsInFlight -= 1;
        order.push('checkpoint');
      }
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
      artifacts: {
        stories: Array.from({ length: ABOVE_FANOUT_BOUND }, (_, i) =>
          ticket(`story-${i}`),
        ),
      },
      config: {},
      opts: { skipCleanup: true },
    });

    assert.equal(result.stories.length, ABOVE_FANOUT_BOUND);
    assert.ok(
      checkpointPeak > 1,
      `expected the checkpoint writes to overlap, peak=${checkpointPeak}`,
    );
    assert.ok(
      checkpointPeak <= FANOUT_CONCURRENCY,
      `expected a bounded fan-out, peak=${checkpointPeak}`,
    );
    const lastCheckpoint = order.lastIndexOf('checkpoint');
    const firstReady = order.indexOf('ready');
    assert.equal(
      order.filter((e) => e === 'checkpoint').length,
      ABOVE_FANOUT_BOUND,
    );
    assert.equal(order.filter((e) => e === 'ready').length, ABOVE_FANOUT_BOUND);
    assert.ok(
      lastCheckpoint < firstReady,
      `every checkpoint must land before the first ready flip (${order.join(',')})`,
    );
  });
});

describe('supersede close — bounded concurrency (Story #4952)', () => {
  function supersedingTicket(slug, supersedes) {
    return { ...ticket(slug), supersedes };
  }

  it('closes distinct tickets concurrently, keeping probe → comment → close per ticket', async () => {
    const sourceIds = [940, 941, 942, 943, 944];
    const provider = fakeProvider({
      sources: sourceIds.map((id) => ({ id, title: `Source ${id}` })),
    });

    /** Per-ticket call log, plus the cross-ticket overlap peak. */
    const log = new Map(sourceIds.map((id) => [id, []]));
    let inFlight = 0;
    let peak = 0;

    const { getTicket } = provider;
    provider.getTicket = async (id, opts) => {
      if (log.has(id)) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        log.get(id).push('probe');
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      }
      return getTicket(id, opts);
    };
    const { postComment } = provider;
    provider.postComment = async (issueNumber, payload) => {
      if (log.has(issueNumber)) log.get(issueNumber).push('comment');
      return postComment(issueNumber, payload);
    };
    const { updateTicket } = provider;
    provider.updateTicket = async (id, mutations) => {
      if (log.has(id) && mutations.state === 'closed') {
        log.get(id).push('close');
      }
      return updateTicket(id, mutations);
    };

    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: sourceIds.map((id, i) =>
          supersedingTicket(`story-${i}`, [id]),
        ),
      },
      opts: { skipCleanup: true, sourceTicketIds: sourceIds },
    });

    assert.deepEqual(
      result.supersede.closed,
      sourceIds,
      'report order is stable',
    );
    assert.deepEqual(result.supersede.failed, []);
    assert.ok(
      peak > 1,
      `expected concurrent probes across tickets, peak=${peak}`,
    );
    assert.ok(peak <= 4, `expected a bounded fan-out, peak=${peak}`);
    for (const id of sourceIds) {
      assert.deepEqual(
        log.get(id),
        ['probe', 'comment', 'close'],
        `#${id} must stay probe → comment → close`,
      );
    }
  });

  it('keeps per-unit failures per-unit — one bad ticket never abandons the rest', async () => {
    // Story #4961 — sized above the fan-out bound. At n <= concurrency every
    // unit is already dispatched when the first one refuses, so a unit that
    // let its rejection escape would still leave the rest closed and this
    // assertion could not fail. The refusal is seeded in the first dispatched
    // window so the tail is genuinely at risk.
    const sourceIds = Array.from(
      { length: ABOVE_FANOUT_BOUND + 2 },
      (_, i) => 950 + i,
    );
    const refusedId = 951;
    const provider = fakeProvider({
      sources: sourceIds.map((id) => ({ id })),
    });
    const { updateTicket } = provider;
    provider.updateTicket = async (id, mutations) => {
      if (id === refusedId && mutations.state === 'closed') {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('close refused');
      }
      return updateTicket(id, mutations);
    };

    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: sourceIds.map((id, i) =>
          supersedingTicket(`story-${i}`, [id]),
        ),
      },
      opts: { skipCleanup: true, sourceTicketIds: sourceIds },
    });

    const expectedClosed = sourceIds.filter((id) => id !== refusedId);
    assert.deepEqual(
      result.supersede.closed,
      expectedClosed,
      'one refused unit must not abandon the tail',
    );
    assert.deepEqual(result.supersede.failed, [
      { ticket: refusedId, reason: 'close refused' },
    ]);
    for (const id of expectedClosed) {
      assert.equal(provider.issues.get(id).state, 'closed', `#${id} closed`);
    }
  });
});
