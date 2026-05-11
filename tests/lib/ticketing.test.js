import assert from 'node:assert/strict';
import test from 'node:test';
import { ITicketingProvider } from '../../.agents/scripts/lib/ITicketingProvider.js';
import {
  assertValidStructuredCommentType,
  cascadeCompletion,
  isValidStructuredCommentType,
  postStructuredComment,
  STRUCTURED_COMMENT_TYPES,
  structuredCommentMarker,
  toggleTasklistCheckbox,
  transitionTicketState,
  upsertStructuredComment,
  WAVE_TYPE_PATTERN,
} from '../../.agents/scripts/lib/orchestration/ticketing.js';

class MockProvider extends ITicketingProvider {
  constructor() {
    super();
    this.updates = [];
    this.comments = [];
    this.tickets = {
      1: {
        id: 1,
        labels: ['agent::ready'],
        body: 'Epic body\n- [ ] #2',
        state: 'open',
      },
      2: {
        id: 2,
        labels: ['agent::executing'],
        body: 'Feature body\n- [ ] #3',
        state: 'open',
      },
      3: { id: 3, labels: ['agent::done'], body: 'Story body', state: 'open' },
    };
    this.deps = {
      1: { blocks: [], blockedBy: [2] },
      2: { blocks: [1], blockedBy: [3] },
      3: { blocks: [2], blockedBy: [] },
    };
    this.subTickets = {
      1: [this.tickets[2]],
      2: [this.tickets[3]],
      3: [],
    };
  }

  async getTicket(id) {
    return this.tickets[id];
  }

  async updateTicket(id, mutations) {
    this.updates.push({ id, mutations });

    // Minimal mock update applying changes to local ticket
    if (mutations.labels) {
      const rm = mutations.labels.remove || [];
      const add = mutations.labels.add || [];
      let current = this.tickets[id].labels.filter((l) => !rm.includes(l));
      current = [...new Set([...current, ...add])];
      this.tickets[id].labels = current;
    }

    if (mutations.body !== undefined) {
      this.tickets[id].body = mutations.body;
    }
  }

  async postComment(id, payload) {
    this.comments.push({ id, payload });
  }

  async getTicketDependencies(id) {
    return this.deps[id];
  }

  async getSubTickets(id) {
    // Return dynamically from this.tickets based on IDs to simulate state changes
    return this.subTickets[id].map((t) => this.tickets[t.id]);
  }
}

test('ticketing.js', async (t) => {
  let mock;

  t.beforeEach(() => {
    mock = new MockProvider();
  });

  await t.test('transitionTicketState logic', async () => {
    await transitionTicketState(mock, 2, 'agent::ready');
    assert.deepEqual(mock.updates[0].mutations.labels.add, ['agent::ready']);
    assert.deepEqual(mock.updates[0].mutations.labels.remove, [
      'agent::executing',
      'agent::done',
    ]);
    // Non-done states should reopen the issue
    assert.strictEqual(mock.updates[0].mutations.state, 'open');
    assert.strictEqual(mock.updates[0].mutations.state_reason, null);
    assert.ok(mock.tickets[2].labels.includes('agent::ready'));
    assert.ok(!mock.tickets[2].labels.includes('agent::executing'));
  });

  await t.test(
    'transitionTicketState closes issue when transitioning to agent::done',
    async () => {
      await transitionTicketState(mock, 2, 'agent::done');
      const mutation = mock.updates[0].mutations;
      assert.deepEqual(mutation.labels.add, ['agent::done']);
      assert.strictEqual(
        mutation.state,
        'closed',
        'Issue should be closed on agent::done',
      );
      assert.strictEqual(
        mutation.state_reason,
        'completed',
        'state_reason should be "completed"',
      );
    },
  );

  await t.test(
    'transitionTicketState invokes notify with severity and message',
    async () => {
      // Seed ticket #2 with type label and Epic reference so the call posts
      // to the epic and captures `fromState` correctly. Use a Story →
      // `agent::done` transition because `transitionTicketState` suppresses
      // the dispatch entirely for low-severity transitions (task-level, or
      // non-terminal story / epic flips) under the curated event-allowlist
      // model — the noise filter moved from the channel boundary to the
      // emit point.
      mock.tickets[2] = {
        ...mock.tickets[2],
        labels: ['agent::executing', 'type::story'],
        body: 'Feature body\n\nEpic: #1\n- [ ] #3',
        title: 'Wire Notifier',
        html_url: 'https://example.test/issues/2',
      };

      const calls = [];
      const fakeNotify = (ticketId, payload) => {
        calls.push({ ticketId, payload });
        return Promise.resolve();
      };

      await transitionTicketState(mock, 2, 'agent::done', {
        notify: fakeNotify,
      });
      // Allow the fire-and-forget promise to settle.
      await Promise.resolve();

      assert.equal(calls.length, 1);
      // Story → done rates `medium` per eventSeverity.
      assert.equal(calls[0].payload.severity, 'medium');
      // Posts to the parent epic id parsed from the body.
      assert.equal(calls[0].ticketId, 1);
      assert.match(calls[0].payload.message, /story #2/);
      assert.match(calls[0].payload.message, /agent::executing/);
      assert.match(calls[0].payload.message, /agent::done/);
    },
  );

  await t.test(
    'transitionTicketState suppresses notify for low-severity transitions',
    async () => {
      // Task transitions and intermediate Story/Epic flips compute as `low`
      // severity and must not reach the notify channel — preserves the
      // silent-init behavior previously enforced by `commentMinLevel:
      // medium` filtering.
      mock.tickets[2] = {
        ...mock.tickets[2],
        labels: ['agent::executing', 'type::story'],
        body: 'Feature body\n\nEpic: #1',
        title: 'Wire Notifier',
      };

      const calls = [];
      const fakeNotify = (ticketId, payload) => {
        calls.push({ ticketId, payload });
        return Promise.resolve();
      };

      await transitionTicketState(mock, 2, 'agent::ready', {
        notify: fakeNotify,
      });
      await Promise.resolve();

      assert.equal(
        calls.length,
        0,
        'low-severity transition must be suppressed at the emit point',
      );
    },
  );

  await t.test(
    'transitionTicketState marks Story → done as medium severity',
    async () => {
      mock.tickets[2] = {
        ...mock.tickets[2],
        labels: ['agent::executing', 'type::story'],
        body: 'Feature body\n\nEpic: #1',
        title: 'Wire Notifier',
      };

      const calls = [];
      const fakeNotify = (ticketId, payload) => {
        calls.push({ ticketId, payload });
        return Promise.resolve();
      };

      await transitionTicketState(mock, 2, 'agent::done', {
        notify: fakeNotify,
      });
      await Promise.resolve();

      // Story reaching `agent::done` rates `medium`.
      assert.ok(
        calls.some((c) => c.payload.severity === 'medium'),
        'expected at least one medium-severity notify call',
      );
    },
  );

  await t.test(
    'transitionTicketState without a notify fn does not throw',
    async () => {
      // Guard against a regression where an unconditional call on an undefined
      // notify would throw.
      await transitionTicketState(mock, 2, 'agent::ready');
      assert.ok(mock.tickets[2].labels.includes('agent::ready'));
    },
  );

  await t.test(
    'transitionTicketState surfaces a rejected notify dispatch via console.warn instead of swallowing it',
    async () => {
      // Reset state so this test runs independently of the prior cases.
      // Use a story → done transition so the dispatch is not suppressed at
      // the low-severity emit gate.
      const isolated = new MockProvider();
      isolated.tickets[2] = {
        ...isolated.tickets[2],
        labels: ['agent::executing', 'type::story'],
        body: 'Feature body\n\nEpic: #1',
      };
      // Notify rejects asynchronously — the rejection is what the prior
      // .catch(() => {}) silently dropped.
      const failingNotify = () => Promise.reject(new Error('webhook 503'));

      const warnings = [];
      const original = console.warn;
      console.warn = (msg) => warnings.push(String(msg));

      try {
        await transitionTicketState(isolated, 2, 'agent::done', {
          notify: failingNotify,
        });
        // The fire-and-forget chain queues the .catch on the microtask queue;
        // a single tick is enough for the warn to fire.
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        console.warn = original;
      }

      assert.ok(
        warnings.some(
          (w) =>
            w.includes('notify dispatch failed') && w.includes('webhook 503'),
        ),
        `expected a 'notify dispatch failed' warning citing the webhook error, got: ${JSON.stringify(warnings)}`,
      );
    },
  );

  await t.test(
    'cascadeCompletion forwards notify to recursive transitions',
    async () => {
      // Tag the cascade chain so the → `agent::done` transitions rate
      // `medium` severity and reach the notify channel. Under the curated
      // allowlist model `transitionTicketState` suppresses low-severity
      // (untyped or task) dispatches at the emit point, so the cascade
      // would otherwise silently drop every fire. Both intermediate
      // tickets are tagged `type::story` rather than `type::epic` because
      // `cascadeCompletion` deliberately *skips* auto-close on Epics
      // (their close path is `/epic-deliver`, not the cascade).
      mock.tickets[1].labels = ['agent::executing', 'type::story'];
      mock.tickets[2].labels = ['agent::executing', 'type::story'];
      mock.tickets[3].labels = ['agent::done'];
      const calls = [];
      const fakeNotify = (ticketId, payload) => {
        calls.push({ ticketId, payload });
        return Promise.resolve();
      };

      await cascadeCompletion(mock, 3, { notify: fakeNotify });
      await Promise.resolve();

      // #2 and #1 should both have been transitioned to agent::done via
      // cascade, each producing one notify call.
      assert.ok(
        calls.length >= 2,
        `expected ≥2 notify calls, got ${calls.length}`,
      );
    },
  );

  await t.test('toggleTasklistCheckbox logic', async () => {
    await toggleTasklistCheckbox(mock, 1, 2, true);
    assert.strictEqual(mock.tickets[1].body, 'Epic body\n- [x] #2');

    await toggleTasklistCheckbox(mock, 1, 2, false);
    assert.strictEqual(mock.tickets[1].body, 'Epic body\n- [ ] #2');
  });

  await t.test('postStructuredComment logic', async () => {
    await postStructuredComment(mock, 1, 'progress', 'Did something');
    assert.strictEqual(mock.comments[0].payload.body, 'Did something');
    assert.strictEqual(mock.comments[0].payload.type, 'progress');
  });

  await t.test(
    'structured-comment type validator accepts the full enum',
    () => {
      for (const type of STRUCTURED_COMMENT_TYPES) {
        assert.ok(
          isValidStructuredCommentType(type),
          `expected ${type} to be valid`,
        );
      }
      // Nine types added by Story #449 (Tech Spec #443 §1.3) plus
      // epic-plan-state used by the plan-runner. Guard against accidental
      // removal of canonical types.
      for (const required of [
        'code-review',
        'retro',
        'retro-partial',
        'epic-run-state',
        'epic-run-progress',
        'epic-plan-state',
        'parked-follow-ons',
        'dispatch-manifest',
        // Story #566 — phase-timings summary posted by story-close.
        'phase-timings',
      ]) {
        assert.ok(
          STRUCTURED_COMMENT_TYPES.includes(required),
          `enum must include ${required}`,
        );
      }
    },
  );

  await t.test(
    'structured-comment type validator accepts the claim-<id> regex',
    () => {
      for (const type of ['claim-1', 'claim-42', 'claim-987654321']) {
        assert.ok(
          isValidStructuredCommentType(type),
          `${type} should match the claim-<id> pattern`,
        );
      }
      for (const type of [
        'claim-',
        'claim',
        'claim-abc',
        'claim-1.5',
        'claim-1234567890', // 10 digits — exceeds {1,9} bound.
      ]) {
        assert.ok(
          !isValidStructuredCommentType(type),
          `${type} should not match the claim-<id> pattern`,
        );
      }
    },
  );

  await t.test(
    'structured-comment type validator accepts the wave-N-* regex',
    () => {
      for (const type of [
        'wave-0-start',
        'wave-0-end',
        'wave-1-start',
        'wave-12-end',
      ]) {
        assert.ok(
          isValidStructuredCommentType(type),
          `${type} should match ${WAVE_TYPE_PATTERN}`,
        );
      }
      for (const type of [
        'wave--start',
        'wave-1-middle',
        'wave-1',
        'wave-1-',
      ]) {
        assert.ok(
          !isValidStructuredCommentType(type),
          `${type} should not match the wave pattern`,
        );
      }
    },
  );

  await t.test('postStructuredComment rejects unknown types', async () => {
    await assert.rejects(
      () => postStructuredComment(mock, 1, 'not-a-real-type', 'body'),
      /Invalid structured-comment type/,
    );
  });

  await t.test(
    'upsertStructuredComment rejects unknown types before touching the provider',
    async () => {
      const calls = [];
      const guard = {
        async postComment(...args) {
          calls.push(args);
        },
        async getTicketComments() {
          return [];
        },
      };
      await assert.rejects(
        () => upsertStructuredComment(guard, 1, 'bogus', 'body'),
        /Invalid structured-comment type/,
      );
      assert.equal(calls.length, 0, 'provider must not be called on bad type');
    },
  );

  await t.test(
    'assertValidStructuredCommentType error message lists accepted types',
    () => {
      try {
        assertValidStructuredCommentType('nope');
        assert.fail('should have thrown');
      } catch (err) {
        for (const expected of ['retro', 'code-review', 'wave-']) {
          assert.ok(
            err.message.includes(expected),
            `error message should mention ${expected}: ${err.message}`,
          );
        }
      }
    },
  );

  await t.test(
    'cascadeCompletion isolates per-parent failures and returns them',
    async () => {
      // Child 3 is done; feature 2 has two parents where one fails.
      mock.tickets[3].labels = ['agent::done'];
      // `blocks` in this mock = upward parent list (ticket 3's parents).
      mock.deps[3] = { blocks: [2, 99], blockedBy: [] };
      mock.tickets[99] = {
        id: 99,
        labels: ['agent::executing'],
        body: '',
        state: 'open',
      };
      mock.subTickets[99] = [mock.tickets[3]];
      mock.deps[99] = { blocks: [], blockedBy: [] };

      const origGetSub = mock.getSubTickets.bind(mock);
      mock.getSubTickets = async (id) => {
        if (id === 99) throw new Error('boom');
        return origGetSub(id);
      };

      const result = await cascadeCompletion(mock, 3);

      assert.ok(
        result.cascadedTo.length > 0,
        'successful parents should still cascade',
      );
      assert.equal(
        result.failed.length,
        1,
        'failing parent must be captured, not swallowed',
      );
      assert.equal(result.failed[0].parentId, 99);
      assert.match(result.failed[0].error, /boom/);
    },
  );

  await t.test(
    'cascadeCompletion recursively transitions parents up the tree',
    async () => {
      // Manually ensure child 3 is done
      mock.tickets[3].labels = ['agent::done'];

      // Should transition 2 to agent::done and then 1 to agent::done
      await cascadeCompletion(mock, 3);

      // Checks on cascade effects:
      assert.ok(
        mock.tickets[2].labels.includes('agent::done'),
        'Feature (parent) should be marked done',
      );
      assert.strictEqual(
        mock.tickets[2].body.includes('- [x] #3'),
        true,
        'Checkbox for child in parent should be ticked',
      );

      assert.ok(
        mock.tickets[1].labels.includes('agent::done'),
        'Epic (grandparent) should be marked done',
      );
      assert.strictEqual(
        mock.tickets[1].body.includes('- [x] #2'),
        true,
        'Checkbox for feature in epic should be ticked',
      );
    },
  );

  await t.test(
    'cascadeCompletion leaves a parent with mixed open/closed children open (premature-close regression guard)',
    async () => {
      // Build a Feature with two child Stories: one done, one still
      // executing. Closing the done child must NOT cascade-close the
      // Feature because at least one sibling remains open.
      mock.tickets[20] = {
        id: 20,
        labels: ['agent::executing', 'type::feature'],
        body: 'Feature body\n- [ ] #21\n- [ ] #22',
        state: 'open',
      };
      mock.tickets[21] = {
        id: 21,
        labels: ['agent::done', 'type::story'],
        body: 'Story 21 body\n\nparent: #20',
        state: 'open',
      };
      mock.tickets[22] = {
        id: 22,
        labels: ['agent::executing', 'type::story'],
        body: 'Story 22 body\n\nparent: #20',
        state: 'open',
      };

      mock.deps[20] = { blocks: [], blockedBy: [21, 22] };
      mock.deps[21] = { blocks: [20], blockedBy: [] };
      mock.deps[22] = { blocks: [20], blockedBy: [] };

      mock.subTickets[20] = [mock.tickets[21], mock.tickets[22]];
      mock.subTickets[21] = [];
      mock.subTickets[22] = [];

      const result = await cascadeCompletion(mock, 21);

      assert.equal(
        result.cascadedTo.length,
        0,
        'cascade must not advance when the parent has open siblings',
      );
      assert.ok(
        !mock.tickets[20].labels.includes('agent::done'),
        'Feature must remain open while a sibling Story is still executing',
      );
      assert.ok(
        mock.tickets[20].labels.includes('agent::executing'),
        'Feature must retain its prior state label',
      );
      assert.ok(
        mock.tickets[20].body.includes('- [x] #21'),
        'Done child checkbox must still be ticked even when the parent stays open',
      );
      assert.ok(
        mock.tickets[20].body.includes('- [ ] #22'),
        'Open sibling checkbox must remain unchecked',
      );
    },
  );

  await t.test(
    'structuredCommentMarker accepts an optional attribute bag',
    () => {
      assert.equal(
        structuredCommentMarker('wave-run-progress'),
        '<!-- ap:structured-comment type="wave-run-progress" -->',
      );
      assert.equal(
        structuredCommentMarker('wave-run-progress', { wave: 3 }),
        '<!-- ap:structured-comment type="wave-run-progress" wave="3" -->',
      );
      // null/undefined values are dropped (so callers can pass partial objects)
      assert.equal(
        structuredCommentMarker('wave-run-progress', {
          wave: 0,
          extra: null,
        }),
        '<!-- ap:structured-comment type="wave-run-progress" wave="0" -->',
      );
    },
  );

  await t.test(
    'cascadeCompletion re-fetches sibling state with fresh reads (rec #4)',
    async () => {
      // Build a Feature whose only sibling under it shows agent::done in the
      // initial getSubTickets payload but is actually agent::executing when
      // re-read fresh. Without fresh-fetch the cascade would close the
      // Feature; with it the cascade halts.
      const tickets = {
        30: {
          id: 30,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature body\n- [ ] #31\n- [ ] #32',
          state: 'open',
        },
        31: {
          id: 31,
          labels: ['agent::done', 'type::story'],
          body: 'parent: #30',
          state: 'closed',
        },
        // Stale-cache scenario: getSubTickets returns this row with done…
        32: {
          id: 32,
          labels: ['agent::done', 'type::story'],
          body: 'parent: #30',
          state: 'open',
        },
      };
      const fresh = {
        // …but a fresh read returns it as still-executing.
        32: {
          id: 32,
          labels: ['agent::executing', 'type::story'],
          body: 'parent: #30',
          state: 'open',
        },
      };
      const invalidated = [];
      const fakeProvider = {
        async getTicket(id, opts = {}) {
          if (opts.fresh && fresh[id]) return fresh[id];
          return tickets[id];
        },
        async updateTicket() {},
        async postComment() {},
        async getTicketDependencies(id) {
          if (id === 31) return { blocks: [30], blockedBy: [] };
          return { blocks: [], blockedBy: [] };
        },
        async getSubTickets(id) {
          if (id === 30) return [tickets[31], tickets[32]];
          return [];
        },
        invalidateTicket(id) {
          invalidated.push(id);
        },
      };

      const result = await cascadeCompletion(fakeProvider, 31);

      assert.equal(
        result.cascadedTo.length,
        0,
        'cascade must halt when a fresh sibling read shows it still executing',
      );
      assert.ok(
        invalidated.includes(32),
        'sibling cache must be invalidated before the all-done check',
      );
    },
  );

  await t.test(
    'cascadeCompletion auto-closes Feature but not Epic (AC-05 regression)',
    async () => {
      // Build a typed hierarchy: Epic E > Feature F > Story S > Task T.
      // The authoritative contract (docs/architecture.md § Cascade Behavior
      // and the comment in ticketing.js::cascadeCompletion) is:
      //   - Story auto-closes via cascade
      //   - Feature auto-closes via cascade (pinned behavior — Features are
      //     purely hierarchical groupings with no standalone branch/merge)
      //   - Epic does NOT auto-close via cascade (reserved for /epic-deliver)
      // This test pins that contract so a future edit that adds Feature to
      // the exclusion list or drops Epic from it fails loudly.
      mock.tickets[10] = {
        id: 10,
        labels: ['agent::executing', 'type::epic'],
        body: 'Epic body\n- [ ] #11',
        state: 'open',
      };
      mock.tickets[11] = {
        id: 11,
        labels: ['agent::executing', 'type::feature'],
        body: 'Feature body\n\nparent: #10\n- [ ] #12',
        state: 'open',
      };
      mock.tickets[12] = {
        id: 12,
        labels: ['agent::executing', 'type::story'],
        body: 'Story body\n\nparent: #11\n- [ ] #13',
        state: 'open',
      };
      mock.tickets[13] = {
        id: 13,
        labels: ['agent::executing', 'type::task'],
        body: 'Task body\n\nparent: #12',
        state: 'open',
      };

      // `blocks` = upward parent list in this mock.
      mock.deps[10] = { blocks: [], blockedBy: [11] };
      mock.deps[11] = { blocks: [10], blockedBy: [12] };
      mock.deps[12] = { blocks: [11], blockedBy: [13] };
      mock.deps[13] = { blocks: [12], blockedBy: [] };

      mock.subTickets[10] = [mock.tickets[11]];
      mock.subTickets[11] = [mock.tickets[12]];
      mock.subTickets[12] = [mock.tickets[13]];
      mock.subTickets[13] = [];

      // Drive the cascade through the production entry point: transitioning
      // the Task to agent::done must fire cascadeCompletion internally.
      await transitionTicketState(mock, 13, 'agent::done');

      assert.ok(
        mock.tickets[12].labels.includes('agent::done'),
        'Story must auto-close via cascade',
      );
      assert.ok(
        mock.tickets[11].labels.includes('agent::done'),
        'Feature must auto-close via cascade (pinned behavior)',
      );
      assert.ok(
        !mock.tickets[10].labels.includes('agent::done'),
        'Epic must NOT auto-close via cascade — reserved for /epic-deliver',
      );
      assert.ok(
        mock.tickets[10].labels.includes('agent::executing'),
        'Epic must retain its prior state label when cascade stops',
      );

      // Parent-checkbox toggling should still happen up to the Epic —
      // cascade walks upward, ticks the box, then bails on the type::epic
      // exclusion. Verifies the checkbox pass runs before the exclusion.
      assert.ok(
        mock.tickets[10].body.includes('- [x] #11'),
        'Epic checkbox for Feature must be ticked even though Epic stays open',
      );
    },
  );

  await t.test(
    'cascadeCompletion processes multiple parents sequentially in input order (Story #1088)',
    async () => {
      // Child #50 has two parents (#41 and #42). The outer cascade loop
      // must walk them sequentially in the order they appear in the parsed
      // parent list — concurrent processing would let their toggle/transition
      // calls interleave and obscure cascade ordering in logs.
      const order = [];
      const tickets = {
        41: {
          id: 41,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 41\n- [ ] #50',
          state: 'open',
        },
        42: {
          id: 42,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 42\n- [ ] #50',
          state: 'open',
        },
        50: {
          id: 50,
          labels: ['agent::done', 'type::story'],
          body: 'Story 50\nparent: #41\nparent: #42',
          state: 'closed',
        },
      };
      const fakeProvider = {
        async getTicket(id) {
          // Record the read order of the *parent* tickets only — that's
          // the post-toggle, pre-all-done-check read inside the outer loop.
          if (id === 41 || id === 42) order.push(`get:${id}`);
          return tickets[id];
        },
        async updateTicket(id) {
          if (id === 41 || id === 42) order.push(`update:${id}`);
        },
        async postComment() {},
        async getTicketDependencies(id) {
          if (id === 50) return { blocks: [41, 42], blockedBy: [] };
          return { blocks: [], blockedBy: [] };
        },
        async getSubTickets(id) {
          if (id === 41 || id === 42) return [tickets[50]];
          return [];
        },
      };

      await cascadeCompletion(fakeProvider, 50);

      // Sequential semantics: the entire #41 sub-flow (toggle → fresh-read →
      // parent get → updateTicket) must complete before #42 begins. The
      // first `get:42` must therefore appear AFTER the first `update:41`.
      const firstUpdate41 = order.indexOf('update:41');
      const firstGet42 = order.indexOf('get:42');
      assert.ok(
        firstUpdate41 !== -1 && firstGet42 !== -1,
        `expected both parents to be visited; got order=${JSON.stringify(order)}`,
      );
      assert.ok(
        firstUpdate41 < firstGet42,
        `parent #41 must finish before #42 starts (sequential outer loop); got order=${JSON.stringify(order)}`,
      );
    },
  );

  await t.test(
    'cascadeCompletion bounds sibling reads at concurrency=8 (Story #1088)',
    async () => {
      // A parent with 20 siblings under it. The fresh-read fan-out must
      // never have more than 8 reads in flight simultaneously.
      const SIBLING_COUNT = 20;
      const EXPECTED_CAP = 8;

      const siblings = [];
      for (let i = 0; i < SIBLING_COUNT; i++) {
        const id = 200 + i;
        siblings.push({
          id,
          labels: ['agent::done', 'type::task'],
          body: `parent: #100`,
          state: 'closed',
        });
      }
      const parent = {
        id: 100,
        labels: ['agent::executing', 'type::story'],
        body: 'Story 100',
        state: 'open',
      };
      // Trigger ticket: child #200 has just gone done.
      const trigger = siblings[0];

      let inFlight = 0;
      let maxInFlight = 0;
      const fakeProvider = {
        async getTicket(id, opts = {}) {
          if (opts.fresh) {
            inFlight++;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            // Yield twice to give the scheduler a chance to launch more
            // workers if the cap weren't enforced.
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            inFlight--;
            return siblings.find((s) => s.id === id);
          }
          if (id === 100) return parent;
          return siblings.find((s) => s.id === id) ?? trigger;
        },
        async updateTicket() {},
        async postComment() {},
        async getTicketDependencies(id) {
          if (id === trigger.id) return { blocks: [100], blockedBy: [] };
          return { blocks: [], blockedBy: [] };
        },
        async getSubTickets(id) {
          if (id === 100) return siblings;
          return [];
        },
      };

      await cascadeCompletion(fakeProvider, trigger.id);

      assert.ok(
        maxInFlight > 0,
        'fresh-read fan-out should have observed at least one in-flight read',
      );
      assert.ok(
        maxInFlight <= EXPECTED_CAP,
        `sibling reads must be bounded at ${EXPECTED_CAP}; saw maxInFlight=${maxInFlight}`,
      );
    },
  );
});
