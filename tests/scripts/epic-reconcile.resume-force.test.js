/**
 * tests/scripts/epic-reconcile.resume-force.test.js — integration tests
 * for the Story #3905 repairs to `--force` re-plan and `--resume`
 * idempotency.
 *
 * Two failure modes are covered end to end against the **real** diff
 * engine (no diff stub):
 *
 *   1. `--force` re-plan with a changed ticket set. The persist phase
 *      threads `--force` into `spawnReconcilerApply` as
 *      `explicitDelete`, so the reconciler is invoked with
 *      `--explicit-delete` and a plan carrying close ops applies (exit 0)
 *      instead of hard-exiting 2 — closing the dropped slug and creating
 *      the new one.
 *
 *   2. `--resume` with a missing/empty `state.json` but open children
 *      present. `reseedMappingFromGh` recovers the slug→issue map from
 *      live GH state by title, so the diff yields Updates/no-ops for the
 *      existing children instead of Creates — the tree is never
 *      duplicated.
 *
 * The reconciler exposes `runReconcile(args, deps)` and the reseed/spawn
 * helpers specifically so these tests drive the real diff + reseed
 * without touching the network, the file system, or a real TTY.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXIT_CODES,
  reseedMappingFromGh,
  runReconcile,
} from '../../.agents/scripts/epic-reconcile.js';
import { spawnReconcilerApply } from '../../.agents/scripts/lib/orchestration/epic-plan-decompose/phases/reconcile-spawn.js';
import { diff as realDiff } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-diff.js';

const EPIC_ID = 3905;

/**
 * A spec with two stories. The titles are deliberately the ones that
 * will appear on the live GH issues so the reseed pass can match by
 * title.
 */
function specWithStories({ storyTwoSlug = 'story-two', storyTwoTitle } = {}) {
  return {
    epic: { id: EPIC_ID, title: 'Resume/Force Epic' },
    stories: [
      { slug: 'story-one', title: 'Story One', wave: 1 },
      {
        slug: storyTwoSlug,
        title: storyTwoTitle ?? 'Story Two',
        wave: 1,
      },
    ],
  };
}

/**
 * Build a runReconcile deps bag wired to the REAL diff engine and a
 * capture-only apply spy. `loadState` returns whatever `state` is passed
 * (the missing-state.json case passes an empty mapping). `fetchGhState`
 * returns the supplied live-GH observation.
 */
function buildDeps({ spec, state, ghState, applySpy }) {
  const stdout = [];
  const stderr = [];
  const deps = {
    provider: { __stub: true },
    loadSpec: () => spec,
    loadState: () => state,
    fetchGhState: () => Promise.resolve(ghState),
    diff: realDiff,
    apply: (plan) => {
      applySpy.plan = plan;
      applySpy.calls += 1;
      return Promise.resolve({
        dryRun: false,
        created: [],
        updated: [],
        closed: [],
        relinked: [],
        slugToIssue: {},
      });
    },
    isTty: () => false,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return { deps, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Story #3905 — `--force` threads `--explicit-delete`
// ---------------------------------------------------------------------------

describe('spawnReconcilerApply — Story #3905 explicit-delete threading', () => {
  it('omits --explicit-delete when explicitDelete is false', () => {
    let captured;
    spawnReconcilerApply({
      spawnSync: (_cmd, argv) => {
        captured = argv;
        return { status: 0, stdout: '', stderr: '' };
      },
      reconcileCli: '/x/epic-reconcile.js',
      epicId: EPIC_ID,
      cwd: '/tmp',
      explicitDelete: false,
    });
    assert.ok(captured.includes('--apply'));
    assert.ok(captured.includes('--yes'));
    assert.ok(!captured.includes('--explicit-delete'));
  });

  it('appends --explicit-delete when explicitDelete is true (--force)', () => {
    let captured;
    spawnReconcilerApply({
      spawnSync: (_cmd, argv) => {
        captured = argv;
        return { status: 0, stdout: '', stderr: '' };
      },
      reconcileCli: '/x/epic-reconcile.js',
      epicId: EPIC_ID,
      cwd: '/tmp',
      explicitDelete: true,
    });
    assert.ok(captured.includes('--apply'));
    assert.ok(captured.includes('--yes'));
    assert.ok(
      captured.includes('--explicit-delete'),
      'force re-plan must pass --explicit-delete so close ops apply',
    );
  });
});

describe('runReconcile — Story #3905 changed-slug force re-plan', () => {
  it('with --explicit-delete: closes the dropped slug and creates the new one (exit 0)', async () => {
    // State maps the OLD tree (story-two). The new spec drops story-two
    // and introduces story-three — a changed ticket set, the classic
    // --force re-plan shape.
    const state = {
      epicId: EPIC_ID,
      mapping: {
        epic: { issueNumber: EPIC_ID, entity: 'epic', parentSlug: null },
        'story-one': {
          issueNumber: 101,
          entity: 'story',
          parentSlug: 'epic',
        },
        'story-two': {
          issueNumber: 102,
          entity: 'story',
          parentSlug: 'epic',
        },
      },
    };
    const spec = {
      epic: { id: EPIC_ID, title: 'Resume/Force Epic' },
      stories: [
        { slug: 'story-one', title: 'Story One', wave: 1 },
        { slug: 'story-three', title: 'Story Three', wave: 1 },
      ],
    };
    const ghState = {
      [EPIC_ID]: { title: 'Resume/Force Epic', state: 'open' },
      101: { title: 'Story One', state: 'open' },
      102: { title: 'Story Two', state: 'open' },
    };
    const applySpy = { calls: 0, plan: null };
    const { deps } = buildDeps({ spec, state, ghState, applySpy });

    const { exitCode } = await runReconcile(
      {
        epicId: EPIC_ID,
        dryRun: false,
        apply: true,
        explicitDelete: true,
        yes: true,
      },
      deps,
    );

    assert.equal(
      exitCode,
      EXIT_CODES.OK,
      'force re-plan with --explicit-delete must apply, not exit 2',
    );
    assert.equal(applySpy.calls, 1, 'apply ran exactly once');
    const plan = applySpy.plan;
    // story-two dropped → one close op for #102.
    assert.equal(plan.closes.length, 1);
    assert.equal(plan.closes[0].issueNumber, 102);
    // story-three is new → one create op.
    assert.ok(plan.creates.some((c) => c.slug === 'story-three'));
  });

  it('WITHOUT --explicit-delete: a changed-slug plan hard-exits 2 (regression guard)', async () => {
    const state = {
      epicId: EPIC_ID,
      mapping: {
        epic: { issueNumber: EPIC_ID, entity: 'epic', parentSlug: null },
        'story-two': {
          issueNumber: 102,
          entity: 'story',
          parentSlug: 'epic',
        },
      },
    };
    const spec = {
      epic: { id: EPIC_ID, title: 'Resume/Force Epic' },
      stories: [{ slug: 'story-three', title: 'Story Three', wave: 1 }],
    };
    const ghState = {
      [EPIC_ID]: { title: 'Resume/Force Epic', state: 'open' },
      102: { title: 'Story Two', state: 'open' },
    };
    const applySpy = { calls: 0, plan: null };
    const { deps } = buildDeps({ spec, state, ghState, applySpy });

    const { exitCode } = await runReconcile(
      {
        epicId: EPIC_ID,
        dryRun: false,
        apply: true,
        explicitDelete: false,
        yes: true,
      },
      deps,
    );

    assert.equal(exitCode, EXIT_CODES.EXPLICIT_DELETE_REQUIRED);
    assert.equal(applySpy.calls, 0, 'apply must not run when close ops gated');
  });
});

// ---------------------------------------------------------------------------
// Story #3905 — `--resume` with missing/empty state.json does not duplicate
// ---------------------------------------------------------------------------

describe('reseedMappingFromGh — Story #3905 pure recovery', () => {
  it('recovers slugs from open GH issues by title; leaves missing ones unmapped', () => {
    const spec = specWithStories();
    const emptyState = { epicId: EPIC_ID, mapping: {} };
    const ghState = {
      [EPIC_ID]: { title: 'Resume/Force Epic', state: 'open' },
      101: { title: 'Story One', state: 'open' },
      // Story Two is genuinely missing on GH (partial persist) — no entry.
    };

    const { state, reseeded } = reseedMappingFromGh(emptyState, spec, ghState);

    assert.equal(state.mapping.epic.issueNumber, EPIC_ID);
    assert.equal(state.mapping['story-one'].issueNumber, 101);
    assert.ok(
      !('story-two' in state.mapping),
      'a slug with no matching open GH issue stays unmapped (still created)',
    );
    assert.equal(reseeded.length, 2); // epic, story-one
  });

  it('never re-binds a slug to a closed GH issue', () => {
    const spec = specWithStories();
    const emptyState = { epicId: EPIC_ID, mapping: {} };
    const ghState = {
      [EPIC_ID]: { title: 'Resume/Force Epic', state: 'open' },
      101: { title: 'Story One', state: 'closed' }, // tombstoned
    };

    const { state } = reseedMappingFromGh(emptyState, spec, ghState);
    assert.ok(
      !('story-one' in state.mapping),
      'closed issues must not be reseeded',
    );
  });

  it('does not re-bind an issue number already claimed by the mapping', () => {
    const spec = specWithStories();
    // story-two already mapped to #100; an open GH issue #100 also titled
    // "Story One" — the reseed must not double-bind it to story-one even if
    // titles collided. Use a title collision to prove the claim guard.
    const state = {
      epicId: EPIC_ID,
      mapping: {
        'story-two': {
          issueNumber: 100,
          entity: 'story',
          parentSlug: 'epic',
        },
      },
    };
    const ghState = {
      100: { title: 'Story One', state: 'open' },
    };
    const { state: out, reseeded } = reseedMappingFromGh(state, spec, ghState);
    assert.ok(
      !('story-one' in out.mapping),
      'a claimed issue number must not be reseeded onto a second slug',
    );
    assert.equal(reseeded.length, 0);
  });
});

describe('runReconcile — Story #3905 --resume with deleted state.json', () => {
  it('does not duplicate existing children: matched slugs diff as no-ops, not Creates', async () => {
    // The exact --resume recovery scenario: state.json is gone (empty
    // mapping), but the full tree already exists open on GH. Without the
    // reseed pass the diff would emit a Create for every slug, duplicating
    // the tree. With it, every slug maps to its existing issue and diffs
    // as a no-op.
    const spec = specWithStories();
    const emptyState = { epicId: EPIC_ID, mapping: {} };
    const ghState = {
      [EPIC_ID]: {
        title: 'Resume/Force Epic',
        state: 'open',
        body: '',
        labels: [],
      },
      100: { title: 'Feature A', state: 'open', body: '', labels: [] },
      101: { title: 'Story One', state: 'open', body: '', labels: [] },
      102: { title: 'Story Two', state: 'open', body: '', labels: [] },
    };
    const applySpy = { calls: 0, plan: null };
    const { deps } = buildDeps({
      spec,
      state: emptyState,
      ghState,
      applySpy,
    });

    const { exitCode } = await runReconcile(
      {
        epicId: EPIC_ID,
        dryRun: false,
        apply: true,
        explicitDelete: false,
        yes: true,
      },
      deps,
    );

    assert.equal(exitCode, EXIT_CODES.OK);
    // With every slug reseeded, the diff is fully empty, so the reconciler
    // short-circuits before apply (`isEmptyPlan` → exit 0). That is the
    // strongest possible no-duplication outcome: applySpy never ran.
    assert.equal(
      applySpy.calls,
      0,
      'an all-matched resume yields an empty plan; apply must not run',
    );
    // If apply HAD run, it must carry zero creates and zero closes. Guard
    // against a future change that always applies.
    if (applySpy.plan) {
      const createdSlugs = applySpy.plan.creates.map((c) => c.slug);
      assert.deepEqual(
        createdSlugs,
        [],
        `--resume must not recreate existing children; got creates: ${createdSlugs.join(', ')}`,
      );
      assert.equal(applySpy.plan.closes.length, 0);
    }
  });

  it('still creates a genuinely-missing child (partial persist)', async () => {
    const spec = specWithStories();
    const emptyState = { epicId: EPIC_ID, mapping: {} };
    // story-two never got created (the run aborted mid-persist).
    const ghState = {
      [EPIC_ID]: {
        title: 'Resume/Force Epic',
        state: 'open',
        body: '',
        labels: [],
      },
      100: { title: 'Feature A', state: 'open', body: '', labels: [] },
      101: { title: 'Story One', state: 'open', body: '', labels: [] },
    };
    const applySpy = { calls: 0, plan: null };
    const { deps } = buildDeps({
      spec,
      state: emptyState,
      ghState,
      applySpy,
    });

    const { exitCode } = await runReconcile(
      {
        epicId: EPIC_ID,
        dryRun: false,
        apply: true,
        explicitDelete: false,
        yes: true,
      },
      deps,
    );

    assert.equal(exitCode, EXIT_CODES.OK);
    const createdSlugs = applySpy.plan.creates.map((c) => c.slug);
    assert.deepEqual(
      createdSlugs,
      ['story-two'],
      'only the missing child should be created on resume',
    );
  });
});
