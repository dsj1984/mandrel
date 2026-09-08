/**
 * Unit tests for `composeRoutedProposals` (Story #2558, Epic #2547).
 *
 * Coverage:
 *   - Empty/invalid input → empty arrays.
 *   - >=2 occurrences ⇒ actionable; ==1 ⇒ discarded.
 *   - Source routing follows the dominant `source` tag.
 *   - Memory section is a free-text instruction list (not frontmatter).
 *   - Memorable single-occurrence categories are NOT discarded.
 *   - Unresolved agent::blocked events force actionable even with < 2 occurrences.
 *   - Deterministic ordering (sorted by category).
 *   - Pre-drafted `gh issue create` command shape includes `--repo`,
 *     `--label`, and `--body-file - <<EOF` heredoc.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { graduateRetroProposals } from '../../../.agents/scripts/lib/feedback-loop/retro-proposals-graduator.js';
import { composeRoutedProposals } from '../../../.agents/scripts/lib/orchestration/retro-proposals.js';

const FRAMEWORK_REPO = 'dsj1984/mandrel';
const CONSUMER_REPO = 'dsj1984/domio';

function baseInput(overrides = {}) {
  return {
    anchorId: 2547,
    anchorKind: 'run',
    frameworkRepo: FRAMEWORK_REPO,
    consumerRepo: CONSUMER_REPO,
    signals: [],
    unresolvedBlockedEvents: [],
    ...overrides,
  };
}

test('composeRoutedProposals: returns empty arrays for empty input', () => {
  const out = composeRoutedProposals(baseInput());
  assert.deepEqual(out, { framework: [], consumer: [], discarded: [] });
});

test('composeRoutedProposals: returns empty arrays for null/undefined/invalid input', () => {
  assert.deepEqual(composeRoutedProposals(null), {
    framework: [],
    consumer: [],
    discarded: [],
  });
  assert.deepEqual(composeRoutedProposals(undefined), {
    framework: [],
    consumer: [],
    discarded: [],
  });
  // Missing anchorId
  assert.deepEqual(
    composeRoutedProposals({
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
    }),
    { framework: [], consumer: [], discarded: [] },
  );
  // Missing repos
  assert.deepEqual(composeRoutedProposals({ anchorId: 1 }), {
    framework: [],
    consumer: [],
    discarded: [],
  });
});

test('composeRoutedProposals: >=2 occurrences become actionable; ==1 discarded', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'lint-loop', source: 'framework' },
        { category: 'lint-loop', source: 'framework' },
        { category: 'lint-loop', source: 'framework' },
        { category: 'flaky-deploy', source: 'consumer' },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'lint-loop');
  assert.equal(out.framework[0].occurrences, 3);
  assert.equal(out.consumer.length, 0);
  assert.equal(out.discarded.length, 1);
  assert.equal(out.discarded[0].category, 'flaky-deploy');
  assert.equal(out.discarded[0].occurrences, 1);
});

test('composeRoutedProposals: routes by dominant source tag', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        // 2× framework, 1× consumer ⇒ framework dominant
        { category: 'mixed', source: 'framework' },
        { category: 'mixed', source: 'framework' },
        { category: 'mixed', source: 'consumer' },
        // 3× consumer ⇒ consumer dominant
        { category: 'consumer-only', source: 'consumer' },
        { category: 'consumer-only', source: 'consumer' },
        { category: 'consumer-only', source: 'consumer' },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'mixed');
  assert.equal(out.consumer.length, 1);
  assert.equal(out.consumer[0].category, 'consumer-only');
});

test('composeRoutedProposals: source tie resolves to first-seen source deterministically', () => {
  const a = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'tie', source: 'consumer' },
        { category: 'tie', source: 'framework' },
      ],
    }),
  );
  assert.equal(a.consumer.length, 1, 'first-seen consumer wins tie');
  assert.equal(a.framework.length, 0);

  const b = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'tie', source: 'framework' },
        { category: 'tie', source: 'consumer' },
      ],
    }),
  );
  assert.equal(b.framework.length, 1, 'first-seen framework wins tie');
  assert.equal(b.consumer.length, 0);
});

test('composeRoutedProposals: single-occurrence friction is discarded (no memory rescue)', () => {
  // The former "memory pane" rescued single-occurrence memorable
  // categories from the discarded bucket. That pane was deleted in the
  // Epic #4406 cutover — a lone occurrence is now always discarded, and
  // the result carries no `memory` bucket.
  const out = composeRoutedProposals(
    baseInput({
      signals: [{ category: 'edge-case', source: 'consumer' }],
    }),
  );
  assert.equal(Object.hasOwn(out, 'memory'), false, 'no memory bucket');
  assert.equal(out.discarded.length, 1);
  assert.equal(out.discarded[0].category, 'edge-case');
  assert.equal(out.framework.length, 0);
  assert.equal(out.consumer.length, 0);
});

test('composeRoutedProposals: unresolved agent::blocked forces actionable even with <2 occurrences', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [{ category: 'auth-regress', source: 'consumer' }],
      unresolvedBlockedEvents: [
        {
          ticketId: 9999,
          source: 'consumer',
          category: 'auth-regress',
          summary: 'Login broken at story close',
        },
      ],
    }),
  );
  assert.equal(out.consumer.length, 1);
  assert.equal(out.consumer[0].category, 'auth-regress');
  assert.equal(out.discarded.length, 0);
});

test('composeRoutedProposals: blocked event with no friction signal still produces an actionable', () => {
  const out = composeRoutedProposals(
    baseInput({
      unresolvedBlockedEvents: [
        {
          ticketId: 9999,
          source: 'framework',
          category: 'dispatch-stuck',
        },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'dispatch-stuck');
  assert.equal(out.framework[0].occurrences, 0);
});

test('composeRoutedProposals: deterministic ordering — output sorted by category', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'zeta', source: 'framework' },
        { category: 'zeta', source: 'framework' },
        { category: 'alpha', source: 'framework' },
        { category: 'alpha', source: 'framework' },
        { category: 'mid', source: 'consumer' },
        { category: 'mid', source: 'consumer' },
      ],
    }),
  );
  assert.deepEqual(
    out.framework.map((i) => i.category),
    ['alpha', 'zeta'],
  );
  assert.deepEqual(
    out.consumer.map((i) => i.category),
    ['mid'],
  );
});

test('composeRoutedProposals: gh issue create command shape is correct', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'lint-loop', source: 'framework' },
        { category: 'lint-loop', source: 'framework' },
      ],
    }),
  );
  const cmd = out.framework[0].command;
  assert.match(cmd, /gh issue create --repo dsj1984\/mandrel/);
  assert.match(
    cmd,
    /--title "Friction: lint-loop recurred 2 times in plan-run 2547"/,
  );
  assert.match(cmd, /--label "meta::framework-gap,friction::lint-loop"/);
  assert.match(cmd, /--body-file - <<EOF/);
  assert.match(cmd, /\nEOF$/);
});

test('composeRoutedProposals: consumer routing uses consumer-improvement meta label', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'flaky-test', source: 'consumer' },
        { category: 'flaky-test', source: 'consumer' },
      ],
    }),
  );
  const cmd = out.consumer[0].command;
  assert.match(cmd, /--repo dsj1984\/domio/);
  assert.match(cmd, /meta::consumer-improvement,friction::flaky-test/);
});

test('composeRoutedProposals: skips malformed signal records without crashing', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        null,
        undefined,
        'not-an-object',
        42,
        { category: '', source: 'framework' }, // empty category dropped
        { category: 'good', source: 'framework' },
        { category: 'good', source: 'framework' },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'good');
});

// --- Story #4622: net out transient (self-resolved) blocks ---------------

const blk = (storyId, extra = {}) => ({
  category: 'story-blocked',
  source: 'consumer',
  storyId,
  details: {},
  ...extra,
});
const recovered = (storyId) =>
  blk(storyId, { details: { recovered: true, toState: 'agent::executing' } });

test('netOutRecoveredIncidents: a recovered block drops the whole incident (no proposal)', () => {
  const out = composeRoutedProposals(
    baseInput({
      // Two Stories, each blocked then recovered → 4 story-blocked records,
      // all transient. Nothing should route or even be discarded.
      signals: [blk(1), recovered(1), blk(2), recovered(2)],
    }),
  );
  assert.deepEqual(out, { framework: [], consumer: [], discarded: [] });
});

test('netOutRecoveredIncidents: terminal blocks (no recovery) still count', () => {
  const out = composeRoutedProposals(baseInput({ signals: [blk(3), blk(4)] }));
  const blocked = out.consumer.find((i) => i.category === 'story-blocked');
  assert.ok(blocked, 'two terminal blocks route as an actionable proposal');
  assert.equal(blocked.occurrences, 2);
});

test('netOutRecoveredIncidents: only the recovered Story is netted out; terminal peers remain', () => {
  const out = composeRoutedProposals(
    baseInput({
      // Story 5 recovered; Stories 6 and 7 stayed blocked.
      signals: [blk(5), recovered(5), blk(6), blk(7)],
    }),
  );
  const blocked = out.consumer.find((i) => i.category === 'story-blocked');
  assert.ok(blocked, 'the two terminal peers still route');
  assert.equal(blocked.occurrences, 2, 'Story 5 (block + marker) is excluded');
});

test('netOutRecoveredIncidents: does not touch other categories', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        blk(8),
        recovered(8),
        { category: 'lint-loop', source: 'framework', storyId: 8 },
        { category: 'lint-loop', source: 'framework', storyId: 9 },
      ],
    }),
  );
  const lint = out.framework.find((i) => i.category === 'lint-loop');
  assert.ok(lint, 'lint-loop is untouched by block netting');
  assert.equal(lint.occurrences, 2);
  assert.equal(
    out.consumer.find((i) => i.category === 'story-blocked'),
    undefined,
    'the recovered block contributes nothing',
  );
});

// --- Story #4649: netting generalizes past story-blocked -------------------

const closeFailed = (storyId, extra = {}) => ({
  category: 'close-failed',
  source: 'framework',
  storyId,
  details: {},
  ...extra,
});
const closeRecovered = (storyId) =>
  closeFailed(storyId, { details: { recovered: true } });

test('netOutRecoveredIncidents: a fail-then-land close nets out to nothing', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        closeFailed(1),
        closeRecovered(1),
        closeFailed(2),
        closeRecovered(2),
      ],
    }),
  );
  assert.deepEqual(out, { framework: [], consumer: [], discarded: [] });
});

test('netOutRecoveredIncidents: a close that never recovered still counts', () => {
  const out = composeRoutedProposals(
    baseInput({ signals: [closeFailed(3), closeFailed(4)] }),
  );
  const failed = out.framework.find((i) => i.category === 'close-failed');
  assert.ok(failed, 'two unrecovered closes route as an actionable proposal');
  assert.equal(failed.occurrences, 2);
});

test('netOutRecoveredIncidents: netting is per-category, not per-Story', () => {
  // Story 5 recovered its close but stayed blocked. Netting the Story
  // wholesale would wrongly cancel the block too.
  const out = composeRoutedProposals(
    baseInput({
      signals: [closeFailed(5), closeRecovered(5), blk(5), blk(6)],
    }),
  );
  assert.equal(
    out.framework.find((i) => i.category === 'close-failed'),
    undefined,
    'the recovered close contributes nothing',
  );
  const blocked = out.consumer.find((i) => i.category === 'story-blocked');
  assert.ok(blocked, 'the untouched blocks still route');
  assert.equal(blocked.occurrences, 2);
});

test('netOutRecoveredIncidents: a marker only cancels its own Story', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        closeFailed(7),
        closeRecovered(7),
        closeFailed(8),
        closeFailed(9),
      ],
    }),
  );
  const failed = out.framework.find((i) => i.category === 'close-failed');
  assert.ok(failed, 'Stories 8 and 9 still route');
  assert.equal(failed.occurrences, 2, 'Story 7 (fail + marker) is excluded');
});

test('netOutRecoveredIncidents: a marker with no story id nets nothing', () => {
  // Without a `storyId` there is no incident to attribute the recovery to;
  // guessing would silently swallow a real failure.
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        closeFailed(10),
        closeFailed(11),
        {
          category: 'close-failed',
          source: 'framework',
          details: { recovered: true },
        },
      ],
    }),
  );
  const failed = out.framework.find((i) => i.category === 'close-failed');
  assert.ok(failed);
  assert.equal(failed.occurrences, 3, 'the unattributable marker nets nothing');
});

// --- Story #4649: the threshold is uniform across anchors ------------------

test('isActionableFriction: story anchor discards a singleton, same as run', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorKind: 'story',
      anchorId: 42,
      signals: [{ category: 'lint-loop', source: 'framework', storyId: 42 }],
    }),
  );
  assert.deepEqual(out.framework, []);
  // Story #4824 widened DiscardedItem with the descriptive fields a
  // below-threshold roll-up needs to name what it discarded.
  assert.deepEqual(out.discarded, [
    {
      category: 'lint-loop',
      occurrences: 1,
      source: 'framework',
      tools: [],
      fingerprint: out.discarded[0].fingerprint,
      storyCount: 1,
    },
  ]);
});

test('isActionableFriction: a forced block still routes at one occurrence', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorKind: 'story',
      anchorId: 42,
      signals: [blk(42)],
      unresolvedBlockedEvents: [
        { ticketId: 42, source: 'consumer', category: 'story-blocked' },
      ],
    }),
  );
  assert.equal(out.consumer.length, 1);
  assert.equal(out.consumer[0].category, 'story-blocked');
  assert.equal(out.consumer[0].occurrences, 1);
});

test('anchorKind still selects the wording', () => {
  const story = composeRoutedProposals(
    baseInput({
      anchorKind: 'story',
      anchorId: 42,
      signals: [closeFailed(42), closeFailed(42)],
    }),
  );
  assert.match(story.framework[0].title, /in Story #42/);

  // Story #4850 — a run corpus confined to the run's own Stories keeps the
  // plain wording; `anchorStoryIds` is what says the corpus IS this run.
  const run = composeRoutedProposals(
    baseInput({
      anchorStoryIds: [42],
      signals: [closeFailed(42), closeFailed(42)],
    }),
  );
  assert.match(run.framework[0].title, /in plan-run 2547/);
});

// --- Story #4850: the title must not misname its own corpus -----------------

/** A dated `tool-degraded` row, the shape a systemic framework defect emits. */
function dated(storyId, ts) {
  return {
    category: 'tool-degraded',
    source: 'framework',
    storyId,
    tool: 'native-review-lint',
    ts,
    details: { surface: 'scoped-lint', reason: 'no parseable output' },
  };
}

test('AC-1: a corpus spanning foreign Stories is titled by its window, not by the triggering run', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4850,
      runToken: 'adhoc-4850-4851',
      anchorStoryIds: [4850, 4851],
      signals: [
        dated(4820, '2026-07-02T10:00:00.000Z'),
        dated(4833, '2026-07-11T08:30:00.000Z'),
        dated(4851, '2026-07-29T22:15:00.000Z'),
      ],
    }),
  );

  const { title } = out.framework[0];
  // The three facts a triager needs: how often, over how many Stories, when.
  assert.match(title, /recurred 3 times/);
  assert.match(title, /across 3 Stories/);
  assert.match(title, /\(2026-07-02 → 2026-07-29\)/);
  // And the claim that was false: these occurrences did not happen in the
  // triggering run, and the title must not say they did.
  assert.doesNotMatch(title, /in plan-run/);
  assert.doesNotMatch(title, /adhoc-4850-4851/);
});

test('AC-2: the body opens on the corpus window and labels the triggering run separately', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4850,
      runToken: 'adhoc-4850-4851',
      anchorStoryIds: [4850, 4851],
      signals: [
        dated(4820, '2026-07-02T10:00:00.000Z'),
        dated(4833, '2026-07-11T08:30:00.000Z'),
      ],
    }),
  );

  const { body } = out.framework[0];
  const [opening] = body.split('\n');
  assert.match(opening, /surfaced 2 times across 2 Stories/);
  assert.match(opening, /between 2026-07-02 and 2026-07-11/);
  assert.doesNotMatch(
    opening,
    /during /,
    'the opening line asserted the whole corpus happened in the triggering run',
  );
  // The run is still named — as the trigger, alongside the Stories it did NOT
  // contribute, rather than as the scope of the count.
  assert.match(body, /Triggering run: plan-run adhoc-4850-4851/);
  assert.match(body, /Contributing Stories \(2\): #4820, #4833/);
});

test('AC-8: a corpus confined to the run keeps naming the run in title and body', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4850,
      runToken: 'adhoc-4850-4851',
      anchorStoryIds: [4850, 4851],
      signals: [
        dated(4850, '2026-07-29T10:00:00.000Z'),
        dated(4851, '2026-07-29T11:00:00.000Z'),
      ],
    }),
  );

  const item = out.framework[0];
  assert.equal(
    item.title,
    'Friction: tool-degraded recurred 2 times in plan-run adhoc-4850-4851',
    'the common single-run case must not regress into hedged wording',
  );
  assert.match(item.body, /Triggering run: plan-run adhoc-4850-4851/);
  // Same-day corpus → a single date, not a degenerate "X → X" range.
  assert.match(item.body, /surfaced 2 times across 2 Stories on 2026-07-29\./);
});

test('the triggering-anchor label tracks anchorKind on both paths', () => {
  // Story #4850 introduced the fact with a fixed `Triggering run` label, so the
  // story-scope path called a Story a run ("Triggering run: Story #7"). The
  // wording must follow the anchor the way every other label in this file does.
  const story = composeRoutedProposals(
    baseInput({
      anchorKind: 'story',
      anchorId: 7,
      signals: [closeFailed(7), closeFailed(7)],
    }),
  );
  assert.match(story.framework[0].body, /Triggering Story: Story #7/);
  assert.doesNotMatch(
    story.framework[0].body,
    /Triggering run/,
    'the story-scope body labelled its anchoring Story a run',
  );

  const run = composeRoutedProposals(
    baseInput({
      anchorId: 4850,
      runToken: 'adhoc-4850-4851',
      signals: [closeFailed(4850), closeFailed(4851)],
    }),
  );
  assert.match(
    run.framework[0].body,
    /Triggering run: plan-run adhoc-4850-4851/,
  );
  assert.doesNotMatch(run.framework[0].body, /Triggering Story/);
});

test('AC-1: an undateable corpus omits the range rather than inventing one', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4850,
      anchorStoryIds: [4850],
      signals: [
        dated(4820, undefined),
        dated(4833, 'not-a-timestamp'),
        dated(4844, ''),
      ],
    }),
  );

  const { title, body } = out.framework[0];
  assert.equal(
    title,
    'Friction: tool-degraded recurred 3 times across 3 Stories',
  );
  assert.match(body, /surfaced 3 times across 3 Stories\./);
});

test('AC-6: the run token reaches the composer as an input, not as a post-hoc patch', () => {
  // The pre-#4850 epilogue rewrote `plan-run <primary story id>` by regex. The
  // composer must render the caller's token itself, including a non-numeric
  // one no `plan-run \d+` pattern could ever have matched.
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4850,
      runToken: 'adhoc-4850-4851',
      anchorStoryIds: [4850],
      signals: [dated(4850, '2026-07-29T10:00:00.000Z'), dated(4850, null)],
    }),
  );
  assert.match(out.framework[0].title, /in plan-run adhoc-4850-4851$/);
  assert.doesNotMatch(out.framework[0].title, /plan-run 4850\b/);
});

// --- Story #4824: the framework bucket is reachable end to end -------------

/**
 * Route `gh` child processes for the graduator walk. Both read probes report
 * empty (nothing filed yet), and `gh issue create` records the `--repo` it
 * was invoked with — which is the whole assertion: a framework-sourced
 * proposal must file against `frameworkRepo`, never `currentRepo`.
 */
function makeGhSpawnStub() {
  const created = [];
  const fn = function spawnImpl(cmd, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let result = { stdout: '', code: 0 };
    if (cmd !== 'gh') {
      result = { stdout: '', code: 1 };
    } else if (args[0] === 'search') {
      result = { stdout: '[]', code: 0 };
    } else if (args[0] === 'issue' && args[1] === 'list') {
      result = { stdout: '[]', code: 0 };
    } else if (args[0] === 'issue' && args[1] === 'create') {
      const repoIdx = args.indexOf('--repo');
      const labels = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--label') labels.push(args[i + 1]);
      }
      created.push({ repo: repoIdx >= 0 ? args[repoIdx + 1] : null, labels });
      result = {
        stdout: `https://github.com/x/y/issues/${created.length}`,
        code: 0,
      };
    }
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      child.emit('close', result.code);
    });
    return child;
  };
  fn.created = created;
  return fn;
}

const stubProvider = {
  getTicketComments: async () => [],
  postComment: async () => ({ commentId: 1 }),
  deleteComment: async () => {},
};

test('framework-sourced signals compose a non-empty framework bucket', () => {
  // Pre-#4824 no production path could produce a framework-tagged signal at
  // all, so this bucket was permanently empty and everything downstream of it
  // was dead code.
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        {
          category: 'tool-degraded',
          source: 'framework',
          storyId: 8601,
          tool: 'native-review-lint',
        },
        {
          category: 'tool-degraded',
          source: 'framework',
          storyId: 8602,
          tool: 'native-review-lint',
        },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.consumer.length, 0);
  assert.equal(out.framework[0].category, 'tool-degraded');
  assert.match(
    out.framework[0].command,
    new RegExp(`--repo ${FRAMEWORK_REPO}`),
  );
});

test('graduateRetroProposals files the framework bucket against frameworkRepo', async () => {
  const spawnImpl = makeGhSpawnStub();
  const routedProposals = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'tool-degraded', source: 'framework', storyId: 8701 },
        { category: 'tool-degraded', source: 'framework', storyId: 8702 },
      ],
    }),
  );

  const [fwOwner, fwRepo] = FRAMEWORK_REPO.split('/');
  const result = await graduateRetroProposals({
    epicId: 8701,
    provider: stubProvider,
    config: {},
    // Running inside the framework repo itself — the cross-repo guard lets
    // the filing through, so the `--repo` argument is observable.
    currentRepo: { owner: fwOwner, repo: fwRepo },
    frameworkRepo: { owner: fwOwner, repo: fwRepo },
    routedProposals,
    spawnImpl,
  });

  assert.equal(result.filed.length, 1);
  assert.equal(result.filed[0].source, 'framework');
  assert.equal(result.filed[0].repo, FRAMEWORK_REPO);
  assert.equal(spawnImpl.created.length, 1);
  assert.equal(spawnImpl.created[0].repo, FRAMEWORK_REPO);
  assert.ok(spawnImpl.created[0].labels.includes('meta::framework-gap'));
});

test('a framework proposal routes to frameworkRepo, not the consumer it ran in', async () => {
  const spawnImpl = makeGhSpawnStub();
  const routedProposals = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'tool-degraded', source: 'framework', storyId: 8801 },
        { category: 'tool-degraded', source: 'framework', storyId: 8802 },
      ],
    }),
  );

  const [cOwner, cRepo] = CONSUMER_REPO.split('/');
  const [fwOwner, fwRepo] = FRAMEWORK_REPO.split('/');
  const result = await graduateRetroProposals({
    epicId: 8801,
    provider: stubProvider,
    config: {},
    currentRepo: { owner: cOwner, repo: cRepo },
    frameworkRepo: { owner: fwOwner, repo: fwRepo },
    routedProposals,
    spawnImpl,
  });

  // Cross-repo filings are deferred to a durable comment rather than created
  // blind in someone else's repo — but the routing target is the framework
  // repo, and nothing is filed in the consumer.
  assert.equal(
    spawnImpl.created.length,
    0,
    'never files a framework gap into the consumer repo',
  );
  const deferred = result.skipped.find((s) =>
    /cross-repo/.test(s.reason ?? ''),
  );
  assert.ok(
    deferred,
    `expected a cross-repo skip; got ${JSON.stringify(result.skipped)}`,
  );
});

/**
 * Story #4828 — the run epilogue over Stories 4824 + 4825 gathered nine
 * friction signals and filed nothing, and the leading hypothesis was that
 * `normaliseInput` had rejected the epilogue's input and short-circuited
 * `composeRoutedProposals` to `emptyResult()`.
 *
 * It had not. Replaying the real corpus proved the composer routes it
 * correctly, which is what moved the investigation downstream to the filer.
 * These two tests pin that verdict so the disproven hypothesis stays
 * disproven: the first fixes the exact shape the epilogue builds, the second
 * fixes what `emptyResult()` is actually for, so a future regression cannot
 * quietly re-answer either question.
 */

/** The exact corpus the run epilogue read: 9 signals across two Stories. */
function epilogueCorpus() {
  const toolDegraded = [4825, 4801, 4802, 4808, 4811].map((storyId) => ({
    category: 'tool-degraded',
    source: 'consumer',
    storyId,
    tool: 'native-review-lint',
    details: { surface: 'scoped-lint', reason: 'no parseable output' },
  }));
  return [
    ...toolDegraded,
    // Both of these self-resolved, so each incident carries a recovery marker
    // and nets out — which is why the real roll-up's `discarded` was empty.
    { category: 'story-blocked', source: 'framework', storyId: 4824 },
    {
      category: 'story-blocked',
      source: 'framework',
      storyId: 4824,
      details: { recovered: true },
    },
    { category: 'close-failed', source: 'framework', storyId: 4825 },
    {
      category: 'close-failed',
      source: 'framework',
      storyId: 4825,
      details: { recovered: true },
    },
  ];
}

test('the run epilogue input shape routes rather than returning an empty result', () => {
  const signals = epilogueCorpus();
  assert.equal(signals.length, 9, 'the pinned corpus is the measured one');

  const out = composeRoutedProposals({
    anchorId: 4824,
    anchorKind: 'run',
    // In a framework-repo run `resolveFollowUpRepos` returns the same slug
    // for both, which is the shape the epilogue actually passed.
    frameworkRepo: FRAMEWORK_REPO,
    consumerRepo: FRAMEWORK_REPO,
    signals,
    unresolvedBlockedEvents: [],
  });

  assert.notDeepEqual(
    out,
    { framework: [], consumer: [], discarded: [] },
    'a 9-signal corpus at threshold must not compose to the empty result',
  );
  assert.equal(out.consumer.length, 1);
  assert.equal(out.consumer[0].category, 'tool-degraded');
  assert.equal(out.consumer[0].occurrences, 5);
  assert.deepEqual(out.framework, [], 'both framework categories netted out');
  assert.deepEqual(out.discarded, [], 'nothing sat below the threshold');
});

/**
 * Story #4837 — an auto-filed issue must be actionable by someone who was
 * not in the run.
 *
 * Story #4824 put the emitting tools, a details fingerprint and a
 * distinct-Story span on the aggregate entry, but projected them only onto
 * the discarded rows. The one bucket that became a real GitHub issue was
 * still rendered from a category and a count.
 */
test('AC-5: a rendered body names the emitter, surface, reason and contributing Stories', () => {
  // Arrange — one category, two emitters, three Stories.
  const signals = [
    {
      category: 'close-failed',
      source: 'framework',
      storyId: 4801,
      tool: 'single-story-close',
      details: { surface: 'close-validation', reason: 'coverage gate crashed' },
    },
    {
      category: 'close-failed',
      source: 'framework',
      storyId: 4807,
      tool: 'single-story-close',
      details: { surface: 'close-validation', reason: 'coverage gate crashed' },
    },
    {
      category: 'close-failed',
      source: 'framework',
      storyId: 4828,
      tool: 'merge-watch',
      details: {
        surface: 'auto-merge',
        reason: 'required check never reported',
      },
    },
  ];

  // Act.
  const out = composeRoutedProposals(baseInput({ anchorId: 4801, signals }));

  // Assert — every piece of evidence the reader needs is in the body.
  const { body } = out.framework[0];
  assert.match(body, /Emitted by: merge-watch, single-story-close/);
  assert.match(body, /Surface: auto-merge, close-validation/);
  assert.match(body, /Reason: .*coverage gate crashed/);
  assert.match(body, /Reason: .*required check never reported/);
  assert.match(body, /Contributing Stories \(3\): #4801, #4807, #4828/);
  assert.match(body, /Shape fingerprint: [0-9a-f]{8}/);
});

test('AC-6: the finding behind issue #4836 names the scoped-lint surface and its emitter', () => {
  // Arrange — the real shape `native-review-lint` emits when the scoped lint
  // runner cannot execute and the review gate fails open (Story #4699).
  const degraded = (storyId) => ({
    category: 'tool-degraded',
    source: 'consumer',
    storyId,
    tool: 'native-review-lint',
    details: {
      surface: 'scoped-lint',
      reason:
        'lint runner produced no parseable output (binary missing, parse failure, or environment issue)',
    },
  });

  // Act.
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4828,
      signals: [degraded(4828), degraded(4829), degraded(4830)],
    }),
  );

  // Assert — the body describes the degraded gate, not just "×3".
  const item = out.consumer[0];
  assert.equal(item.category, 'tool-degraded');
  assert.match(item.body, /Emitted by: native-review-lint/);
  assert.match(item.body, /Surface: scoped-lint/);
  assert.match(item.body, /lint runner produced no parseable output/);
  assert.match(item.body, /Contributing Stories \(3\): #4828, #4829, #4830/);

  // Regression pin: the pre-#4837 body was exactly these two lines and
  // nothing else — that is what made issue #4836 unactionable.
  assert.match(
    item.body,
    /Recurring friction category "tool-degraded" surfaced 3 times/,
  );
  assert.ok(
    item.body.split('\n').filter((l) => l.startsWith('Emitted by:')).length ===
      1,
    'the emitter is named exactly once',
  );

  // The evidence rides into the pre-drafted command stanza too, so a
  // toggle-OFF run pastes the same actionable body.
  assert.match(item.command, /Surface: scoped-lint/);
});

test('AC-5: a bucket with no evidence renders without empty placeholder lines', () => {
  // A forced-actionable block carries no aggregated signals to describe.
  const out = composeRoutedProposals(
    baseInput({
      unresolvedBlockedEvents: [
        { ticketId: 4837, source: 'framework', category: 'story-blocked' },
      ],
    }),
  );
  const { body } = out.framework[0];
  assert.ok(!body.includes('Emitted by:'), 'no empty emitter line');
  assert.ok(!body.includes('Surface:'), 'no empty surface line');
  assert.ok(!body.includes('Contributing Stories'), 'no empty Stories line');
  assert.match(body, /Source classification: framework\./);
});

test('AC-5: the rendered body is byte-stable across signal ordering', () => {
  // The body is rewritten onto a live issue on every recurrence, so an
  // ordering-dependent render would churn the issue with no change of meaning.
  const a = {
    category: 'lint-loop',
    source: 'consumer',
    storyId: 12,
    tool: 'biome',
    details: { surface: 's1', reason: 'r1' },
  };
  const b = {
    category: 'lint-loop',
    source: 'consumer',
    storyId: 7,
    tool: 'ast-grep',
    details: { surface: 's2', reason: 'r2' },
  };
  const forward = composeRoutedProposals(baseInput({ signals: [a, b] }));
  const reversed = composeRoutedProposals(baseInput({ signals: [b, a] }));
  assert.equal(forward.consumer[0].body, reversed.consumer[0].body);
  assert.match(forward.consumer[0].body, /Contributing Stories \(2\): #7, #12/);
});

test('emptyResult is reserved for input the composer cannot use at all', () => {
  const empty = { framework: [], consumer: [], discarded: [] };
  const signals = epilogueCorpus();
  // A non-numeric anchor is the rejection `normaliseInput` really implements —
  // an anchorId the epilogue never passes, because it anchors on the primary
  // Story id rather than the hex plan-run token.
  assert.deepEqual(
    composeRoutedProposals({
      anchorId: 'e8caf51a',
      anchorKind: 'run',
      frameworkRepo: FRAMEWORK_REPO,
      consumerRepo: FRAMEWORK_REPO,
      signals,
      unresolvedBlockedEvents: [],
    }),
    empty,
  );
  assert.deepEqual(
    composeRoutedProposals({
      anchorId: 4824,
      anchorKind: 'run',
      frameworkRepo: '',
      consumerRepo: FRAMEWORK_REPO,
      signals,
      unresolvedBlockedEvents: [],
    }),
    empty,
  );
});

// ---------------------------------------------------------------------------
// Story #4892 — unresolvable contributing-Story evidence is never published
// ---------------------------------------------------------------------------

/**
 * The measured shape behind issue #4870: the light path's diff-backstop
 * refusal, emitted once by a real Story and once by a `--story 999999` test
 * fixture that reached the live signals tree.
 */
const rejected = (storyId) => ({
  category: 'light-scope-rejected',
  source: 'framework',
  storyId,
  tool: 'deliver-light',
  // The PLURAL key, because that is what `recordScopeFriction` actually
  // writes. The singular `reason` this fixture used to carry is a shape no
  // light-path emitter has ever produced, which is how the dropped-reasons
  // defect (issue #5237) stayed invisible to this suite.
  details: {
    surface: 'diff-backstop',
    reasons: ['actual change set is unknown'],
  },
});

test('#4892 AC-3: an unresolvable contributing id is withheld from the filed body', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      signals: [rejected(4856), rejected(999999)],
    }),
  );

  const item = out.framework[0];
  assert.equal(item.category, 'light-scope-rejected');
  // Both occurrences still count — the bucket recurred twice, and netting the
  // OCCURRENCE would be a different (and wrong) fix.
  assert.equal(item.occurrences, 2);
  // Only the resolvable Story is named, and the count matches what is named.
  assert.match(item.body, /Contributing Stories \(1\): #4856$/m);
  assert.ok(
    !item.body.includes('999999'),
    'a fixture id must never reach a filed issue body',
  );
  assert.ok(
    !item.command.includes('999999'),
    'nor the pre-drafted command stanza an operator pastes',
  );
});

test('#4892 AC-4: a proposal whose contributing Stories are ALL unresolvable does not auto-file', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      signals: [rejected(999998), rejected(999999)],
    }),
  );

  // Nothing routed → the graduator has nothing to file (it walks
  // framework/consumer only).
  assert.deepEqual(out.framework, []);
  assert.deepEqual(out.consumer, []);
  // Still recorded, so the noise is visible without becoming a ticket.
  assert.equal(out.discarded.length, 1);
  assert.equal(out.discarded[0].category, 'light-scope-rejected');
  assert.equal(out.discarded[0].occurrences, 2);
  assert.equal(
    out.discarded[0].storyCount,
    0,
    'an unresolvable id must not be counted as recurrence evidence either',
  );
});

test('#4892 AC-4: a forced-actionable block with NO contributing Stories still files', () => {
  // "No cited Stories" is not "cited Stories that do not resolve" — this is
  // the unresolved-block path, whose evidence is the block itself.
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      unresolvedBlockedEvents: [
        { ticketId: 4870, source: 'framework', category: 'story-blocked' },
      ],
    }),
  );

  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'story-blocked');
});

test('#4892 AC-5: the cross-run window survives — a real Story outside the run is still published', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      anchorStoryIds: [4870],
      signals: [rejected(4856), rejected(4801), rejected(999999)],
    }),
  );

  const item = out.framework[0];
  // #4801 and #4856 are outside the anchor's own Stories and are counted:
  // withholding is a resolvability bound, never a narrowing of the window.
  assert.match(item.body, /Contributing Stories \(2\): #4801, #4856$/m);
  assert.match(item.title, /across 2 Stories/);
  assert.ok(!item.title.includes('in plan-run'), 'the corpus is not confined');
});

// ---------------------------------------------------------------------------
// Story #5238 — the light path's refusal reasons reach the filed body, and
// unrelated refusal classes stop aggregating into one follow-up (issue #5237)
// ---------------------------------------------------------------------------

const EMPTY_DIFF_REASON =
  'actual change set is unknown or empty — cannot verify the diff is light; escalate to /mandrel-plan';
const SENSITIVE_REASON =
  'diff intersects sensitive-path class(es) public-api — escalate to /mandrel-plan (do not land light)';

/** A diff-backstop refusal in the shape the light path emits it. */
const backstopRefusal = ({ storyId, category, reasons }) => ({
  category,
  source: 'framework',
  storyId,
  tool: 'deliver-light',
  details: { surface: 'diff-backstop', reasons },
});

test('#5238 AC-1: a plural details.reasons[] reaches the rendered Reason line', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      signals: [
        backstopRefusal({
          storyId: 4856,
          category: 'light-scope-rejected-sensitive-path',
          reasons: [SENSITIVE_REASON],
        }),
        backstopRefusal({
          storyId: 4857,
          category: 'light-scope-rejected-sensitive-path',
          reasons: [SENSITIVE_REASON],
        }),
      ],
    }),
  );

  const item = out.framework[0];
  // The whole point of the ticket: this line used to be absent entirely, so
  // the filed issue named a count and a category and nothing else.
  assert.match(item.body, /^Reason: /m);
  assert.match(
    item.body,
    /diff intersects sensitive-path class\(es\) public-api/,
  );
  // And it rides into the pre-drafted command an operator pastes.
  assert.match(item.command, /diff intersects sensitive-path/);
});

test('#5238 AC-1: the singular details.reason emitters still render, and both shapes can share a bucket', () => {
  const degraded = (storyId, details) => ({
    category: 'tool-degraded',
    source: 'framework',
    storyId,
    tool: 'native-review-lint',
    details: { surface: 'scoped-lint', ...details },
  });

  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      signals: [
        degraded(4801, { reason: 'no parseable output' }),
        degraded(4802, { reasons: ['binary missing', 'parse failure'] }),
      ],
    }),
  );

  const { body } = out.framework[0];
  assert.match(body, /no parseable output/);
  assert.match(body, /binary missing/);
  assert.match(body, /parse failure/);
});

test('#5238 AC-1: a non-string reasons member is skipped, never coerced into the body', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      signals: [
        backstopRefusal({
          storyId: 4856,
          category: 'light-scope-rejected-over-ceiling',
          reasons: [{ nested: 'object' }, 'diff changes 4000 line(s)'],
        }),
        backstopRefusal({
          storyId: 4857,
          category: 'light-scope-rejected-over-ceiling',
          reasons: ['diff changes 4000 line(s)'],
        }),
      ],
    }),
  );

  const { body } = out.framework[0];
  assert.match(body, /diff changes 4000 line\(s\)/);
  assert.ok(
    !body.includes('[object Object]'),
    'a non-string reason must never be stringified into a live issue body',
  );
});

test('#5238 AC-4: two refusal CLASSES do not aggregate into one follow-up', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      signals: [
        backstopRefusal({
          storyId: 4856,
          category: 'light-scope-rejected-change-set-unknown',
          reasons: [EMPTY_DIFF_REASON],
        }),
        backstopRefusal({
          storyId: 4857,
          category: 'light-scope-rejected-sensitive-path',
          reasons: [SENSITIVE_REASON],
        }),
      ],
    }),
  );

  // The measured shape behind the misleading follow-up: an uncommitted-diff
  // refusal and a public-api refusal are one occurrence each, so NEITHER
  // reaches the recurrence threshold and no "recurred 2 times" issue is filed.
  assert.deepEqual(out.framework, []);
  assert.equal(out.discarded.length, 2);
  assert.deepEqual(
    out.discarded.map((d) => d.occurrences),
    [1, 1],
  );
});

test('#5238 AC-4: N refusals of the SAME class still coalesce into one proposal', () => {
  const out = composeRoutedProposals(
    baseInput({
      anchorId: 4870,
      signals: [
        backstopRefusal({
          storyId: 4856,
          category: 'light-scope-rejected-sensitive-path',
          reasons: [SENSITIVE_REASON],
        }),
        backstopRefusal({
          storyId: 4857,
          category: 'light-scope-rejected-sensitive-path',
          reasons: [SENSITIVE_REASON],
        }),
      ],
    }),
  );

  assert.equal(out.framework.length, 1);
  assert.equal(
    out.framework[0].category,
    'light-scope-rejected-sensitive-path',
  );
  assert.equal(out.framework[0].occurrences, 2);
  // The recurrence claim the ceilings are recalibrated from is intact.
  assert.match(
    out.framework[0].body,
    /Contributing Stories \(2\): #4856, #4857/,
  );
});
