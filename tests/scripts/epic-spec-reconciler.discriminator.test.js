/**
 * Tests for `lib/orchestration/epic-spec-reconciler-discriminator.js`
 * (Epic #1182 / Story #1493 / Task #1517).
 *
 * Exercises every predicate branch with at least one positive and one
 * negative case, then pins the destructive-replan regression scenario
 * from the PRD: a Story removed from the spec whose wave-runner branch
 * is already merged must NOT translate into an applied Close operation.
 *
 * The discriminator is pure; tests use plain objects only. No file I/O,
 * no provider calls.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import { diff } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-diff.js';
import {
  assertNoAgentLabels,
  assertPlanLabelAllowList,
  LabelAllowListViolation,
  mayClose,
  mayUpdate,
  STRUCTURAL_LABELS,
} from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-discriminator.js';
import { OP_KINDS } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js';

describe('mayClose — execution-signal gate', () => {
  it('blocks when status is agent::executing (live wave-runner work)', () => {
    const result = mayClose(
      { status: AGENT_LABELS.EXECUTING },
      { explicitDelete: true },
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /^execution-status:agent::executing$/);
  });

  it('blocks when status is agent::review-spec', () => {
    const result = mayClose(
      { status: AGENT_LABELS.REVIEW_SPEC },
      { explicitDelete: true },
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /^execution-status:agent::review-spec$/);
  });

  it('blocks when status is agent::done (final state, not a delete signal)', () => {
    const result = mayClose(
      { status: AGENT_LABELS.DONE },
      { explicitDelete: true },
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /^execution-status:agent::done$/);
  });

  it('blocks when hasMergedPr is true even if no agent status', () => {
    const result = mayClose({ hasMergedPr: true }, { explicitDelete: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'merged-pr-exists');
  });

  it('blocks when openPrCount > 0', () => {
    const result = mayClose({ openPrCount: 1 }, { explicitDelete: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'open-pr-exists');
  });

  it('blocks when explicitDelete is omitted, even on a quiescent Story', () => {
    const result = mayClose({}, {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'explicit-delete-required');
  });

  it('blocks when explicitDelete is false explicitly', () => {
    const result = mayClose({}, { explicitDelete: false });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'explicit-delete-required');
  });

  it('allows close only when every signal is quiescent and explicitDelete=true', () => {
    const result = mayClose(
      { status: undefined, hasMergedPr: false, openPrCount: 0 },
      { explicitDelete: true },
    );
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  it('execution-status check fires before explicit-delete gate (specific reason)', () => {
    const result = mayClose(
      { status: AGENT_LABELS.EXECUTING },
      { explicitDelete: false },
    );
    assert.equal(result.allowed, false);
    // The specific execution blocker wins over the generic gate.
    assert.match(result.reason, /^execution-status:/);
  });

  it('openPrCount=0 does not falsely block (positive boundary)', () => {
    const result = mayClose({ openPrCount: 0 }, { explicitDelete: true });
    assert.equal(result.allowed, true);
  });
});

describe('mayUpdate — structural-field allow-list', () => {
  it('allows every structural field', () => {
    for (const field of [
      'title',
      'body',
      'labels',
      'parent',
      'dependsOn',
      'wave',
    ]) {
      const result = mayUpdate({}, field);
      assert.equal(result.allowed, true, `expected ${field} to be allowed`);
    }
  });

  it('rejects every AGENT_LABELS value', () => {
    for (const label of Object.values(AGENT_LABELS)) {
      const result = mayUpdate({}, label);
      assert.equal(result.allowed, false, `expected ${label} to be rejected`);
      assert.equal(result.reason, `agent-label:${label}`);
    }
  });

  it('rejects non-structural fields with a structured reason', () => {
    const result = mayUpdate({}, 'arbitrary-field');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'non-structural-field:arbitrary-field');
  });

  it('rejects empty / non-string fields with invalid-field', () => {
    assert.equal(mayUpdate({}, '').allowed, false);
    assert.equal(mayUpdate({}, '').reason, 'invalid-field');
    assert.equal(mayUpdate({}, undefined).allowed, false);
    assert.equal(mayUpdate({}, null).reason, 'invalid-field');
  });

  it('uses the imported AGENT_LABELS constant, not a local copy', () => {
    // If the predicate ever diverged from the constants module the
    // sweeping loop above would still pass against a stale local copy.
    // This test pins the indirection: every AGENT_LABELS value rejected
    // here is sourced from label-constants.js at runtime.
    const labels = Object.values(AGENT_LABELS);
    assert.ok(labels.length >= 5, 'AGENT_LABELS should have 5+ entries');
    for (const label of labels) {
      assert.equal(mayUpdate({}, label).allowed, false);
    }
  });
});

describe('STRUCTURAL_LABELS — complement helper', () => {
  it('isStructuralLabel rejects every agent::* label', () => {
    for (const label of Object.values(AGENT_LABELS)) {
      assert.equal(
        STRUCTURAL_LABELS.isStructuralLabel(label),
        false,
        `${label} must not be structural`,
      );
    }
  });

  it('isStructuralLabel accepts type::*, persona::*, context::*, status::*', () => {
    for (const label of [
      'type::story',
      'persona::engineer',
      'context::prd',
      'status::blocked',
      'area::core',
    ]) {
      assert.equal(STRUCTURAL_LABELS.isStructuralLabel(label), true);
    }
  });

  it('partitionLabels splits the input cleanly without aliasing', () => {
    const input = ['type::story', 'agent::executing', 'persona::engineer'];
    const { structural, agent } = STRUCTURAL_LABELS.partitionLabels(input);
    assert.deepEqual(structural, ['type::story', 'persona::engineer']);
    assert.deepEqual(agent, ['agent::executing']);
    // Input array is not mutated.
    assert.deepEqual(input, [
      'type::story',
      'agent::executing',
      'persona::engineer',
    ]);
  });

  it('partitionLabels skips non-string entries defensively', () => {
    const { structural, agent } = STRUCTURAL_LABELS.partitionLabels([
      'type::story',
      null,
      undefined,
      42,
      'agent::done',
    ]);
    assert.deepEqual(structural, ['type::story']);
    assert.deepEqual(agent, ['agent::done']);
  });

  it('AGENT_LABEL_VALUES exposes the deny-list', () => {
    assert.ok(Array.isArray(STRUCTURAL_LABELS.AGENT_LABEL_VALUES));
    for (const label of Object.values(AGENT_LABELS)) {
      assert.ok(STRUCTURAL_LABELS.AGENT_LABEL_VALUES.includes(label));
    }
  });
});

describe('assertNoAgentLabels — diff-time guard', () => {
  it('is a no-op for ops without label payloads', () => {
    assert.doesNotThrow(() =>
      assertNoAgentLabels({ kind: OP_KINDS.CLOSE, slug: 'story-x' }),
    );
    assert.doesNotThrow(() => assertNoAgentLabels(undefined));
    assert.doesNotThrow(() => assertNoAgentLabels(null));
  });

  it('throws LabelAllowListViolation when CreateOp.labels contains agent::*', () => {
    assert.throws(
      () =>
        assertNoAgentLabels({
          kind: OP_KINDS.CREATE,
          slug: 'story-x',
          labels: ['type::story', AGENT_LABELS.EXECUTING],
        }),
      (err) => {
        assert.ok(err instanceof LabelAllowListViolation);
        assert.equal(err.name, 'LabelAllowListViolation');
        assert.equal(err.slug, 'story-x');
        assert.equal(err.field, 'labels');
        assert.deepEqual(err.offendingLabels, [AGENT_LABELS.EXECUTING]);
        return true;
      },
    );
  });

  it('throws when UpdateOp.changes keys are agent::*', () => {
    assert.throws(
      () =>
        assertNoAgentLabels({
          kind: OP_KINDS.UPDATE,
          slug: 'story-x',
          changes: {
            [AGENT_LABELS.EXECUTING]: { before: false, after: true },
          },
        }),
      LabelAllowListViolation,
    );
  });

  it('throws when UpdateOp.changes.labels.after contains an agent::* label', () => {
    assert.throws(
      () =>
        assertNoAgentLabels({
          kind: OP_KINDS.UPDATE,
          slug: 'story-x',
          changes: {
            labels: {
              before: ['type::story'],
              after: ['type::story', AGENT_LABELS.DONE],
            },
          },
        }),
      (err) => {
        assert.ok(err instanceof LabelAllowListViolation);
        assert.deepEqual(err.offendingLabels, [AGENT_LABELS.DONE]);
        return true;
      },
    );
  });

  it('does not throw for clean UpdateOps', () => {
    assert.doesNotThrow(() =>
      assertNoAgentLabels({
        kind: OP_KINDS.UPDATE,
        slug: 'story-x',
        changes: {
          title: { before: 'old', after: 'new' },
          labels: {
            before: ['type::story'],
            after: ['type::story', 'area::core'],
          },
        },
      }),
    );
  });
});

describe('assertPlanLabelAllowList — whole-plan guard', () => {
  it('is a no-op for the empty plan', () => {
    assert.doesNotThrow(() =>
      assertPlanLabelAllowList({
        creates: [],
        updates: [],
        closes: [],
        relinks: [],
      }),
    );
  });

  it('throws on the first offending create', () => {
    assert.throws(
      () =>
        assertPlanLabelAllowList({
          creates: [
            {
              kind: OP_KINDS.CREATE,
              slug: 'story-x',
              entity: 'story',
              labels: [AGENT_LABELS.BLOCKED],
            },
          ],
          updates: [],
          closes: [],
          relinks: [],
        }),
      LabelAllowListViolation,
    );
  });

  it('throws on the first offending update', () => {
    assert.throws(
      () =>
        assertPlanLabelAllowList({
          creates: [],
          updates: [
            {
              kind: OP_KINDS.UPDATE,
              slug: 'story-x',
              entity: 'story',
              issueNumber: 1,
              changes: {
                [AGENT_LABELS.EXECUTING]: { before: false, after: true },
              },
            },
          ],
          closes: [],
          relinks: [],
        }),
      LabelAllowListViolation,
    );
  });
});

describe('diff engine — wires the diff-time assertion', () => {
  it('throws synchronously when a spec carries an agent::* label on a story', () => {
    // Construct a minimal create-only spec where the story's structural
    // labels accidentally include an agent::* entry. The diff engine
    // must reject the plan at construction time, not let it through.
    const spec = {
      epic: { id: 9999, title: 'Epic', labels: ['type::epic'] },
      features: [
        {
          slug: 'feat',
          title: 'Feat',
          labels: ['type::feature'],
          stories: [
            {
              slug: 'story-leak',
              title: 'Leaky',
              wave: 0,
              labels: ['type::story', AGENT_LABELS.EXECUTING],
            },
          ],
        },
      ],
    };
    const state = { epicId: 9999, mapping: {} };
    const ghState = {};
    assert.throws(
      () => diff({ spec, state, ghState }),
      LabelAllowListViolation,
    );
  });

  it('throws when an update would write agent::* into labels.after', () => {
    // Spec keeps the agent::* label on a mapped Story → the diff engine
    // sees a labels drift and emits an Update whose `after` payload
    // carries the smuggled agent::* label. The assertion catches it.
    const spec = {
      epic: { id: 9999, title: 'Epic', labels: ['type::epic'] },
      features: [
        {
          slug: 'feat',
          title: 'Feat',
          labels: ['type::feature'],
          stories: [
            {
              slug: 'story-mapped',
              title: 'Mapped',
              wave: 0,
              labels: ['type::story', AGENT_LABELS.DONE],
            },
          ],
        },
      ],
    };
    const state = {
      epicId: 9999,
      mapping: {
        epic: { issueNumber: 9999, entity: 'epic', parentSlug: null },
        feat: { issueNumber: 100, entity: 'feature', parentSlug: 'epic' },
        'story-mapped': {
          issueNumber: 101,
          entity: 'story',
          parentSlug: 'feat',
          dependsOn: [],
          wave: 0,
        },
      },
    };
    const ghState = {
      9999: { title: 'Epic', labels: ['type::epic'], state: 'open' },
      100: { title: 'Feat', labels: ['type::feature'], state: 'open' },
      101: {
        title: 'Mapped',
        labels: ['type::story'],
        state: 'open',
      },
    };
    assert.throws(
      () => diff({ spec, state, ghState }),
      LabelAllowListViolation,
    );
  });
});

describe('regression — destructive replan: merged Story dropped from spec', () => {
  // The Tech Spec's destructive-replan scenario: an operator edits
  // epic.yaml to remove a Story whose branch is already merged. The
  // structural diff naturally emits a Close op (the slug vanished from
  // the spec) — but the apply pipeline MUST consult `mayClose` and
  // refuse to execute it. This test pins that contract end-to-end:
  //
  //   1. `diff()` emits exactly one CloseOp for the dropped Story.
  //   2. `mayClose` returns allowed=false because hasMergedPr=true.
  //   3. Even when explicitDelete=true is passed, the merged-pr signal
  //      wins — the reason code names the blocker so the apply layer
  //      can route a recovery prompt to the operator.

  it('emits a Close op for the dropped Story (diff is structural)', () => {
    const spec = {
      epic: { id: 9003, title: 'Epic After Replan', labels: ['type::epic'] },
      features: [
        {
          slug: 'feat-alpha',
          title: 'Alpha',
          labels: ['type::feature'],
          stories: [],
        },
      ],
    };
    const state = {
      epicId: 9003,
      mapping: {
        epic: { issueNumber: 9003, entity: 'epic', parentSlug: null },
        'feat-alpha': {
          issueNumber: 200,
          entity: 'feature',
          parentSlug: 'epic',
        },
        'story-merged': {
          issueNumber: 201,
          entity: 'story',
          parentSlug: 'feat-alpha',
          dependsOn: [],
          wave: 0,
          title: 'Already-Merged Story',
        },
      },
    };
    const ghState = {
      9003: {
        title: 'Epic After Replan',
        labels: ['type::epic'],
        state: 'open',
      },
      200: { title: 'Alpha', labels: ['type::feature'], state: 'open' },
      // 201 is closed and PR has merged — wave-runner moved on.
      201: {
        title: 'Already-Merged Story',
        labels: ['type::story', AGENT_LABELS.DONE],
        state: 'closed',
      },
    };
    const plan = diff({ spec, state, ghState });
    assert.equal(plan.closes.length, 1);
    assert.equal(plan.closes[0].slug, 'story-merged');
    assert.equal(plan.closes[0].issueNumber, 201);
  });

  it('mayClose REFUSES the dropped-merged Story even with explicitDelete', () => {
    const story = {
      status: AGENT_LABELS.DONE,
      hasMergedPr: true,
      openPrCount: 0,
    };
    const result = mayClose(story, { explicitDelete: true });
    assert.equal(result.allowed, false);
    // The most specific blocker fires first (execution-status), but the
    // applied gate must remain blocked regardless of which signal won.
    assert.ok(
      result.reason === `execution-status:${AGENT_LABELS.DONE}` ||
        result.reason === 'merged-pr-exists',
      `expected execution or merged-pr blocker, got ${result.reason}`,
    );
  });

  it('mayClose still refuses when only hasMergedPr is set (no agent status)', () => {
    // The wave-runner may rewrite agent::done back to absent (e.g.,
    // post-archival), but the merged-PR signal alone must keep the
    // gate closed.
    const result = mayClose({ hasMergedPr: true }, { explicitDelete: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'merged-pr-exists');
  });

  it('a quiescent never-built Story may still close (positive control)', () => {
    // Without this test the regression case alone could pass against a
    // mayClose that just returns allowed=false unconditionally.
    const result = mayClose(
      { hasMergedPr: false, openPrCount: 0 },
      { explicitDelete: true },
    );
    assert.equal(result.allowed, true);
  });
});
