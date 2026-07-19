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
import test from 'node:test';

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
  assert.deepEqual(out.discarded, [
    { category: 'lint-loop', occurrences: 1, source: 'framework' },
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

  const run = composeRoutedProposals(
    baseInput({ signals: [closeFailed(42), closeFailed(42)] }),
  );
  assert.match(run.framework[0].title, /in plan-run 2547/);
});
